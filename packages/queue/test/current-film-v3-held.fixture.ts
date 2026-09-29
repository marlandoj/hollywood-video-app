import {expect} from "bun:test";
import {DurableJobStore,type Job,type JobInput} from "../src/index";
import {assertCurrentFilmMixedAdmission,validateCurrentFilmMixedJob,type CurrentFilmMixedJob,type CurrentFilmMixedJobInput} from "../../planner/src/current-film-mixed-job-context";
import {currentFilmV3Job} from "../../planner/src/current-film-runtime-context";

/** Admission still refuses V3 until the mixed worker increment. These build the
 * exact records `enqueue` and `claimNext` would create, after the complete V3
 * admission check, so tests exercise held V3 custody without the store's approval. */
export function queuedCurrentFilmV3(input:JobInput,now=Date.now()):CurrentFilmMixedJob {
  expect(()=>DurableJobStore.fromJobs([]).enqueue(input)).toThrow();
  assertCurrentFilmMixedAdmission(input as CurrentFilmMixedJobInput,undefined,now);
  const job:Job={...structuredClone(input),status:"queued",queueAction:input.queueAction??"run",queueReason:input.queueReason??"capacity_available",queuedBehind:[],
    checkpointFrame:0,checkpointShots:0,retriesUsed:0,costUsd:0,nextEligibleAt:null,startedAt:null,leaseExpiresAt:null,claimedBy:null,resumedCount:0,
    completedAt:null,linkExpiresAt:null,notifications:[]};
  return currentFilmV3Job(job);
}
export function heldCurrentFilmV3(input:JobInput,now:number,workerId:string,leaseMs:number):CurrentFilmMixedJob {
  const queued=queuedCurrentFilmV3(input,now);
  expect(()=>DurableJobStore.fromJobs([queued as unknown as Job]).claimNext(now,{},{workerId,leaseMs})).toThrow();
  const held={...queued,status:"running" as const,startedAt:new Date(now).toISOString(),nextEligibleAt:null,leaseExpiresAt:new Date(now+leaseMs).toISOString(),claimedBy:workerId};
  validateCurrentFilmMixedJob(held);return held;
}
