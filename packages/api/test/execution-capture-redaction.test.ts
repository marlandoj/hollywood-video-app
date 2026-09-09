import {afterAll,afterEach,beforeAll,beforeEach,expect,test} from "bun:test";
import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {contentHash} from "../../generator/src/capabilities";

const PRIVATE="TEST-ONLY PRIVATE EXECUTION OBSERVATION — NOT WORKER CUSTODY";
let fixture:Awaited<ReturnType<typeof dubStudio>>;
let queueBytes:Buffer;
let manifestBytes:Buffer;
let clipBytes:Buffer;

/** These deliberately synthetic rows exercise serialization only. The film and
 * its manifests came from the real worker; attaching rows to test-only queue
 * state does not establish valid capture metadata or authenticated custody. */
function privateJob(){
  const job=structuredClone(fixture.film);
  const rows=job.output!.shotRenders!.map(record=>({
    shotId:record.shotId,recordRevision:record.revision,unavailableReason:null,
    capture:{schema:"hv-test-private-capture/1",observation:{prompt:PRIVATE},privateRoute:PRIVATE},
  }));
  return {...job,executionCheckpoints:rows,currentFilmOrigins:{schema:"hv-test-private-origins/1",privateOrigin:PRIVATE},currentFilmProof:{schema:"hv-test-private-proof/1",specification:PRIVATE},output:{...job.output!,shotExecutions:structuredClone(rows)}};
}
function saveJob(job:unknown):void{
  const jobs:Record<string,unknown>[]=JSON.parse(queueBytes.toString("utf8"));
  writeFileSync(fixture.paths.queuePath,JSON.stringify(jobs.map(value=>value.id===fixture.film.id?job:value)));
}
function assertRedacted(value:unknown):void{
  const text=JSON.stringify(value);
  for(const forbidden of [PRIVATE,'"executionCheckpoints"','"shotExecutions"','"hv-test-private-capture/1"','"currentFilmOrigins"','"hv-test-private-origins/1"','"currentFilmProof"','"hv-test-private-proof/1"'])expect(text).not.toContain(forbidden);
}
async function ownerView(){
  const response=await fixture.call("/api/jobs/"+fixture.film.id,"GET",undefined,fixture.owner.token);
  expect(response.status).toBe(200);
  return await response.json() as {id:string;status:string;output?:Record<string,string>;outputRevision:string|null;shotRenders:{shotId:string}[];artifactUrlsExpireInSeconds:number|null};
}
async function projectView(){
  const response=await fixture.call(fixture.base,"GET",undefined,fixture.owner.token);
  expect(response.status).toBe(200);
  return await response.json() as {jobs:{id:string;output?:Record<string,string>}[]};
}

beforeAll(async()=>{
  fixture=await dubStudio();
  queueBytes=readFileSync(fixture.paths.queuePath);
  manifestBytes=readFileSync(join(fixture.paths.artifactRoot,fixture.film.output!.manifestPath));
  clipBytes=readFileSync(join(fixture.paths.artifactRoot,fixture.owner.projectId,fixture.film.id,"clips/manifest.json"));
  expect(fixture.film.output!.shotRenders!.length).toBeGreaterThan(0);
},60000);
beforeEach(()=>saveJob(privateJob()));
afterEach(()=>writeFileSync(fixture.paths.queuePath,queueBytes));
afterAll(async()=>{if(fixture)await fixture.close();});

test("owner job and project views redact private checkpoint and completed execution rows",async()=>{
  expect(readFileSync(fixture.paths.queuePath,"utf8")).toContain(PRIVATE);
  const job=await ownerView(),project=await projectView();
  assertRedacted(job);assertRedacted(project);
  expect(job.id).toBe(fixture.film.id);expect(job.status).toBe("done");
  expect(job.outputRevision).toBe(contentHash(privateJob().output));
  expect(job.shotRenders.map(record=>record.shotId)).toEqual(fixture.film.output!.shotRenders!.map(record=>record.shotId));
  expect(job.output!.mp4Url).toStartWith("/artifacts/");
  expect(project.jobs.find(value=>value.id===fixture.film.id)!.output!.manifestUrl).toStartWith("/artifacts/");
  expect((await fixture.call("/api/jobs/"+fixture.film.id)).status).toBe(404);
});

test("review-derived artifact tokens expose ordinary manifests without private execution observations",async()=>{
  const created=await fixture.call(fixture.base+"/reviews","POST",{
    permission:"read",jobId:fixture.film.id,expectedOutputRevision:contentHash(privateJob().output),
  },fixture.owner.token);
  expect(await created.clone().text()).not.toContain('"error"');expect(created.status).toBe(201);
  const {token}=await created.json() as {token:string};
  const response=await fixture.call("/api/reviews/"+token);
  expect(response.status).toBe(200);
  const review=await response.json() as {jobId:string;output:Record<string,string>};
  expect(review.jobId).toBe(fixture.film.id);assertRedacted(review);
  // The signed review artifact token is scoped to this job, and can address the
  // existing clip manifest as well as the advertised provenance manifest.
  const signed=new URL(review.output.mp4Url!,fixture.server.url);
  const parts=signed.pathname.split("/");
  expect(parts.slice(1,2)).toEqual(["artifacts"]);
  expect(parts.slice(3,5)).toEqual([fixture.owner.projectId,fixture.film.id]);
  const clipsUrl=new URL(parts.slice(0,5).join("/")+"/clips/manifest.json",fixture.server.url);
  for(const [url,expected]of [[new URL(review.output.manifestUrl!,fixture.server.url),manifestBytes],[clipsUrl,clipBytes]] as const){
    const artifact=await fetch(url);expect(artifact.status).toBe(200);
    expect(artifact.headers.get("content-type")).toContain("application/json");
    const bytes=Buffer.from(await artifact.arrayBuffer());expect(bytes.equals(expected)).toBe(true);
    assertRedacted(JSON.parse(bytes.toString("utf8")));
  }
  const clips=JSON.parse(clipBytes.toString("utf8")) as {renderRecord:{shotId:string}}[];
  expect(clips.map(clip=>clip.renderRecord.shotId)).toEqual(fixture.film.output!.shotRenders!.map(record=>record.shotId));
  const mp4=await fetch(signed,{headers:{range:"bytes=0-31"}});
  expect(mp4.status).toBe(206);expect((await mp4.arrayBuffer()).byteLength).toBe(32);
  expect((await fixture.call("/api/jobs/"+fixture.film.id,"GET",undefined,token)).status).toBe(404);
});

test("expired and outputless owner serialization cannot fall back to private job state",async()=>{
  const expired={...privateJob(),linkExpiresAt:new Date(Date.now()-1000).toISOString()};saveJob(expired);
  const expiredView=await ownerView();assertRedacted(expiredView);assertRedacted(await projectView());
  expect(expiredView.artifactUrlsExpireInSeconds).toBe(0);
  const denied=await fetch(new URL(expiredView.output!.manifestUrl!,fixture.server.url));expect(denied.status).toBe(401);await denied.arrayBuffer();

  const {output:_output,...withoutOutput}=privateJob();
  saveJob({...withoutOutput,status:"running",completedAt:null,linkExpiresAt:null});
  const running=await ownerView();assertRedacted(running);assertRedacted(await projectView());
  expect(running.status).toBe("running");expect(running.output).toBeUndefined();expect(running.outputRevision).toBeNull();
  expect(running.artifactUrlsExpireInSeconds).toBeNull();expect(running.shotRenders).toEqual([]);
});
