/**
 * HV-029-14 -- review comments and decision stages are kept, bounded and purged with the project.
 *
 * Both ride inside the review link record: the JSON store keeps that record as it was read, and
 * PostgreSQL keeps it whole in `hv_reviews.body`. So every reader, older ones included, carries
 * them through unchanged and no state schema bump is needed -- `validateSnapshot` bounds them on the
 * way in. They go where the link goes: with the project's sweep or takedown, on both stores.
 * See packages/api/test/review-comments.test.ts for the routes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectService } from "../../api/src/index";
import { REVIEW_COMMENTS_MAX, REVIEW_COMMENT_MAX_CHARS, type ReviewComment } from "../../api/src/review-comments";
import { reviewViewer } from "../../api/src/review-views";
import { outputRevision } from "../../planner/src/dialogue-selection";
import { DurableJobStore, type Job } from "../../queue/src/index";
import { StudioDatabase } from "../src/database";
import { PostgresProjectService } from "../src/projects";
import { PostgresRetention } from "../src/retention";
import { readStateSnapshot, validateSnapshot, writeStateSnapshot, type StateSnapshot } from "../src/snapshots";

const SECRET = "review-comments-secret-that-is-at-least-thirty-two-characters";
const viewer = reviewViewer("viewer-001-abcdefghijklmnop")!;

/** A retained animatic of `projectId`, completed in memory exactly as the JSON queue completes one. */
function doneAnimatic(projectId: string): Job {
  const jobs = DurableJobStore.fromJobs([]), id = crypto.randomUUID();
  jobs.enqueue({id,projectId,idempotencyKey:"review-"+id,tier:"free",stage:"animatic",scriptVersion:1,scriptText:"Leaves turn.",
    rightsAttestedAt:new Date().toISOString(),animaticJobId:null,animaticApprovedAt:null,costCapUsd:1,totalFrames:30,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60_000});
  jobs.claimNext(Date.now(),{},{workerId:"fixture"});
  const root = projectId+"/"+id+"/";
  jobs.complete(id,"fixture",{mp4Path:root+"export.mp4",hlsPlaylistPath:root+"hls/index.m3u8",captionsPath:root+"captions.vtt",manifestPath:root+"provenance.json"});
  return jobs.get(id)!;
}
/** A project with one bound, opened approve link holding one comment and an approval. */
function fixture() {
  process.env.HV_TOKEN_SECRET = SECRET;
  const projects = new ProjectService(), owner = projects.createAnonymousProject();
  projects.editScript(owner.token,"EXT. GARDEN - DAY\n\nLeaves turn."); projects.attestRights(owner.token);
  const job = doneAnimatic(owner.projectId);
  const link = projects.createBoundReviewLink(owner.token,"approve",job,{jobId:job.id,outputRevision:outputRevision(job)},Date.now(),3)!;
  expect(projects.recordReviewView(link.token,viewer)).toBe(2);
  const comment = projects.addReviewComment(link.token,{frame:45,text:"The door opens a beat early."},Date.now(),job,viewer)!;
  expect(projects.submitReviewDecision(link.token,"approved","",Date.now(),job,viewer)).toBe(true);
  const snapshot: StateSnapshot = {schema:"hv-state/1",projects:projects.snapshot(),jobs:[job],ledger:{events:[],reservations:[]},reviews:[]};
  return {projects,owner,job,link,comment,snapshot};
}
const withLink = (snapshot: StateSnapshot, change: (link: StateSnapshot["projects"]["reviewLinks"][number]) => void) => {
  const copy = structuredClone(snapshot); change(copy.projects.reviewLinks[0]!); return copy;
};

describe("comments ride in the review link record", () => {
  /** An hv-state/1 snapshot with a comment validates, round-trips on disk, and survives a reader's load and save untouched. */
  test("a snapshot keeps comments and the decision stage with no schema bump", () => {
    const {snapshot,comment} = fixture();
    const link = snapshot.projects.reviewLinks[0]!;
    expect(link.comments).toEqual([comment]);
    expect(link.decisionStage).toBe("rough-cut");
    expect(validateSnapshot(structuredClone(snapshot))).toEqual(snapshot);
    const root = mkdtempSync(join(tmpdir(),"hv-review-comments-"));
    try { writeStateSnapshot(join(root,"s"),snapshot); expect(readStateSnapshot(join(root,"s")).projects.reviewLinks[0]).toEqual(link); }
    finally { rmSync(root,{recursive:true,force:true}); }
    expect(ProjectService.fromState(snapshot.projects).snapshot().reviewLinks[0]).toEqual(link);
  });

  /** Every bound the route enforces is enforced again on the way in, so a hand-edited or foreign snapshot cannot carry more. */
  test("a snapshot whose comments break a bound is refused", () => {
    const {snapshot,comment} = fixture();
    const faults: [string,(link: StateSnapshot["projects"]["reviewLinks"][number]) => void][] = [
      ["too many",link => {link.comments = Array.from({length:REVIEW_COMMENTS_MAX+1},() => ({...comment,id:crypto.randomUUID()}));}],
      ["too long",link => {link.comments = [{...comment,text:"x".repeat(REVIEW_COMMENT_MAX_CHARS+1)}];}],
      ["empty",link => {link.comments = [{...comment,text:"  "}];}],
      ["negative frame",link => {link.comments = [{...comment,frame:-1}];}],
      ["fractional frame",link => {link.comments = [{...comment,frame:1.5}];}],
      ["duplicate id",link => {link.comments = [comment,{...comment}];}],
      ["unknown viewer",link => {link.comments = [{...comment,viewer:"f".repeat(64)}];}],
      ["extra field",link => {link.comments = [{...comment,ip:"203.0.113.9"} as ReviewComment];}],
      ["bad time",link => {link.comments = [{...comment,at:"yesterday"}];}],
      ["unbound link",link => {delete link.outputBinding;}],
      ["unknown stage",link => {(link as {decisionStage?: string}).decisionStage = "director";}],
      ["bad decision time",link => {link.decidedAt = "2026";}],
    ];
    for (const [name,change] of faults) expect(() => validateSnapshot(withLink(snapshot,change)),name).toThrow(/review/);
  });

  /** Sweeping or taking down the project removes its links, and with them every comment. */
  test("the JSON store purges comments with the project", async () => {
    const {projects,owner,snapshot} = fixture();
    expect(JSON.stringify(projects.snapshot())).toContain("The door opens a beat early.");
    expect(projects.sweepExpired(Date.parse(snapshot.projects.projects[0]!.deleteAfter)+1)).toEqual([owner.projectId]);
    expect(JSON.stringify(projects.snapshot())).not.toContain("The door opens a beat early.");
    expect(projects.snapshot().reviewLinks).toEqual([]);

    const again = fixture();
    expect(await again.projects.takedown(again.owner.projectId,"fixture",{revokeProject: async () => []})).toBe(true);
    expect(JSON.stringify(again.projects.snapshot())).not.toContain("The door opens a beat early.");
  });
});

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL && process.env.HV_WORKER_DATABASE_URL), pgtest = enabled ? test : test.skip;
const created: string[] = [];
let admin: StudioDatabase, api: StudioDatabase, other: StudioDatabase, worker: StudioDatabase;
beforeAll(async () => {
  if (!enabled) return;
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!); await admin.migrate();
  api = new StudioDatabase(process.env.HV_API_DATABASE_URL!); other = new StudioDatabase(process.env.HV_API_DATABASE_URL!);
  worker = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
});
afterAll(async () => {
  if (!enabled) return;
  for (const id of created) for (const table of ["hv_outbox","hv_artifacts","hv_jobs","hv_reviews","hv_projects"])
    await admin.sql.unsafe("delete from "+table+" where "+(table==="hv_projects"?"id":"project_id")+"=$1",[id]);
  await Promise.all([admin.close(),api.close(),other.close(),worker.close()]);
});

pgtest("PostgreSQL keeps comments against the retained cut, resolves them across connections, and purges them with the project", async () => {
  process.env.HV_TOKEN_SECRET = SECRET;
  const service = new PostgresProjectService(api), second = new PostgresProjectService(other);
  const owner = await service.createAnonymousProject(); created.push(owner.projectId);
  await service.editScript(owner.token,"EXT. GARDEN - DAY\n\nLeaves turn."); await service.attestRights(owner.token);
  const job = doneAnimatic(owner.projectId);
  await admin.sql`insert into hv_jobs (id,project_id,idempotency_key,stage,status,tier,body) values (${job.id},${owner.projectId},${job.idempotencyKey},${job.stage},${job.status},${job.tier},${job}::jsonb)`;
  for (const path of [job.output!.mp4Path,job.output!.hlsPlaylistPath,job.output!.captionsPath,job.output!.manifestPath])
    await admin.sql`insert into hv_artifacts (key,project_id,job_id,sha256,bytes,content_type,backend,object_key) values (${path},${owner.projectId},${job.id},${"a".repeat(64)},${1},'application/octet-stream','s3',${"index-only/"+path})`;
  const binding = {jobId:job.id,outputRevision:outputRevision(job)};
  const link = (await service.createBoundReviewLink(owner.token,"approve",job,binding,Date.now(),3))!;
  expect(await service.openReviewLink(link.token,viewer)).toBeTruthy();
  expect(await service.recordReviewView(link.token,viewer)).toBe(2);

  // The comment re-reads the bound cut under a share lock, as the decision does: its media must still be indexed.
  const mp4 = (await admin.sql`delete from hv_artifacts where key = ${job.output!.mp4Path} returning *`)[0];
  await expect(service.addReviewComment(link.token,{frame:45,text:"The door opens a beat early."},Date.now(),undefined,viewer)).rejects.toThrow("retained media");
  await admin.sql`insert into hv_artifacts ${admin.sql(mp4)}`;
  const comment = (await service.addReviewComment(link.token,{frame:45,text:"The door opens a beat early."},Date.now(),undefined,viewer))!;
  expect(comment).toMatchObject({frame:45,viewer:viewer.hash,resolvedAt:null});

  const seen = (await second.ownerReviews(owner.token))!;
  expect(seen.links[0]!.comments).toEqual([{...comment,timecode:"00:00:01:15",viewer:1}]);
  expect((await second.resolveReviewComment(owner.token,comment.id,true))!.resolvedAt).toEqual(expect.any(String));
  expect((await service.ownerReviews(owner.token))!.links[0]!.comments[0]!.resolvedAt).toEqual(expect.any(String));
  expect(await service.resolveReviewComment(owner.token,crypto.randomUUID(),true)).toBeNull();

  expect(await service.submitReviewDecision(link.token,"approved","",Date.now(),undefined,viewer)).toBe(true);
  expect((await second.ownerReviews(owner.token))!.stages.find(stage => stage.stage === "rough-cut")).toMatchObject({approved:1,latest:{decision:"approved",jobId:job.id}});

  const read = (await service.createBoundReviewLink(owner.token,"read",job,binding,Date.now(),3))!;
  expect(await service.recordReviewView(read.token,viewer)).toBe(2);
  expect(await service.addReviewComment(read.token,{frame:1,text:"Nice."},Date.now(),undefined,viewer)).toBeNull();

  await admin.sql`update hv_projects set delete_after = now() - interval '1 second' where id = ${owner.projectId}`;
  expect(await new PostgresRetention(worker).purgeProject(owner.projectId)).toBe(true);
  expect(Number((await admin.sql`select count(*) as count from hv_reviews where project_id = ${owner.projectId}`)[0].count)).toBe(0);
  expect(await service.ownerReviews(owner.token)).toBeNull();
});
