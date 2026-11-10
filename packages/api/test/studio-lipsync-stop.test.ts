/**
 * HV-022-23 -- a studio work list refused part-way through always says what it already queued and holds.
 *
 * `studioLipSyncStop` decides the answer once a pass fails inside the admission loop. The passes before it are
 * committed with their holds, so after any admission every failure must answer (with the route attaching the
 * admitted list), and an unexpected failure keeps its 500 without exposing its own text.
 */
import {expect,test} from "bun:test";
import {studioLipSyncStop} from "../src/lipsync-api";
import {BudgetError} from "../../operator/src/index";
import {LipSyncError} from "../../planner/src/lipsync-policy";

test("a budget refusal is a 429 before or after an admission; a policy change is a 409",()=>{
  for(const progress of [false,true]){
    expect(studioLipSyncStop(new BudgetError("This film has reached its spending limit of $40.00"),progress)).toEqual({status:429,error:"This film has reached its spending limit of $40.00",reason:"budget_exhausted"});
    expect(studioLipSyncStop(new BudgetError("The lip-sync provider or price policy changed. Review a new pass."),progress)).toEqual({status:409,error:"The lip-sync provider or price policy changed. Review a new pass.",reason:"policy_changed"});
  }
});

test("before any admission, other failures are left to the route as they were",()=>{
  expect(studioLipSyncStop(new LipSyncError("This request key belongs to another pass."),false)).toBeUndefined();
  expect(studioLipSyncStop(new Error("connection terminated unexpectedly"),false)).toBeUndefined();
});

test("after an admission, a refused pass is a 207 and an unexpected failure a 500, both answered with what is held",()=>{
  expect(studioLipSyncStop(new LipSyncError("This request key belongs to another pass."),true)).toEqual({status:207,error:"This request key belongs to another pass."});
  const lost=studioLipSyncStop(new Error("connection terminated unexpectedly"),true)!;
  expect(lost.status).toBe(500);expect(lost.error).not.toContain("connection");expect(lost.error).toContain("queued and held");
  expect(studioLipSyncStop("not even an error",true)!.status).toBe(500);
});
