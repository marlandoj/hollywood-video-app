/**
 * HV-019-08 — what a claim costs, and what a budget throttle is allowed to decide.
 *
 * Two defects from a critic pass over `packages/queue`, both in `claimNext`'s neighbourhood and
 * both invisible until the store has jobs in it:
 *
 *  - `eligibleToStart` materialised and filtered every job in the store to count one candidate's
 *    running siblings, and `claimNext` asks about every candidate, so a claim cost
 *    Θ(queued × stored). Nothing in this package ever deletes a job from the JSON store.
 *  - A `budget_throttle` admission records `queuedBehind` as **every active job in the studio**,
 *    frozen at admission and consulted before `fairShareOrder` is asked anything — so one
 *    project's long final blocks an unrelated project's first job. FR-029 forbids that, and the
 *    note beside `FAIR_SHARE_WINDOW_MS` names this exact shape while explaining another instance
 *    of it.
 *
 * The first is fixed here. The second is **recorded and not fixed**: it is a spend guard, and every
 * repair for it either weakens the guard in some window or risks an unbounded wait, so it needs the
 * operator's decision rather than a build session's. The test below asserts today's behaviour so the
 * decision has a baseline and so the change, when it comes, is deliberate.
 */
import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {CapacityController,DurableJobStore,type Job,type JobInput} from "../src/index";

const input=(id:string,projectId:string,over:Partial<JobInput>={}):JobInput=>({
  id,idempotencyKey:id,projectId,tier:"free",stage:"final",scriptVersion:1,totalFrames:60,
  retryPolicy:{maxRetries:1,backoffMs:10},timeoutMs:120_000,costCapUsd:5,scriptText:"x",
  rightsAttestedAt:null,animaticJobId:null,animaticApprovedAt:null,...over} as JobInput);

const body=(id:string,projectId:string):Job=>({
  id,idempotencyKey:id,projectId,tier:"free",stage:"final",scriptVersion:1,
  status:"queued",queueAction:"run",queueReason:"capacity_available",queuedBehind:[],
  checkpointFrame:0,checkpointShots:0,totalFrames:60,
  retryPolicy:{maxRetries:1,backoffMs:10},retriesUsed:0,timeoutMs:120_000,
  costCapUsd:5,costUsd:0,scriptText:"x",rightsAttestedAt:null,
  animaticJobId:null,animaticApprovedAt:null,nextEligibleAt:null,startedAt:null,
  leaseExpiresAt:null,claimedBy:null,resumedCount:0,completedAt:null,
  linkExpiresAt:null,notifications:[]} as Job);

/** One claim against a store of `n` queued jobs, in memory, so no file I/O is timed. */
function claimMs(n:number,reps=5):number{
  const jobs:Job[]=[];
  for(let index=0;index<n;index++)jobs.push(body(`queued-${index}`,`project-${index}`));
  const store=DurableJobStore.fromJobs(jobs);
  const warm=store.claimNext(Date.now(),{},{workerId:"w"})!;store.setStatus(warm.id,"queued");
  const started=Bun.nanoseconds();
  for(let rep=0;rep<reps;rep++){const job=store.claimNext(Date.now(),{},{workerId:"w"})!;store.setStatus(job.id,"queued");}
  return (Bun.nanoseconds()-started)/1e6/reps;
}

test("a claim costs one pass over the store, not one pass per candidate",()=>{
  // Before: 17 ms at 1,000 queued, 68 at 2,000, 233 at 4,000, 1,241 at 8,000 -- fourfold per
  // doubling, in memory, with no JSON parse or serialise in the measurement at all. Every real
  // store call is a full reload and rewrite under the interprocess lock, and one three-shot film
  // issues about thirty of them, so this is seconds of held lock per film at a few thousand jobs.
  claimMs(1000);                                   // warm the JIT on the whole path
  const small=claimMs(1000),large=claimMs(8000);
  // Eight times the store. Measured after: 0.24 ms and 3.00 ms, about twelvefold, the extra over
  // eight being `fairShareOrder`'s sort. Quadratic is sixty-four, and was measured at
  // seventy-threefold. The bound is loose on purpose -- what it must not tolerate is the sixty-four
  // -- and the floor under `small` keeps a fast small measurement on a quiet runner from making it
  // tight.
  expect({linear:large<=Math.max(small,1)*30,small:Number(small.toFixed(2)),large:Number(large.toFixed(2))})
    .toEqual({linear:true,small:Number(small.toFixed(2)),large:Number(large.toFixed(2))});
  // And an absolute ceiling, because a ratio alone passes if both numbers are terrible.
  expect({large:large<200,ms:Number(large.toFixed(2))}).toEqual({large:true,ms:Number(large.toFixed(2))});
});

/**
 * Recorded, not fixed (HV-019-08). A `budget_throttle` admission pins the job behind every active
 * job in the studio, which blocks one project on another before `fairShareOrder` is consulted, and
 * stores an unbounded list to do it.
 *
 * It is not an oversight: `queue.test.ts`'s "a budget-throttled job does not start while any job
 * that was ahead of it is still active" asserts exactly this, under AC-011 and FR-032. So the
 * studio has two requirements in tension — AC-011/FR-032 say a queued job waits for the jobs ahead
 * of it, FR-029 says no project may starve another — and every repair either weakens a spend guard
 * in some window or risks an unbounded wait. CLAUDE.md freezes budget guards without a human gate,
 * so this asserts what the code does today rather than what it should do. When the operator
 * resolves the tension, these two tests are what change, deliberately and together.
 */
test("a budget throttle pins a job behind the whole studio, and the list is unbounded",()=>{
  const decision=new CapacityController(5000).decide({tier:"free",runningForProject:0,requestedShots:1,monthSpendUsd:4000});
  expect(decision).toMatchObject({action:"queue_behind",reason:"budget_throttle"});

  const store=new DurableJobStore(null);
  store.enqueue(input("a-1","project-a"));
  expect(store.claimNext(Date.now(),{},{workerId:"w"})!.id).toBe("a-1");
  const b=store.enqueue(input("b-1","project-b",{queueAction:"queue_behind",queueReason:"budget_throttle"} as Partial<JobInput>));
  // Another project's job, which project B has no relationship with and cannot influence.
  expect(b.queuedBehind).toEqual(["a-1"]);
  expect(store.claimNext(Date.now(),{},{workerId:"w2"})).toBeUndefined();
  store.setStatus("a-1","done");
  expect(store.claimNext(Date.now(),{},{workerId:"w2"})!.id).toBe("b-1");

  // And the list is every active job at admission, stored in the job body and re-serialised on
  // every write to it. Five hundred here; nothing bounds it.
  const busy=new DurableJobStore(null);
  for(let index=0;index<500;index++)busy.enqueue(input(`x-${index}`,`project-x-${index}`));
  expect(busy.enqueue(input("late","project-late",{queueAction:"queue_behind",queueReason:"budget_throttle"} as Partial<JobInput>)).queuedBehind).toHaveLength(500);
  // A project's own concurrency queue is the bounded, correct case, and is unchanged.
  expect(busy.enqueue(input("x-0-again","project-x-0",{queueAction:"queue_behind",queueReason:"project_concurrency"} as Partial<JobInput>)).queuedBehind).toEqual(["x-0"]);
});

test("the notification bound's comment states a call-site count, so the count is checked",()=>{
  // The comment goes out of its way to give both numbers *because* an earlier draft got them
  // wrong, and it was wrong again by one at HV-027-05: a comment nobody can check is a comment
  // that drifts. Counted rather than asserted as a literal, so the numbers and the code agree.
  const queue=readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");
  const ledger=readFileSync(new URL("../../storage/src/ledger.ts",import.meta.url),"utf8");
  const calls=(source:string)=>(source.match(/(?<![A-Za-z.])notify\(/g) ?? []).length;
  // One of the matches in this file is the declaration `export function notify(`.
  const here=calls(queue)-1,elsewhere=calls(ledger);
  const words=["Zero","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve"];
  const comment=queue.slice(queue.indexOf(" * The cap on a job's user-facing notification list"),queue.indexOf("export const MAX_JOB_NOTIFICATIONS"));
  expect({total:comment.includes(words[here+elsewhere]!+" call `notify` today"),here:comment.includes(words[here]!.toLowerCase()+" here")})
    .toEqual({total:true,here:true});
});
