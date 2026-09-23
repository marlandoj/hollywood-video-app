/**
 * HV-019-07 — what a film says about itself must not depend on whether its render was interrupted.
 *
 * `degradedShots` and `shotReviews` were per-incarnation locals, the shot loop skips everything the
 * checkpoint already holds, and the review flush sat *below* the loop. So a job requeued mid-film —
 * a lapsed lease, a dead worker, an ordinary retry, which is the case the checkpoint exists for —
 * delivered an MP4 whose provenance said `degraded_shots=none` with a degraded shot in it, and
 * flagged nothing to the operator: not in the incarnation that died, which never reached the flush,
 * and not in the one that resumed, which skipped those shots.
 *
 * Both runs below deliver byte-identical clips. Only the interruption differs.
 *
 * AC-012 asks for the degraded note in the final MP4 and FR-036 for the operator flag. A report
 * that undercounts in silence is the worst failure available to a report, which is why this file
 * measures the two runs against each other rather than against a hard-coded string.
 */
import {afterAll,expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from "node:fs";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CostLedger,OperatorReviewQueue,type ReviewItem} from "../../operator/src/index";
import {DeterministicMockProvider,type GenParams,type VideoClip} from "../../generator/src/index";
import {DurableJobStore} from "../src/index";
import {processNextJob,type WorkerContext} from "../src/worker";

const SCRIPT="INT. ROOM - DAY\n\nA lamp glows.\n\nA kettle sings.\n\nThe door opens.";
/** Shot 2 is discontinuous against shot 1 (score 0); shot 3 matches shot 2 (score 1). */
const DRIFTS=["00".repeat(32),"ff".repeat(32),"ff".repeat(32)];
/** The same film with nothing wrong with it: every shot matches its neighbour. */
const HOLDS=["00".repeat(32),"00".repeat(32),"00".repeat(32)];
const roots:string[]=[];
afterAll(()=>{for(const root of roots)rmSync(root,{recursive:true,force:true});});

const job=(over:Record<string,unknown>={})=>({
  id:"job-1",idempotencyKey:"job-1",projectId:"project-1",tier:"free" as const,
  stage:"final" as const,scriptVersion:1,totalFrames:60,
  retryPolicy:{maxRetries:3,backoffMs:0},timeoutMs:600_000,costCapUsd:5,
  scriptText:SCRIPT,rightsAttestedAt:"2026-08-31T00:00:00.000Z",
  animaticJobId:"animatic-1",animaticApprovedAt:"2026-08-31T00:05:00.000Z",...over});

function seedApprovedAnimatic(store:DurableJobStore):void{
  store.enqueue(job({id:"animatic-1",idempotencyKey:"animatic-1",stage:"animatic",animaticJobId:null,animaticApprovedAt:null}) as Parameters<DurableJobStore["enqueue"]>[0]);
  store.claimNext(Date.now(),{},{workerId:"seed"});
  store.complete("animatic-1","seed",{mp4Path:"project-1/animatic-1/export.mp4",hlsPlaylistPath:"project-1/animatic-1/hls/index.m3u8",
    captionsPath:"project-1/animatic-1/captions.vtt",manifestPath:"project-1/animatic-1/provenance.json"});
}

/** The mock provider, with one shot's host taken away and fingerprints that decide continuity. */
class Scripted extends DeterministicMockProvider {
  constructor(private readonly loseShotIndex:number|null,private readonly prints:readonly string[]){super();}
  override async generate(prompt:string,seed:number,params:GenParams,outPath:string):Promise<VideoClip>{
    const base=outPath.slice(outPath.lastIndexOf("/")+1);
    const index=Number(base.match(/^shot-\d+-(\d+)-a\d+\.mp4$/)?.[1]??"1")-1;
    if(this.loseShotIndex===index)throw new Error("the host rendering this shot went away");
    return {...await super.generate(prompt,seed,params,outPath),fingerprint:this.prints[index]??this.prints[0]!};
  }
}

function fixture(prints:readonly string[]=DRIFTS){
  const root=mkdtempSync(join(tmpdir(),"hv-degraded-resume-"));
  roots.push(root);
  mkdirSync(join(root,"artifacts"),{recursive:true});
  const store=new DurableJobStore(join(root,"jobs.json"));
  seedApprovedAnimatic(store);
  store.enqueue(job());
  const context=(loseShotIndex:number|null):WorkerContext=>({
    ledger:new CostLedger(join(root,"cost-ledger.json")),
    reviewQueue:new OperatorReviewQueue(join(root,"review-queue.json")),
    primary:new Scripted(loseShotIndex,prints),secondary:new Scripted(loseShotIndex,prints)});
  const queued=()=>{try{return JSON.parse(readFileSync(join(root,"review-queue.json"),"utf8")) as ReviewItem[];}catch{return [];}};
  const render=(loseShotIndex:number|null)=>processNextJob(store,join(root,"artifacts"),context(loseShotIndex));
  const degradedNote=(mp4Path:string)=>Bun.spawnSync(["ffprobe","-v","error","-show_entries","format_tags=comment","-of","default=nw=1:nk=1",
    join(root,"artifacts",mp4Path)]).stdout.toString().trim();
  /** Each retained clip's fingerprint and the digest of its bytes, from the job's own manifest. */
  const clips=()=>(JSON.parse(readFileSync(join(root,"artifacts","project-1","job-1","clips","manifest.json"),"utf8")) as {path:string;fingerprint:string}[])
    .map(clip=>({name:clip.path.slice(clip.path.lastIndexOf("/")+1),fingerprint:clip.fingerprint,
      sha256:createHash("sha256").update(readFileSync(clip.path)).digest("hex")}));
  return {root,store,render,queued,degradedNote,clips};
}

test("a film interrupted mid-render delivers the same degraded record as one that was not",async()=>{
  // The control: three shots, no interruption. Shot 2 is discontinuous, and the film says so.
  const control=fixture();
  const straight=await control.render(null);
  expect(straight?.status).toBe("done");
  expect(control.degradedNote(straight!.output!.mp4Path)).toBe("degraded_shots=shot-1-2");
  expect(control.queued().map(item=>item.shotId)).toEqual(["shot-1-2"]);

  // The same film, with the host for shot 3 taken away after shot 2 was rendered and checkpointed.
  const interrupted=fixture();
  const stopped=await interrupted.render(2);
  expect(stopped?.status).toBe("queued");
  expect(stopped?.checkpointShots).toBe(2);
  // The incarnation that died had already established that shot 2 is degraded. It said so before
  // it checkpointed, so the operator has it even though this incarnation never finished a film.
  expect(interrupted.queued().map(item=>item.shotId)).toEqual(["shot-1-2"]);

  const resumed=await interrupted.render(null);
  expect(resumed?.status).toBe("done");
  // The two films are the same film: same clips, same fingerprints, same bytes.
  expect(interrupted.clips()).toEqual(control.clips());
  // So they must say the same thing about themselves.
  expect(interrupted.degradedNote(resumed!.output!.mp4Path)).toBe(control.degradedNote(straight!.output!.mp4Path));
  expect(interrupted.degradedNote(resumed!.output!.mp4Path)).toBe("degraded_shots=shot-1-2");
  // And the shot is queued once, not twice: it was flagged by the incarnation that rendered it and
  // the resumed one skipped it, and the queue would answer once in either case.
  expect(interrupted.queued().map(item=>item.shotId)).toEqual(["shot-1-2"]);
  expect(interrupted.queued()).toHaveLength(1);
});

test("a film with nothing wrong with it still says nothing is wrong with it, interrupted or not",async()=>{
  // Every shot matches its neighbour, so nothing is degraded and nothing is queued -- which is what
  // makes the rebuilt prefix a measurement rather than a way of always answering "degraded".
  const clean=fixture(HOLDS);
  const stopped=await clean.render(2);
  expect(stopped?.status).toBe("queued");
  expect(stopped?.checkpointShots).toBe(2);
  expect(clean.queued()).toEqual([]);
  const done=await clean.render(null);
  expect(done?.status).toBe("done");
  expect(clean.degradedNote(done!.output!.mp4Path)).toBe("degraded_shots=none");
  expect(clean.queued()).toEqual([]);
});

test("the two stores of the operator's queue agree that a shot is one item",()=>{
  // `PostgresReviewQueue.flag` keys on sha256(projectId + "\0" + shotId) and does
  // `on conflict do update … resolved_at = null`; this one pushed unconditionally. The worker now
  // flags before it checkpoints, so a shot rendered twice across an interruption is flagged twice,
  // and `resolve(shotId)` clears one item and does not even take a project — a duplicate was an
  // entry no `resolve` call would ever reach.
  const root=mkdtempSync(join(tmpdir(),"hv-review-queue-"));
  roots.push(root);
  const queue=new OperatorReviewQueue(join(root,"review-queue.json"));
  queue.flag("shot-1-2","project-1",0.1);
  queue.flag("shot-1-2","project-1",0.4);
  expect(queue.pending()).toHaveLength(1);
  expect(queue.pending()[0]!.score).toBe(0.4);
  // The same shot id in another project is another shot.
  queue.flag("shot-1-2","project-2",0.2);
  expect(queue.pending().map(item=>item.projectId).sort()).toEqual(["project-1","project-2"]);
  // Resolving clears it, and a later degradation of the same shot reopens it rather than being lost.
  // HV-038-08: the project is named. Before, `resolve` took a shot id alone, and shot ids are
  // per-project strings -- this line used to clear whichever of the two it found first.
  queue.resolve("shot-1-2","project-1");
  expect(queue.pending().map(item=>item.projectId)).toEqual(["project-2"]);
  queue.flag("shot-1-2","project-1",0.05);
  expect(queue.pending().map(item=>item.projectId).sort()).toEqual(["project-1","project-2"]);
  expect(queue.pending().find(item=>item.projectId==="project-1")!.score).toBe(0.05);
});
