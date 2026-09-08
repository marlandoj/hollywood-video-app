import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import type {SQL as Transaction} from "bun";
import type {Job,JobInput} from "../../queue/src/index";
import type {AnimaticApproval} from "../../api/src/index";
import {createProviderPlan} from "../../generator/src/catalog";
import {compileCurrentFilmJob} from "../../planner/src/current-film-jobs";
import * as context from "../../planner/src/current-film-job-context";
import {currentFilmAuthorityFixture} from "../../planner/test/current-film-authority.fixture";
import {assertCurrentFilmTransaction} from "../src/current-film-context";

let fixture:Awaited<ReturnType<typeof currentFilmAuthorityFixture>>,preview:JobInput,final:JobInput;
beforeAll(async()=>{
  fixture=await currentFilmAuthorityFixture();const plan=fixture.plan;
  preview={id:crypto.randomUUID(),projectId:plan.projectId,idempotencyKey:"authority-preview",currentFilm:plan,stage:"animatic",tier:plan.render.tier,scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,
    casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,rightsAttestedAt:fixture.project.rightsAttestedAt!,animaticJobId:null,animaticApprovedAt:null,totalFrames:plan.materialization.requestedFrames,
    costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:1,backoffMs:0},timeoutMs:60000};
  const finalPlan=compileCurrentFilmJob(fixture.project.currentScreenplay!,plan.selector,{role:"render",tier:"free",providerPlan:createProviderPlan("final",5,undefined,{HV_PROVIDER_POOL:'["mock"]'})},fixture.at+2);
  final={...structuredClone(preview),id:crypto.randomUUID(),idempotencyKey:"authority-final",currentFilm:finalPlan,stage:"final",providerPlan:finalPlan.render.providerPlan,totalFrames:finalPlan.materialization.requestedFrames,animaticJobId:preview.id,animaticApprovedAt:new Date(fixture.at+3).toISOString()};
},180000);
afterAll(async()=>{await fixture?.studio.close();});
function transaction(result:Job|undefined){const calls:{sql:string;values:unknown[]}[]=[];
  const tx=(async(parts:TemplateStringsArray,...values:unknown[])=>{calls.push({sql:parts.join("?"),values});return result?[{body:result}]:[];}) as unknown as Transaction;
  return {tx,calls};
}

test("ordinary jobs do not enter V2; current fresh preview validates locked authority without original carrier SQL",async()=>{
  const fake=transaction(undefined);
  await assertCurrentFilmTransaction(fake.tx,fixture.studio.film,undefined,fixture.at+20);expect(fake.calls).toEqual([]);
  await assertCurrentFilmTransaction(fake.tx,preview,fixture.project,fixture.at+20);expect(fake.calls).toEqual([]);
  const project=structuredClone(fixture.project);project.rightsAttestedAt=null;
  await expect(assertCurrentFilmTransaction(fake.tx,preview,project,fixture.at+20)).rejects.toThrow(/rights/);expect(fake.calls).toEqual([]);
},60000);

test("final locks only its exact owned preview and ordinary output or absent preview cannot approve V2",async()=>{
  const fake=transaction(fixture.studio.film),ordinary:AnimaticApproval={animaticJobId:preview.id,scriptVersion:preview.scriptVersion,decision:"approved",note:"Ordinary review has no V2 binding",at:new Date(fixture.at+3).toISOString()};
  await expect(assertCurrentFilmTransaction(fake.tx,final,{...fixture.project,animaticApprovals:[ordinary]},fixture.at+20)).rejects.toThrow(/version-two/);
  expect(fake.calls).toHaveLength(1);expect(fake.calls[0]!.sql).toContain("project_id=? and id=? for share");expect(fake.calls[0]!.values).toEqual([final.projectId,final.animaticJobId]);
  const absent=transaction(undefined);await expect(assertCurrentFilmTransaction(absent.tx,final,fixture.project,fixture.at+20)).rejects.toThrow(/approval|preview/);
  const project=structuredClone(fixture.project);project.rightsAttestedAt=null;const denied=transaction(undefined);
  await expect(assertCurrentFilmTransaction(denied.tx,final,project,fixture.at+20)).rejects.toThrow(/rights/);expect(denied.calls).toEqual([]);
},60000);

test("transaction hands the last matching saved decision to the V2 approval guard, retaining other previews separately",async()=>{
  // Orchestration-only unit evidence: deliberately stop at the real approval boundary. This
  // test does not fabricate a V2 output or claim the old fixture film was rendered as V2.
  const approved:AnimaticApproval={animaticJobId:preview.id,scriptVersion:preview.scriptVersion,decision:"approved",note:"Earlier",at:new Date(fixture.at+3).toISOString()};
  const latest:AnimaticApproval={...approved,decision:"changes_requested",note:"Current decision",at:new Date(fixture.at+4).toISOString()};
  const unrelated:AnimaticApproval={...approved,animaticJobId:crypto.randomUUID(),note:"Another preview"};
  const project={...fixture.project,animaticApprovals:[approved,latest,unrelated]},fake=transaction(fixture.studio.film),seen:unknown[]=[];
  const boundary=spyOn(context,"assertCurrentFilmPreviewApproval").mockImplementation((job,render,decision,now)=>{seen.push({job,render,decision,now});throw new Error("approval-boundary-stop");});
  try{await expect(assertCurrentFilmTransaction(fake.tx,final,project,fixture.at+20)).rejects.toThrow("approval-boundary-stop");expect(seen).toEqual([{job:final,render:fixture.studio.film,decision:latest,now:fixture.at+20}]);}
  finally{boundary.mockRestore();}
  expect(project.animaticApprovals).toEqual([approved,latest,unrelated]);expect(fake.calls).toHaveLength(1);
},30000);

test("malformed V2 marker and accessor never fall through to ordinary transaction behavior",async()=>{
  const fake=transaction(undefined),malformed={...fixture.studio.film,currentFilm:null} as unknown as Job;
  await expect(assertCurrentFilmTransaction(fake.tx,malformed,fixture.project,fixture.at+20)).rejects.toThrow(/version-two/);
  let reads=0;const getter={...fixture.studio.film};Object.defineProperty(getter,"currentFilm",{enumerable:true,get(){reads++;return fixture.plan;}});
  await expect(assertCurrentFilmTransaction(fake.tx,getter,fixture.project,fixture.at+20)).rejects.toThrow(/accessors/);expect(reads).toBe(0);expect(fake.calls).toEqual([]);
});
