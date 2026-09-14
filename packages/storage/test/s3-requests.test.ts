import { afterAll, expect, test } from "bun:test";
import { objectClient } from "../src/artifacts";
import { EMPTY_PAYLOAD_HASH, S3MultipartClient, S3RequestError, amzTimestamp, canonicalPath, canonicalQuery, canonicalRequest,
  credentialScope, encodeRfc3986, isUnsupportedOperation, multipartClient, objectStoreConfig, parseErrorCode, parseListMultipartUploads,
  sha256Hex, signRequest, signature, signingKey, stringToSign } from "../src/s3-requests";

// Published AWS Signature Version 4 example credentials and timestamp (IAM ListUsers walkthrough).
const exampleAccessKeyId = "AKIDEXAMPLE";
const exampleSecretAccessKey = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const exampleTimestamp = "20150830T123600Z";
const fixtureEnv = {HV_S3_ENDPOINT: "http://127.0.0.1:59000", HV_S3_BUCKET: "rough-cut-fixture", HV_S3_REGION: "us-east-1",
  HV_S3_ACCESS_KEY_ID: exampleAccessKeyId, HV_S3_SECRET_ACCESS_KEY: exampleSecretAccessKey};

test("SigV4 canonical request, string to sign, signing key and signature match the published AWS example", () => {
  const canonical = canonicalRequest({method: "get", path: "/", query: {Version: "2010-05-08", Action: "ListUsers"},
    headers: {"X-Amz-Date": exampleTimestamp, Host: "iam.amazonaws.com", "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"},
    payloadHash: EMPTY_PAYLOAD_HASH});
  expect(EMPTY_PAYLOAD_HASH).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(canonical).toBe(["GET", "/", "Action=ListUsers&Version=2010-05-08",
    "content-type:application/x-www-form-urlencoded; charset=utf-8", "host:iam.amazonaws.com", "x-amz-date:" + exampleTimestamp, "",
    "content-type;host;x-amz-date", EMPTY_PAYLOAD_HASH].join("\n"));
  expect(sha256Hex(canonical)).toBe("f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59");
  const scope = credentialScope(exampleTimestamp, "us-east-1", "iam");
  expect(scope).toBe("20150830/us-east-1/iam/aws4_request");
  expect(stringToSign(exampleTimestamp, scope, canonical)).toBe(["AWS4-HMAC-SHA256", exampleTimestamp, scope,
    "f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59"].join("\n"));
  expect(signingKey(exampleSecretAccessKey, "20150830", "us-east-1", "iam").toString("hex")).toBe("c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
  expect(signature(exampleSecretAccessKey, exampleTimestamp, "us-east-1", "iam", canonical)).toBe("5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
  expect(amzTimestamp(Date.UTC(2015, 7, 30, 12, 36, 0))).toBe(exampleTimestamp);
});

test("query parameters are sorted and RFC 3986 encoded and key segments are encoded once", () => {
  expect(encodeRfc3986("a b*c(d)!e'f~g-h_i.j/é")).toBe("a%20b%2Ac%28d%29%21e%27f~g-h_i.j%2F%C3%A9");
  expect(canonicalQuery({uploads: "", "upload-id-marker": "id 1", prefix: "v1/", "key-marker": "v1/p/x*y", "max-uploads": "1000"}))
    .toBe("key-marker=v1%2Fp%2Fx%2Ay&max-uploads=1000&prefix=v1%2F&upload-id-marker=id%201&uploads=");
  expect(canonicalQuery({})).toBe("");
  expect(canonicalPath("bucket", "v1/p/file (1)!.bin")).toBe("/bucket/v1/p/file%20%281%29%21.bin");
  expect(canonicalPath("bucket")).toBe("/bucket");
});

test("signed requests are path-style against the configured bucket with the s3 credential scope", () => {
  const config = objectStoreConfig(fixtureEnv);
  const signed = signRequest(config, {method: "DELETE", key: "v1/p/j/part one.bin", query: {uploadId: "abc/def"}, timestamp: exampleTimestamp});
  expect(signed.url).toBe("http://127.0.0.1:59000/rough-cut-fixture/v1/p/j/part%20one.bin?uploadId=abc%2Fdef");
  expect(signed.headers["x-amz-date"]).toBe(exampleTimestamp);
  expect(signed.headers["x-amz-content-sha256"]).toBe(EMPTY_PAYLOAD_HASH);
  expect(signed.headers.host).toBeUndefined();
  expect(signed.canonical.split("\n")).toEqual(["DELETE", "/rough-cut-fixture/v1/p/j/part%20one.bin", "uploadId=abc%2Fdef",
    "host:127.0.0.1:59000", "x-amz-content-sha256:" + EMPTY_PAYLOAD_HASH, "x-amz-date:" + exampleTimestamp, "",
    "host;x-amz-content-sha256;x-amz-date", EMPTY_PAYLOAD_HASH]);
  const expected = signature(exampleSecretAccessKey, exampleTimestamp, "us-east-1", "s3", signed.canonical);
  expect(signed.headers.authorization).toBe(`AWS4-HMAC-SHA256 Credential=${exampleAccessKeyId}/20150830/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${expected}`);
  const listing = signRequest(config, {method: "GET", query: {uploads: "", prefix: "v1/"}, timestamp: exampleTimestamp});
  expect(listing.url).toBe("http://127.0.0.1:59000/rough-cut-fixture?prefix=v1%2F&uploads=");
  const body = new Uint8Array(new TextEncoder().encode("abc")); // Copy: request bodies are plain ArrayBuffer-backed views.
  expect(signRequest(config, {method: "PUT", key: "k", body}).headers["x-amz-content-sha256"]).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(signRequest(objectStoreConfig({...fixtureEnv, HV_S3_ENDPOINT: "https://objects.example/base/"}), {method: "GET", key: "k", timestamp: exampleTimestamp}).url)
    .toBe("https://objects.example/base/rough-cut-fixture/k");
});

test("the endpoint rule rejects plain HTTP to a non-loopback host and shares objectClient's variables", () => {
  expect(() => objectStoreConfig({...fixtureEnv, HV_S3_ENDPOINT: "http://objects.example:9000"})).toThrow("requires HTTPS");
  expect(() => objectClient({...fixtureEnv, HV_S3_ENDPOINT: "http://objects.example:9000"})).toThrow("requires HTTPS");
  expect(() => objectStoreConfig({...fixtureEnv, HV_S3_SECRET_ACCESS_KEY: undefined})).toThrow("not configured");
  expect(() => multipartClient({...fixtureEnv, HV_S3_BUCKET: undefined})).toThrow("not configured");
  for (const endpoint of ["http://localhost:9000", "http://127.0.0.1:59000", "http://[::1]:9000", "https://objects.example"]) {
    const config = objectStoreConfig({...fixtureEnv, HV_S3_ENDPOINT: endpoint});
    expect(config.endpoint.href).toBe(new URL(endpoint).href);
    expect(config.bucket).toBe("rough-cut-fixture");
  }
  expect(objectStoreConfig({...fixtureEnv, HV_S3_REGION: undefined}).region).toBe("us-east-1");
});

const listingFixture = `<?xml version="1.0" encoding="UTF-8"?>
<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>rough-cut-fixture</Bucket><KeyMarker></KeyMarker><UploadIdMarker></UploadIdMarker>
  <NextKeyMarker>v1/p2/j/b.bin</NextKeyMarker><NextUploadIdMarker>upload-2</NextUploadIdMarker>
  <Prefix>v1/</Prefix><MaxUploads>2</MaxUploads><IsTruncated>true</IsTruncated>
  <Upload><Key>v1/p1/j/a&amp;b &lt;c&gt;.bin</Key><UploadId>upload-1</UploadId>
    <Initiator><ID>x</ID><DisplayName>x</DisplayName></Initiator><Owner><ID>x</ID></Owner>
    <StorageClass>STANDARD</StorageClass><Initiated>2026-09-01T10:00:00.000Z</Initiated></Upload>
  <Upload><Key>v1/p2/j/b.bin</Key><UploadId>upload-2</UploadId><Initiated>2026-09-02T11:30:00Z</Initiated></Upload>
</ListMultipartUploadsResult>`;
const errorFixture = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NotImplemented</Code><Message>A header you provided implies functionality that is not implemented</Message><Resource>/rough-cut-fixture</Resource><RequestId>1</RequestId></Error>`;

test("ListMultipartUploadsResult and S3 error documents parse from fixture XML", () => {
  const listing = parseListMultipartUploads(listingFixture);
  expect(listing.uploads).toEqual([{key: "v1/p1/j/a&b <c>.bin", uploadId: "upload-1", initiated: "2026-09-01T10:00:00.000Z"},
    {key: "v1/p2/j/b.bin", uploadId: "upload-2", initiated: "2026-09-02T11:30:00Z"}]);
  expect(listing.isTruncated).toBe(true);
  expect(listing.nextKeyMarker).toBe("v1/p2/j/b.bin");
  expect(listing.nextUploadIdMarker).toBe("upload-2");
  for (const upload of listing.uploads) expect(Number.isFinite(Date.parse(upload.initiated))).toBe(true);
  const empty = parseListMultipartUploads(`<ListMultipartUploadsResult><IsTruncated>false</IsTruncated><NextKeyMarker/></ListMultipartUploadsResult>`);
  expect(empty).toEqual({uploads: [], isTruncated: false, nextKeyMarker: undefined, nextUploadIdMarker: undefined});
  expect(() => parseListMultipartUploads(`<ListBucketResult><Contents><Key>x</Key></Contents></ListBucketResult>`)).toThrow("unexpected multipart listing");
  expect(() => parseListMultipartUploads(`<ListMultipartUploadsResult><Upload><Key>x</Key></Upload></ListMultipartUploadsResult>`)).toThrow("incomplete");
  expect(parseErrorCode(errorFixture)).toBe("NotImplemented");
  expect(parseErrorCode("<html>gateway timeout</html>")).toBeNull();
  expect(parseErrorCode(listingFixture)).toBeNull();
  expect(isUnsupportedOperation(new S3RequestError("x", 501, null))).toBe(true);
  expect(isUnsupportedOperation(new S3RequestError("x", 400, "NotImplemented"))).toBe(true);
  expect(isUnsupportedOperation(new S3RequestError("x", 400, "UnsupportedOperation"))).toBe(true);
  expect(isUnsupportedOperation(new S3RequestError("x", 403, "AccessDenied"))).toBe(false);
  expect(isUnsupportedOperation(new S3RequestError("x", 500, "InternalError"))).toBe(false);
  expect(isUnsupportedOperation(new Error("NotImplemented"))).toBe(false);
});

test("the multipart client sends signed listing and abort requests and maps store errors", async () => {
  const requests: {url: string; method: string; headers: Record<string,string>}[] = [];
  let response: () => Response = () => new Response(listingFixture, {status: 200});
  const client = new S3MultipartClient(objectStoreConfig(fixtureEnv), async (url, init) => { requests.push({url, method: init.method, headers: init.headers}); return response(); });
  const listing = await client.listMultipartUploads({prefix: "v1/", keyMarker: "v1/p0/x", uploadIdMarker: "u0", maxUploads: 2});
  expect(listing.uploads.length).toBe(2);
  expect(requests[0]!.url).toBe("http://127.0.0.1:59000/rough-cut-fixture?key-marker=v1%2Fp0%2Fx&max-uploads=2&prefix=v1%2F&upload-id-marker=u0&uploads=");
  expect(requests[0]!.method).toBe("GET");
  expect(requests[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  response = () => new Response(null, {status: 204});
  await client.abortMultipartUpload("v1/p1/j/a&b <c>.bin", "upload-1");
  expect(requests[1]!.url).toBe("http://127.0.0.1:59000/rough-cut-fixture/v1/p1/j/a%26b%20%3Cc%3E.bin?uploadId=upload-1");
  expect(requests[1]!.method).toBe("DELETE");
  response = () => new Response(`<Error><Code>NoSuchUpload</Code></Error>`, {status: 404});
  await client.abortMultipartUpload("v1/p1/j/gone.bin", "upload-9"); // Already gone counts as done.
  response = () => new Response(errorFixture, {status: 501});
  const failure = await client.listMultipartUploads({prefix: "v1/"}).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(S3RequestError);
  expect((failure as S3RequestError).status).toBe(501);
  expect((failure as S3RequestError).code).toBe("NotImplemented");
  expect(isUnsupportedOperation(failure)).toBe(true);
  response = () => new Response(`<Error><Code>AccessDenied</Code></Error>`, {status: 403});
  await expect(client.abortMultipartUpload("v1/p1/j/a.bin", "upload-1")).rejects.toMatchObject({status: 403, code: "AccessDenied"});
  expect(requests.every(request => request.headers["x-amz-content-sha256"] === EMPTY_PAYLOAD_HASH)).toBe(true);
});

const enabled = Boolean(process.env.HV_S3_ENDPOINT && process.env.HV_S3_BUCKET && process.env.HV_S3_ACCESS_KEY_ID && process.env.HV_S3_SECRET_ACCESS_KEY);
const s3test = enabled ? test : test.skip;
const runId = crypto.randomUUID();
const seeded: {key: string; uploadId: string}[] = [];
afterAll(async () => {
  if (!enabled) return;
  const client = multipartClient();
  for (const upload of seeded) await client.abortMultipartUpload(upload.key, upload.uploadId).catch(() => {});
});
s3test("a real multipart upload lists under its prefix with a parsable Initiated time and disappears after abort", async () => {
  const client = multipartClient(), prefix = `v1/${runId}/`, key = `${prefix}lifecycle/${crypto.randomUUID()}.bin`;
  const uploadId = await client.createMultipartUpload(key);
  seeded.push({key, uploadId});
  expect(uploadId.length).toBeGreaterThan(0);
  await client.uploadPart(key, uploadId, 1, new Uint8Array(1024).fill(0x61));
  const listing = await client.listMultipartUploads({prefix});
  expect(listing.uploads.map(upload => [upload.key, upload.uploadId])).toEqual([[key, uploadId]]);
  expect(Number.isFinite(Date.parse(listing.uploads[0]!.initiated))).toBe(true);
  expect(Math.abs(Date.parse(listing.uploads[0]!.initiated) - Date.now())).toBeLessThan(6 * 3600e3);
  expect((await objectClient().list({prefix, maxKeys: 10})).contents ?? []).toEqual([]); // Parts are invisible to object listing.
  await client.abortMultipartUpload(key, uploadId);
  expect((await client.listMultipartUploads({prefix})).uploads).toEqual([]);
}, 60_000);
