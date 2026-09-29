/**
 * HV-029-11 — revoking a review link left the film's media links it had handed out working.
 *
 * Opening a review link returns signed media URLs -- the MP4, the HLS playlist and its segments, the
 * captions -- valid for as long as the link (HV-029-05). Those URLs were ordinary artifact links:
 * they named the project, the job and an expiry, and nothing else. HV-029-08 gave the owner a way to
 * withdraw a link, and after it the review page answered 403 -- but the artifact route checks only
 * the signature, the project's deletion date, takedown and cast permission, so the MP4 the reviewer
 * had been given still downloaded, for up to seven more days. Withdrawing the link did not withdraw
 * the film.
 *
 * A media link a review link hands out now names that review link, by the SHA-256 of its token (a
 * digest, so the media URL does not carry the credential that opens the page and records decisions),
 * and the artifact route refuses it once the link is revoked or gone. The owner's own media links
 * name no review link and are unchanged.
 */
import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DurableJobStore} from "../../queue/src/index";
import {createApiServer} from "../src/server";
import {mintArtifactToken,reviewDigest,signToken,verifyToken} from "../src/tokens";

const root=mkdtempSync(join(tmpdir(),"hv-review-revoke-media-"));
const queuePath=join(root,"jobs.json"),artifactRoot=join(root,"artifacts"),statePath=join(root,"state/projects.json");
const generous={api:{limit:1_000_000,windowMs:60_000},projectCreate:{limit:1_000_000,windowMs:3600_000},artifacts:{limit:1_000_000,windowMs:60_000}};
let server:ReturnType<typeof createApiServer>,base:string;
beforeAll(()=>{
  process.env.HV_TOKEN_SECRET="review-revoke-media-secret-at-least-thirty-two-characters";
  server=createApiServer({port:0,hostname:"127.0.0.1",queuePath,artifactRoot,statePath,costLedgerPath:join(root,"state/cost-ledger.json"),frontendOrigin:"https://staging.example.test",rateLimit:generous});
  base=`http://127.0.0.1:${server.port}`;
});
afterAll(()=>{server.stop(true);rmSync(root,{recursive:true,force:true});});

/** A project with one finished cut on disk. */
async function filmed(){
  const created=await(await fetch(`${base}/api/projects`,{method:"POST"})).json() as {projectId:string;token:string};
  const headers={authorization:`Bearer ${created.token}`,"content-type":"application/json"};
  await fetch(`${base}/api/projects/${created.projectId}/script`,{method:"PUT",headers,body:JSON.stringify({text:"INT. ROOM - DAY\n\nA lamp glows."})});
  await fetch(`${base}/api/projects/${created.projectId}/rights`,{method:"POST",headers,body:JSON.stringify({attested:true})});
  await fetch(`${base}/api/projects/${created.projectId}/jobs`,{method:"POST",headers,body:JSON.stringify({})});
  const store=new DurableJobStore(queuePath),workerId=`finisher-${crypto.randomUUID()}`,claimed=store.claimNext(Date.now(),{},{workerId,leaseMs:60_000})!;
  const directory=join(artifactRoot,created.projectId,claimed.id);
  mkdirSync(join(directory,"hls"),{recursive:true});
  writeFileSync(join(directory,"export.mp4"),"mp4");writeFileSync(join(directory,"hls/index.m3u8"),"#EXTM3U\n#EXTINF:2.0,\nsegment-000.ts\n#EXT-X-ENDLIST\n");
  writeFileSync(join(directory,"hls/segment-000.ts"),"segment");writeFileSync(join(directory,"captions.vtt"),"WEBVTT\n");writeFileSync(join(directory,"provenance.json"),"{}");
  store.complete(claimed.id,workerId,{mp4Path:`${created.projectId}/${claimed.id}/export.mp4`,hlsPlaylistPath:`${created.projectId}/${claimed.id}/hls/index.m3u8`,
    captionsPath:`${created.projectId}/${claimed.id}/captions.vtt`,manifestPath:`${created.projectId}/${claimed.id}/provenance.json`},Date.now());
  return {...created,headers,jobId:claimed.id};
}
const review=async(film:Awaited<ReturnType<typeof filmed>>)=>(await(await fetch(`${base}/api/projects/${film.projectId}/reviews`,{method:"POST",headers:film.headers,body:JSON.stringify({permission:"read",maxViews:2})})).json() as {token:string}).token;
const opened=async(token:string)=>(await(await fetch(`${base}/api/reviews/${encodeURIComponent(token)}`,{headers:{"x-hv-review-viewer":crypto.randomUUID()}})).json() as {output:Record<string,string>}).output;
const status=async(url:string)=>(await fetch(new URL(url,base))).status;

test("after the owner revokes a review link, every media link it handed out stops working",async()=>{
  const film=await filmed(),token=await review(film),output=await opened(token);
  expect(await status(output.mp4Url!)).toBe(200);
  expect(await status(output.hlsUrl!)).toBe(200);
  expect((await fetch(`${base}/api/projects/${film.projectId}/reviews/${encodeURIComponent(token)}`,{method:"DELETE",headers:film.headers})).status).toBe(200);
  expect((await fetch(`${base}/api/reviews/${encodeURIComponent(token)}`)).status).toBe(403);
  for(const url of [output.mp4Url!,output.hlsUrl!,output.captionsUrl!])expect({url:url.split("/").at(-1),status:await status(url)}).toEqual({url:url.split("/").at(-1),status:404});
});

test("another review link's media, and the owner's own, keep working when one link is revoked",async()=>{
  const film=await filmed(),revoked=await review(film),kept=await review(film);
  const keptOutput=await opened(kept);await opened(revoked);
  await fetch(`${base}/api/projects/${film.projectId}/reviews/${encodeURIComponent(revoked)}`,{method:"DELETE",headers:film.headers});
  expect(await status(keptOutput.mp4Url!)).toBe(200);
  const owner=await(await fetch(`${base}/api/jobs/${film.jobId}`,{headers:film.headers})).json() as {output:Record<string,string>};
  expect(await status(owner.output.mp4Url!)).toBe(200);
});

test("a media link names its review link by digest, never by the token, and a malformed name is refused",()=>{
  const token="review-token",digest=reviewDigest(token);
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  const link=mintArtifactToken("p1","j1",Date.now()+60_000,Date.now(),digest);
  expect(verifyToken(link)).toMatchObject({kind:"artifact",projectId:"p1",jobId:"j1",review:digest});
  expect(Buffer.from(link.split(".")[0]!,"base64url").toString()).not.toContain(token+"\"");
  expect(verifyToken(mintArtifactToken("p1","j1",Date.now()+60_000))).not.toHaveProperty("review");
  expect(()=>mintArtifactToken("p1","j1",Date.now()+60_000,Date.now(),token)).toThrow();
  expect(verifyToken(signToken({kind:"artifact",projectId:"p1",jobId:"j1",exp:Date.now()+60_000,nonce:"n",review:token}))).toBeNull();
  expect(verifyToken(signToken({kind:"project",projectId:"p1",exp:Date.now()+60_000,nonce:"n",review:digest}))).toBeNull();
});
