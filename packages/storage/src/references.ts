import type { S3Client } from "bun";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { MAX_REFERENCE_BYTES, referenceLocalKey, referenceObjectKey, validateReference, type ReferenceAsset } from "../../planner/src/references";

const MAX_UPLOAD_BYTES = 10 * 1024 ** 2;
const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function referenceBody(request: Request): Promise<Buffer> {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
  if (Number(request.headers.get("content-length")) > MAX_UPLOAD_BYTES) throw new Error("A reference image must be at most 10 MiB.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Choose a PNG or JPEG reference image.");
  const parts: Uint8Array[] = []; let total = 0;
  const abort = () => {void reader.cancel().catch(() => {});};
  signal.addEventListener("abort", abort, {once:true});
  try {
    for (;;) {
      const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_UPLOAD_BYTES) throw new Error("A reference image must be at most 10 MiB.");
      parts.push(next.value);
    }
  } finally {signal.removeEventListener("abort",abort); await reader.cancel().catch(() => {}); reader.releaseLock();}
  return Buffer.concat(parts);
}
function dimensions(bytes: Buffer): [number,number,string] {
  if (bytes.length >= 24 && bytes.subarray(0,8).equals(PNG) && bytes.toString("ascii",12,16) === "IHDR")
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20), "png"];
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let cursor = 2;
    while (cursor + 4 <= bytes.length) {
      if (bytes[cursor++] !== 255) break;
      while (bytes[cursor] === 255) cursor++;
      const marker = bytes[cursor++];
      if (marker === 217 || marker === 218 || marker === undefined) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (cursor + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(cursor);
      if (length < 2 || cursor + length > bytes.length) break;
      if ([192,193,194].includes(marker) && length >= 8)
        return [bytes.readUInt16BE(cursor + 5), bytes.readUInt16BE(cursor + 3), "jpeg"];
      cursor += length;
    }
  }
  throw new Error("Choose a valid PNG or JPEG reference image.");
}
/** Decode a bounded raster and discard metadata; no URL or vector input reaches a decoder. */
export async function normalizeReference(bytes: Buffer, projectId: string, now = Date.now(), signal = new AbortController().signal,target?:"motion-landscape"|"motion-portrait"): Promise<{asset: ReferenceAsset; data: Buffer}> {
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new Error("A reference image must be at most 10 MiB.");
  const [width,height,format] = dimensions(bytes);
  if (!width || !height || width > 4096 || height > 4096) throw new Error("Reference images must be no larger than 4096 by 4096 pixels.");
  const scratch = mkdtempSync(join(tmpdir(),"hv-reference-"));
  const filter=target?`scale=${target==="motion-landscape"?832:480}:${target==="motion-landscape"?480:832}:force_original_aspect_ratio=decrease,pad=${target==="motion-landscape"?832:480}:${target==="motion-landscape"?480:832}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=rgb24`:"scale=w=min(1024\\,iw):h=min(1024\\,ih):force_original_aspect_ratio=decrease,format=rgb24";
  try {
    signal.throwIfAborted();
    writeFileSync(join(scratch,"source." + format), bytes, {mode:0o600});
    const child = Bun.spawn(["ffmpeg","-y","-v","error","-max_alloc","67108864","-protocol_whitelist","file,pipe",
      "-i","source." + format,"-vf",filter,
      "-frames:v","1","-threads","1","-c:v","png","-fflags","+bitexact","-flags:v","+bitexact","-map_metadata","-1","reference.png"],
      {cwd:scratch,stdout:"ignore",stderr:"pipe"});
    const abort = () => child.kill(); const timer = setTimeout(abort,20_000);
    signal.addEventListener("abort",abort,{once:true});
    try {
      if (signal.aborted) abort();
      const [code] = await Promise.all([child.exited,new Response(child.stderr).text()]);
      signal.throwIfAborted();
      if (code !== 0) throw new Error("The reference image could not be decoded. Export it as a PNG or JPEG and try again.");
    } finally {clearTimeout(timer);signal.removeEventListener("abort",abort);}
    const data = readFileSync(join(scratch,"reference.png"));
    const [canonicalWidth,canonicalHeight] = dimensions(data);
    const timestamp = new Date(now).toISOString();
    const asset = validateReference({schema:"hv-reference/1",id:crypto.randomUUID(),projectId,sha256:sha(data),originalSha256:sha(bytes),
      bytes:data.length,width:canonicalWidth,height:canonicalHeight,contentType:"image/png",createdAt:timestamp,attestedAt:timestamp},projectId);
    return {asset,data};
  } finally {rmSync(scratch,{recursive:true,force:true});}
}
export class ReferenceBlobStore {
  private root: string;
  constructor(root: string, private client?: S3Client) {
    mkdirSync(root,{recursive:true}); this.root = realpathSync(root);
  }
  private local(asset: ReferenceAsset): string {
    const path = resolve(this.root,referenceLocalKey(asset));
    if (!path.startsWith(this.root + sep)) throw new Error("Reference escaped its cache.");
    return path;
  }
  private verify(asset: ReferenceAsset, data: Buffer): void {
    validateReference(asset, asset.projectId);
    if (data.length !== asset.bytes || data.length > MAX_REFERENCE_BYTES || sha(data) !== asset.sha256)
      throw new Error("Character reference checksum mismatch.");
    const [width,height,format] = dimensions(data);
    if (format !== "png" || width !== asset.width || height !== asset.height) throw new Error("Character reference dimensions changed.");
  }
  async put(asset: ReferenceAsset, data: Buffer): Promise<void> {
    this.verify(asset,data);
    if (this.client) {
      const object = this.client.file(referenceObjectKey(asset));
      await object.write(data,{type:"image/png"});
      this.verify(asset, await this.readRemote(asset));
    } else {
      const path = this.local(asset);
      mkdirSync(dirname(path),{recursive:true});
      if (!realpathSync(dirname(path)).startsWith(this.root + sep)) throw new Error("Reference directory escaped its cache.");
      if (existsSync(path)) {await this.read(asset);return;}
      const temporary = path + "." + crypto.randomUUID() + ".pending";
      writeFileSync(temporary,data,{mode:0o600,flag:"wx"});
      try {renameSync(temporary,path);} finally {if (existsSync(temporary)) rmSync(temporary);}
    }
  }
  private async readRemote(asset: ReferenceAsset): Promise<Buffer> {
    const reader = this.client!.file(referenceObjectKey(asset)).stream().getReader(), parts: Uint8Array[] = [];
    const signal = AbortSignal.timeout(30_000), abort = () => {void reader.cancel().catch(() => {});};
    signal.addEventListener("abort",abort,{once:true}); let total = 0;
    try {
      for (;;) {
        const next = await reader.read();signal.throwIfAborted();if (next.done) break;
        total += next.value.length;if (total > asset.bytes) throw new Error("Character reference exceeded its indexed size.");
        parts.push(next.value);
      }
    } finally {signal.removeEventListener("abort",abort);await reader.cancel().catch(() => {});reader.releaseLock();}
    return Buffer.concat(parts);
  }
  async read(asset: ReferenceAsset): Promise<Buffer> {
    validateReference(asset,asset.projectId);
    let data: Buffer;
    if (this.client) data = await this.readRemote(asset);
    else {
      const path = this.local(asset), stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== asset.bytes || !realpathSync(path).startsWith(this.root + sep))
        throw new Error("Character reference is not a valid local file.");
      data = readFileSync(path);
    }
    this.verify(asset,data);return data;
  }
}
