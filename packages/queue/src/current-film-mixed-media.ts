import {lstatSync,realpathSync} from "node:fs";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {contentHash} from "../../generator/src/capabilities";
import {withEditSourceAccess} from "../../generator/src/edit-source-media";
import {verifyCurrentFilmOriginsMedia} from "../../generator/src/current-film-origins-media";
import {currentFilmMixedRecordedFiles,validateCurrentFilmMixedJob,type CurrentFilmMixedJob} from "../../planner/src/current-film-mixed-job-context";
import {advanceCurrentFilmMixedCheckpoint} from "../../planner/src/current-film-mixed-context";
import {parseCurrentFilmProbe} from "../../planner/src/current-film-clock";
import {verifyCurrentFilmClip} from "./current-film-media";
import {validateCurrentFilmMixedProvenance} from "../../assembler/src/current-film-mixed";
import {verifyCurrentFilmProofMedia} from "../../generator/src/current-film-proof-media";

function owned(root:string,key:string,bytes?:number):string {
  if(!/^[A-Za-z0-9._/-]+$/.test(key)||key.split("/").some(part=>!part||part==="."||part===".."))throw new Error("Mixed current-film media escaped its owner.");
  let path=root;
  for(const part of key.split("/")){path=join(path,part);if(lstatSync(path).isSymbolicLink()||realpathSync(path)!==path)throw new Error("Mixed current-film verification refuses linked media components.");}
  const stat=lstatSync(path);if(!stat.isFile()||bytes!==undefined&&stat.size!==bytes)throw new Error("Mixed current-film media is missing or changed.");return path;
}
/** Per-file limits have already been validated by the origin/record/output
 * contracts. Final pictures may exceed the native audio helper's 8 GiB limit. */
async function digest(path:string,limit:number,signal:AbortSignal):Promise<{sha256:string;bytes:number}> {
  const hash=createHash("sha256");let bytes=0;
  for await(const chunk of Bun.file(path).stream()){signal.throwIfAborted();bytes+=chunk.byteLength;
    if(bytes>limit)throw new Error("The mixed current-film media exceeds its exact recorded size.");hash.update(chunk);}
  signal.throwIfAborted();return {sha256:hash.digest("hex"),bytes};
}
async function measuredProbe(path:string,signal:AbortSignal):Promise<ReturnType<typeof parseCurrentFilmProbe>> {
  signal.throwIfAborted();const child=Bun.spawn(["ffprobe","-v","error","-protocol_whitelist","file,pipe","-count_frames","-show_streams","-show_format","-of","json",path],{stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  const abort=()=>child.kill();signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
  try{const [code,out]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    signal.throwIfAborted();if(code!==0||out.length>1024*1024)throw new Error("The mixed current-film output could not be independently probed.");return parseCurrentFilmProbe(JSON.parse(out));
  }finally{signal.removeEventListener("abort",abort);}
}
async function deliveryPaths(job:CurrentFilmMixedJob,root:string,signal:AbortSignal):Promise<void> {
  if(!job.output)return;
  const key=job.output.hlsPlaylistPath,path=owned(root,key),size=lstatSync(path).size;
  if(size<1||size>1024*1024||!key.endsWith("/index.m3u8"))throw new Error("Retain the bounded mixed current-film delivery playlist.");
  const playlist=await Bun.file(path).text();signal.throwIfAborted();const lines=playlist.split(/\r?\n/).map(line=>line.trim()),segments=lines.filter(line=>line&&!line.startsWith("#"));
  if(lines[0]!=="#EXTM3U"||!lines.includes("#EXT-X-ENDLIST")||!segments.length||segments.length>10000||new Set(segments).size!==segments.length
    ||segments.some(name=>!/^segment-\d{3,5}\.ts$/.test(name))||lines.some(line=>line.includes("URI=")||line.startsWith("#EXT-X-KEY")))throw new Error("The mixed current-film delivery playlist lost its owned segments.");
  const prefix=key.slice(0,-"index.m3u8".length);
  for(const segment of segments){signal.throwIfAborted();if(lstatSync(owned(root,prefix+segment)).size<1)throw new Error("The mixed current-film delivery segment is empty.");}
}

/** Validate a prepared prefix or completed output against this root's owned
 * bytes. No original/carrier directory, local clip manifest or synthetic cost
 * receipt is needed. The caller supplies fresh access and holds durable custody;
 * successful historical media checks alone cannot authorize a job mutation.
 * HLS is checked for complete bounded owned paths here; exact playlist/segment
 * digests must additionally match the held delivery artifact index. */
export async function verifyCurrentFilmMixedMedia(raw:CurrentFilmMixedJob,artifactRoot:string,access:()=>Promise<void>,signal?:AbortSignal):Promise<void> {
  signal?.throwIfAborted();validateCurrentFilmMixedJob(raw);const job=structuredClone(raw),plan=job.currentFilm,files=currentFilmMixedRecordedFiles(job);
  const root=realpathSync(artifactRoot);if(lstatSync(artifactRoot).isSymbolicLink()||!lstatSync(root).isDirectory())throw new Error("Use a real mixed current-film media workspace.");
  await withEditSourceAccess(access,signal,async active=>{
    await deliveryPaths(job,root,active);
    if(job.currentFilmProof)await verifyCurrentFilmProofMedia(job.currentFilmProof.specification,plan,job.id,root,access,active);
    // Every direct original, including unselected roles and its final provenance,
    // remains independently restorable inside the target's complete namespace.
    if(job.currentFilmOrigins)await verifyCurrentFilmOriginsMedia(job.currentFilmOrigins,plan,job.id,root,access,active);
    for(const file of files){active.throwIfAborted();await access();const actual=await digest(owned(root,file.path,file.bytes),file.bytes,active);
      if(actual.sha256!==file.sha256||actual.bytes!==file.bytes)throw new Error("The mixed current-film owned inventory failed independent checksum verification.");}
    if(job.currentFilmCheckpoint){
      const checkpoint=advanceCurrentFilmMixedCheckpoint(job,job.currentFilmCheckpoint,job.checkpointShots,job.checkpointFrame);
      const originalCopies=new Map(job.currentFilmOrigins!.origins.map(origin=>[origin.originId,new Map(origin.copies.map(copy=>[copy.original.path,copy]))]));
      for(const row of checkpoint.rows){active.throwIfAborted();await access();
        if(row.kind==="reused"){
          // The complete originals above passed native/media verification, and
          // every owned selected copy passed its exact digest check. Adoption is
          // byte-preserving: prove this correspondence rather than reconstructing
          // and probing the same original again for every selected slot.
          const origin=originalCopies.get(row.adoption.originId);
          for(const copy of row.adoption.copies){
            const verified=origin?.get(copy.original.path);
            if(!verified||verified.original.sha256!==copy.original.sha256||verified.original.bytes!==copy.original.bytes
              ||verified.owned.sha256!==copy.owned.sha256||verified.owned.bytes!==copy.owned.bytes)
              throw new Error("The adopted mixed current-film bytes differ from their independently verified original.");
          }
          continue;
        }
        const record=row.record,roles=record.files;
        await verifyCurrentFilmClip(job,plan.materialization.slots[row.ordinal]!,{...record.clip,renderRecord:record,path:owned(root,roles.video.path,roles.video.bytes),
          ...(roles.audio?{audioPath:owned(root,roles.audio.path,roles.audio.bytes)}:{}),...(roles.poster?{posterPath:owned(root,roles.poster.path,roles.poster.bytes)}:{}),
          ...(roles.sourcePoster?{sourcePosterPath:owned(root,roles.sourcePoster.path,roles.sourcePoster.bytes)}:{})},root,active);
      }
    }
    if(job.output){
      const output=job.output,clock=output.currentFilm.assembly,probe=await measuredProbe(owned(root,output.mp4Path,clock.video.bytes),active);
      if(contentHash(probe)!==contentHash(clock.probe))throw new Error("The restored mixed current-film clock differs from actual decoded output.");
      const manifest=owned(root,output.manifestPath);if(lstatSync(manifest).size>16*1024**2)throw new Error("The mixed current-film public provenance exceeds its capacity.");
      const rawManifest=JSON.parse(await Bun.file(manifest).text());active.throwIfAborted();
      const provenance=validateCurrentFilmMixedProvenance(rawManifest,job,job.currentFilmCheckpoint!,clock,output.currentFilm.degradedShots);
      // HV-031-15: a signed record and a sidecar come together or not at all, and the sidecar's
      // bytes are the ones the record names. Its signature is a C2PA validator's to check.
      const sidecar="sidecar" in provenance.credentials?provenance.credentials.sidecar:undefined;
      if(Boolean(sidecar)!==Boolean(output.c2paPath))throw new Error("The mixed current-film C2PA sidecar and its provenance record disagree about whether the export is signed.");
      if(sidecar){const path=owned(root,output.c2paPath!);if(lstatSync(path).size>16*1024**2)throw new Error("The mixed current-film C2PA sidecar exceeds its capacity.");
        if(createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex")!==sidecar.sha256)throw new Error("The mixed current-film C2PA sidecar differs from the bytes its provenance record names.");active.throwIfAborted();}
    }
    await access();active.throwIfAborted();
  });
}
