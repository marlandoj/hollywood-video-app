/**
 * HV-040-07 — the archive path re-asked one question once per job, and did not ask another at all.
 *
 * `validateSnapshot` re-parsed the screenplay, re-planned every scene into shots and re-checked
 * every picture direction **once per job**, on inputs a project's jobs share byte for byte. It runs
 * twice on export and twice on import, and the first of those runs inside the `repeatable read,
 * read only` transaction `exportStateSnapshot` has already opened — so a CPU-bound validation held
 * a snapshot open on the cluster and pinned `xmin` against vacuum for its duration.
 *
 * And `assertRenderedFiles` — the check that a job's stored artifact rows are the media its
 * checkpoint names — had a branch for eight stages and none for `delivery`, which is the one stage
 * whose media is *not* under `job.output`, because `validateDeliveryJob` forbids one.
 *
 * The cost tests below use no database. The delivery check runs on the PostgreSQL paths, so the
 * totality guard over the source is what stands in for it here.
 */
import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {validateSnapshot,type StateSnapshot} from "../src/snapshots";
import {directionSnapshot} from "../../planner/src/direction";
import {ProjectService} from "../../api/src/index";
import {DurableJobStore,type Job} from "../../queue/src/index";

process.env.HV_TOKEN_SECRET="snapshot-cost-secret-with-at-least-thirty-two-characters";

const screenplay=(scenes:number)=>Array.from({length:scenes},(_value,index)=>
  "EXT. GARDEN "+(index+1)+" - DAY\n\nLeaves turn slowly in the "+(index+1)+" morning light and the wind carries them away.").join("\n\n");

/** One project, `jobCount` finished jobs, all carrying the same screenplay — which is what a project looks like. */
function snapshot(jobCount:number,scenes:number):StateSnapshot{
  const projects=new ProjectService(),owner=projects.createAnonymousProject(),text=screenplay(scenes);
  projects.editScript(owner.token,text);projects.attestRights(owner.token);
  const store=DurableJobStore.fromJobs([]),jobs:Job[]=[];
  for(let index=0;index<jobCount;index++){
    const id=crypto.randomUUID();
    const job=store.enqueue({id,projectId:owner.projectId,idempotencyKey:"cost-"+index,tier:"free",stage:"animatic",
      scriptVersion:1,scriptText:text,rightsAttestedAt:new Date().toISOString(),animaticJobId:null,animaticApprovedAt:null,
      costCapUsd:1,totalFrames:30,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60_000,
      direction:directionSnapshot(owner.projectId,0,[],0)});
    jobs.push({...job,status:"cancelled"});
  }
  return {schema:"hv-state/1",projects:projects.snapshot(),jobs,ledger:{events:[],reservations:[]},reviews:[]};
}
const ms=(work:()=>unknown):number=>{const started=Bun.nanoseconds();work();return (Bun.nanoseconds()-started)/1e6;};

test("validating a project's jobs does not re-plan its screenplay once per job",()=>{
  // A 1,800-scene screenplay is 181,384 characters, inside the 200,000 the script route allows.
  // Before: 93 ms at 8 jobs, 336 at 32, 1,264 at 128, 2,550 at 256 -- doubling with the job count.
  // After: 28, 18, 23, 24.
  const small=snapshot(8,1800),large=snapshot(256,1800);
  expect(small.jobs[0]!.scriptText.length).toBeGreaterThan(180_000);
  const eight=ms(()=>validateSnapshot(small)),many=ms(()=>validateSnapshot(large));
  // Thirty-two times the jobs. The old shape was thirty-two times the work; the floor under
  // `eight` keeps a fast measurement on a quiet runner from making the bound tight.
  expect({flat:many<=Math.max(eight,20)*4,eight:Math.round(eight),many:Math.round(many)})
    .toEqual({flat:true,eight:Math.round(eight),many:Math.round(many)});
  // And an absolute ceiling, because a ratio alone passes when both numbers are terrible.
  expect({fast:many<800,ms:Math.round(many)}).toEqual({fast:true,ms:Math.round(many)});
});

test("and it still refuses the job that is wrong, whichever job that is",()=>{
  // The memo answers "these five inputs were checked", so a job differing in any of them is a new
  // question. A snapshot whose jobs are identical except for one bad direction must still refuse.
  const bad=(position:"first"|"last")=>{
    const value=snapshot(8,12),jobs=[...value.jobs];
    const index=position==="first"?0:jobs.length-1;
    jobs[index]={...jobs[index]!,direction:{...jobs[index]!.direction!,version:-1}} as Job;
    return {...value,jobs};
  };
  expect(()=>validateSnapshot(bad("first"))).toThrow();
  // The one that matters: seven identical valid jobs are checked, answered from the memo, and the
  // eighth is a different question and is still asked.
  expect(()=>validateSnapshot(bad("last"))).toThrow();
  // A snapshot of identical valid jobs still validates, so the memo is not refusing by accident.
  expect(()=>validateSnapshot(snapshot(8,12))).not.toThrow();
  // Two projects with the same screenplay are two questions, because the anchor catalog the check
  // reads is the project's own.
  const one=snapshot(2,12),two=snapshot(2,12);
  expect(()=>validateSnapshot({...one,projects:{...one.projects,projects:[...one.projects.projects,...two.projects.projects]},
    jobs:[...one.jobs,...two.jobs]})).not.toThrow();
});

test("every media a job can hold is named where the archive decides there is nothing to import",()=>{
  // `archives.ts` skips `importCompletedJob` for a job it believes carries nothing. The list that
  // decided that named neither the deliverable nor five of the checkpoints, so a job holding only
  // one of those was skipped in silence rather than checked against the archive's files. Derived
  // from `Job`'s own fields rather than written down, so the next one is covered when it is added.
  const queue=readFileSync(new URL("../../queue/src/index.ts",import.meta.url),"utf8");
  const body=queue.slice(queue.indexOf("export interface Job "),queue.indexOf("\n}",queue.indexOf("export interface Job ")));
  const media=[...new Set((body.match(/^ {2}([a-zA-Z]+(?:Checkpoint|Output))\??:/gm) ?? [])
    .map(line=>line.trim().replace(/\??:$/,"")))];
  expect(media.length).toBeGreaterThanOrEqual(12);
  expect(media).toContain("deliveryOutput");
  const archives=readFileSync(new URL("../src/archives.ts",import.meta.url),"utf8");
  const skip=archives.slice(archives.indexOf("if (!paths.length"),archives.indexOf(") continue;",archives.indexOf("if (!paths.length")));
  for(const field of media)expect({field,named:skip.includes("job."+field)}).toEqual({field,named:true});
});

test("and the check that a job's stored rows are its own media knows about a deliverable",()=>{
  // A deliverable is the one media a job may hold without a `job.output`, because
  // `validateDeliveryJob` forbids one -- so the eight branches keyed on the other stages' fields
  // reached it never. Asserted over the source because the check itself runs only on a database.
  const artifacts=readFileSync(new URL("../src/artifacts.ts",import.meta.url),"utf8");
  const rendered=artifacts.slice(artifacts.indexOf("private assertRenderedFiles"),artifacts.indexOf("private assertPendingClips"));
  expect(rendered).toContain("job.delivery");
  expect(rendered).toContain("job.deliveryCheckpoint");
  expect(rendered).toContain("job.deliveryOutput");
  expect(rendered).toContain("validateDeliveryOutput");
  expect(rendered).toContain("Stored deliverable differs from its checkpoint.");
  // And an import refuses an archive that does not carry the file.
  const imported=artifacts.slice(artifacts.indexOf("async importCompletedJob"),artifacts.indexOf("private assertRenderedFiles"));
  expect(imported).toContain("Imported deliverable media is missing.");
});
