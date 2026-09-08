import {afterAll,beforeAll,expect,test} from "bun:test";
import {currentFilmSourceFixture} from "./current-film-source.fixture";
import {bindOriginalEditSource} from "../src/edit-jobs";
import {validateCurrentFilmJobPlan,type CurrentFilmJobV2} from "../src/current-film-jobs";
import {compileCurrentFilmMixedJob,validateCurrentFilmMixedJobPlan,type CurrentFilmReuseChoice,type CurrentFilmJobV3} from "../src/current-film-mixed-jobs";
import {contentHash as hash} from "../../generator/src/capabilities";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>;
beforeAll(async()=>{f=await currentFilmSourceFixture();},180000);
afterAll(async()=>{await f?.close();});
function choice(ordinal:number):CurrentFilmReuseChoice {
  const slot=f.plan.materialization.slots[ordinal]!,record=f.job.currentFilmCheckpoint!.rows[ordinal]!.record;
  return {ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}};
}
function mixed(){return compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[choice(0),choice(1)]});}
function reseal(value:CurrentFilmJobV3):CurrentFilmJobV3 {const {revision:_revision,...body}=value;return {...body,revision:hash(body)};}

test("mixed selection retains one original catalog entry and distinct reviewed slot choices without relabeling original execution",()=>{
  const before=hash({plan:f.plan,receipt:f.receipt}),plan=mixed();
  expect(plan.schema).toBe("hv-current-film-job/3");expect(plan.origins).toHaveLength(1);
  expect(plan.selection.filter(row=>row.kind==="reuse")).toHaveLength(2);
  expect(plan.selection.filter(row=>row.kind==="generate")).toHaveLength(f.plan.selection.length-2);
  expect(plan.origins[0]!.binding.source).toEqual(f.receipt);expect(plan.materialization).toEqual(f.plan.materialization);
  expect(plan.authority).toBe("historical-only");expect(validateCurrentFilmMixedJobPlan(plan)).toEqual(plan);
  expect(hash({plan:f.plan,receipt:f.receipt})).toBe(before);
  expect(()=>validateCurrentFilmJobPlan(plan as unknown as CurrentFilmJobV2)).toThrow();
},90000);

test("a changed source, duplicate or unused carrier never silently turns the selected take into fresh generation",()=>{
  const binding=bindOriginalEditSource(f.receipt),first=choice(0);
  expect(()=>compileCurrentFilmMixedJob(f.plan,{origins:[binding],choices:[]})).toThrow("unused");
  expect(()=>compileCurrentFilmMixedJob(f.plan,{origins:[binding,binding],choices:[first]})).toThrow("one carrier");
  expect(()=>compileCurrentFilmMixedJob(f.plan,{origins:[binding],choices:[first,first]})).toThrow("at most once");
  expect(()=>compileCurrentFilmMixedJob(f.plan,{origins:[],choices:[first]})).toThrow("origin changed");
  expect(()=>compileCurrentFilmMixedJob(f.plan,{origins:[binding],choices:[{...first,inputRevision:"f".repeat(64)}]})).toThrow("target input");
  const altered=structuredClone(first);altered.source.recordRevision="e".repeat(64);
  expect(()=>compileCurrentFilmMixedJob(f.plan,{origins:[binding],choices:[altered]})).toThrow();
},90000);

test("resealed mixed plans reject changed comparison, target order, source custody and selection policy",()=>{
  const plan=mixed();
  const mutations:((value:CurrentFilmJobV3)=>void)[]=[
    value=>{const selected=value.selection.find(row=>row.kind==="reuse")!;if(selected.kind==="reuse")selected.reviewRevision="f".repeat(64);},
    value=>{value.selection.reverse();},
    value=>{value.origins[0]!.binding.source.job.currentFilmCheckpoint!.rows[0]!.capture.observation.attempt++;},
    value=>{value.origins[0]!.id="e".repeat(64);},
    value=>{const selected=value.selection.find(row=>row.kind==="reuse")!;Object.assign(selected,{policy:"predict-a-new-generation"});},
  ];
  for(const mutate of mutations){const changed=structuredClone(plan);mutate(changed);expect(()=>validateCurrentFilmMixedJobPlan(reseal(changed))).toThrow();}
  const returned=validateCurrentFilmMixedJobPlan(plan);returned.origins[0]!.binding.source.facts.label="Changed caller copy";
  expect(validateCurrentFilmMixedJobPlan(plan)).toEqual(plan);
},90000);

test("all-fresh V3 planning remains explicit and descriptor checks precede cached historical validation",()=>{
  const plan=compileCurrentFilmMixedJob(f.plan,{origins:[],choices:[]});
  expect(plan.origins).toEqual([]);expect(plan.selection).toEqual(f.plan.selection);expect(validateCurrentFilmMixedJobPlan(plan)).toEqual(plan);
  let reads=0;const hostile=structuredClone(plan);Object.defineProperty(hostile,"origins",{enumerable:true,get(){reads++;return plan.origins;}});
  expect(()=>validateCurrentFilmMixedJobPlan(hostile)).toThrow();expect(reads).toBe(0);
  expect(()=>validateCurrentFilmMixedJobPlan({...plan,hidden:undefined} as CurrentFilmJobV3)).toThrow("exact");
},90000);
