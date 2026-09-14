import { createHash, createHmac } from "node:crypto";

/**
 * Minimal AWS Signature Version 4 request signing for the two multipart calls
 * Bun's S3Client does not expose: ListMultipartUploads and AbortMultipartUpload
 * (plus CreateMultipartUpload/UploadPart for the storage lane tests). No
 * dependency beyond node:crypto; credentials come only from the environment.
 */
export interface ObjectStoreConfig { endpoint: URL; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; }

/** Same variables and the same HTTPS-or-loopback rule as objectClient(). */
export function objectStoreConfig(env: Record<string,string|undefined> = process.env): ObjectStoreConfig {
  if (!env.HV_S3_ENDPOINT || !env.HV_S3_BUCKET || !env.HV_S3_ACCESS_KEY_ID || !env.HV_S3_SECRET_ACCESS_KEY)
    throw new Error("shared artifact storage is not configured");
  const endpoint = new URL(env.HV_S3_ENDPOINT);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(endpoint.hostname)))
    throw new Error("shared artifact storage requires HTTPS");
  return {endpoint, bucket: env.HV_S3_BUCKET, region: env.HV_S3_REGION ?? "us-east-1",
    accessKeyId: env.HV_S3_ACCESS_KEY_ID, secretAccessKey: env.HV_S3_SECRET_ACCESS_KEY};
}

/** RFC 3986 encoding: everything except unreserved characters is percent-encoded. */
export const encodeRfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
/** Each key segment is encoded once; S3 never double-encodes the canonical URI. */
export const canonicalPath = (...segments: string[]): string => "/" + segments.flatMap(segment => segment.split("/")).map(encodeRfc3986).join("/");
/** Parameters sorted by encoded name then value; empty values keep a trailing "=". */
export function canonicalQuery(query: Record<string,string>): string {
  return Object.entries(query).map(([name,value]) => [encodeRfc3986(name),encodeRfc3986(value)] as const)
    .sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
    .map(([name,value]) => name + "=" + value).join("&");
}
export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
export const EMPTY_PAYLOAD_HASH = sha256Hex("");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

export interface CanonicalInput { method: string; path: string; query: Record<string,string>; headers: Record<string,string>; payloadHash: string; }
const canonicalHeaders = (headers: Record<string,string>): [string,string][] =>
  Object.entries(headers).map(([name,value]) => [name.toLowerCase().trim(), value.trim().replace(/\s+/g," ")] as [string,string])
    .sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
export const signedHeaderList = (headers: Record<string,string>): string => canonicalHeaders(headers).map(([name]) => name).join(";");
/** `path` is the already-encoded canonical URI (see canonicalPath). */
export function canonicalRequest(input: CanonicalInput): string {
  const headers = canonicalHeaders(input.headers);
  return [input.method.toUpperCase(), input.path, canonicalQuery(input.query),
    headers.map(([name,value]) => name + ":" + value).join("\n") + "\n", headers.map(([name]) => name).join(";"), input.payloadHash].join("\n");
}
/** `timestamp` is the x-amz-date value, e.g. 20150830T123600Z. */
export const credentialScope = (timestamp: string, region: string, service: string): string =>
  `${timestamp.slice(0,8)}/${region}/${service}/aws4_request`;
export const stringToSign = (timestamp: string, scope: string, canonical: string): string =>
  ["AWS4-HMAC-SHA256", timestamp, scope, sha256Hex(canonical)].join("\n");
export function signingKey(secretAccessKey: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac("AWS4" + secretAccessKey, date), region), service), "aws4_request");
}
export function signature(secretAccessKey: string, timestamp: string, region: string, service: string, canonical: string): string {
  const key = signingKey(secretAccessKey, timestamp.slice(0,8), region, service);
  return createHmac("sha256", key).update(stringToSign(timestamp, credentialScope(timestamp, region, service), canonical)).digest("hex");
}
export const amzTimestamp = (now = Date.now()): string => new Date(now).toISOString().replace(/[-:]/g,"").replace(/\.\d{3}/,"");

/** Bodies are backed by a plain ArrayBuffer: the DOM `fetch` typing rejects SharedArrayBuffer-backed views. */
export type RequestBody = Uint8Array<ArrayBuffer>;
export interface ObjectRequest { method: "GET" | "PUT" | "POST" | "DELETE"; key?: string; query?: Record<string,string>; body?: RequestBody; timestamp?: string; }
export interface SignedRequest { url: string; headers: Record<string,string>; canonical: string; }
/** Path-style request against the configured bucket; host is signed but left for fetch to set. */
export function signRequest(config: ObjectStoreConfig, request: ObjectRequest): SignedRequest {
  const timestamp = request.timestamp ?? amzTimestamp();
  const payloadHash = request.body ? sha256Hex(request.body) : EMPTY_PAYLOAD_HASH;
  const prefix = config.endpoint.pathname.replace(/\/$/,"");
  const path = prefix + canonicalPath(config.bucket, ...(request.key === undefined ? [] : [request.key]));
  const query = request.query ?? {};
  const headers: Record<string,string> = {host: config.endpoint.host, "x-amz-content-sha256": payloadHash, "x-amz-date": timestamp};
  const canonical = canonicalRequest({method: request.method, path, query, headers, payloadHash});
  const scope = credentialScope(timestamp, config.region, "s3");
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaderList(headers)}, Signature=${signature(config.secretAccessKey, timestamp, config.region, "s3", canonical)}`;
  const search = canonicalQuery(query);
  return {url: config.endpoint.origin + path + (search ? "?" + search : ""), canonical,
    headers: {"x-amz-content-sha256": payloadHash, "x-amz-date": timestamp, authorization}};
}

const decodeXml = (value: string): string => value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) =>
  entity === "amp" ? "&" : entity === "lt" ? "<" : entity === "gt" ? ">" : entity === "quot" ? '"' : entity === "apos" ? "'"
  : String.fromCodePoint(entity[1] === "x" ? parseInt(entity.slice(2),16) : parseInt(entity.slice(1),10)));
/** First text content of a simple element; null when absent or self-closing. */
export function xmlElement(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeXml(match[1]!) : null;
}
export interface MultipartUpload { key: string; uploadId: string; initiated: string; }
export interface MultipartUploadListing { uploads: MultipartUpload[]; isTruncated: boolean; nextKeyMarker?: string; nextUploadIdMarker?: string; }
export function parseListMultipartUploads(xml: string): MultipartUploadListing {
  if (!/<ListMultipartUploadsResult[\s>]/.test(xml)) throw new Error("unexpected multipart listing document");
  const uploads: MultipartUpload[] = [];
  for (const match of xml.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)) {
    const key = xmlElement(match[1]!,"Key"), uploadId = xmlElement(match[1]!,"UploadId"), initiated = xmlElement(match[1]!,"Initiated");
    if (key === null || uploadId === null || initiated === null) throw new Error("multipart listing entry is incomplete");
    uploads.push({key, uploadId, initiated});
  }
  return {uploads, isTruncated: xmlElement(xml,"IsTruncated") === "true",
    nextKeyMarker: xmlElement(xml,"NextKeyMarker") || undefined, nextUploadIdMarker: xmlElement(xml,"NextUploadIdMarker") || undefined};
}
/** S3 error documents carry a <Code>; anything else yields null. */
export const parseErrorCode = (body: string): string | null => /<Error[\s>]/.test(body) ? xmlElement(body,"Code") : null;

export class S3RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) { super(message); this.name = "S3RequestError"; }
}
const UNSUPPORTED_CODES = ["NotImplemented","UnsupportedOperation","OperationNotSupported","NotSupported","MethodNotAllowed"];
/** HTTP 501 or an unsupported-operation code: the store lacks the API rather than the request failing. */
export const isUnsupportedOperation = (error: unknown): boolean =>
  error instanceof S3RequestError && (error.status === 501 || error.status === 405 || UNSUPPORTED_CODES.includes(error.code ?? ""));

export type FetchLike = (url: string, init: {method: string; headers: Record<string,string>; body?: RequestBody; signal: AbortSignal}) => Promise<Response>;
export interface MultipartUploadClient {
  listMultipartUploads(input: {prefix: string; keyMarker?: string; uploadIdMarker?: string; maxUploads?: number}): Promise<MultipartUploadListing>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}
export class S3MultipartClient implements MultipartUploadClient {
  constructor(private readonly config: ObjectStoreConfig, private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init), private readonly timeoutMs = 30_000) {}
  private async send(request: ObjectRequest): Promise<Response> {
    const signed = signRequest(this.config, request);
    const response = await this.fetchImpl(signed.url, {method: request.method, headers: signed.headers, body: request.body, signal: AbortSignal.timeout(this.timeoutMs)});
    if (response.ok) return response;
    const body = await response.text();
    throw new S3RequestError(`object store ${request.method} returned HTTP ${response.status}`, response.status, parseErrorCode(body));
  }
  async listMultipartUploads(input: {prefix: string; keyMarker?: string; uploadIdMarker?: string; maxUploads?: number}): Promise<MultipartUploadListing> {
    const query: Record<string,string> = {uploads: "", prefix: input.prefix, "max-uploads": String(input.maxUploads ?? 1000)};
    if (input.keyMarker !== undefined) query["key-marker"] = input.keyMarker;
    if (input.uploadIdMarker !== undefined) query["upload-id-marker"] = input.uploadIdMarker;
    const response = await this.send({method: "GET", query});
    return parseListMultipartUploads(await response.text());
  }
  /** An upload that no longer exists is already gone; every other failure propagates. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try { await this.send({method: "DELETE", key, query: {uploadId}}); }
    catch (error) { if (!(error instanceof S3RequestError && error.code === "NoSuchUpload")) throw error; }
  }
  async createMultipartUpload(key: string): Promise<string> {
    const response = await this.send({method: "POST", key, query: {uploads: ""}});
    const uploadId = xmlElement(await response.text(),"UploadId");
    if (!uploadId) throw new Error("multipart upload was not initiated");
    return uploadId;
  }
  async uploadPart(key: string, uploadId: string, partNumber: number, body: RequestBody): Promise<string> {
    const response = await this.send({method: "PUT", key, query: {partNumber: String(partNumber), uploadId}, body});
    await response.arrayBuffer();
    return response.headers.get("etag") ?? "";
  }
}
export const multipartClient = (env: Record<string,string|undefined> = process.env): S3MultipartClient => new S3MultipartClient(objectStoreConfig(env));
