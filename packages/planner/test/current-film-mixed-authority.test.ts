import {afterAll,beforeAll,expect,test} from "bun:test";
import {currentFilmSourceFixture} from "./current-film-source.fixture";
import {bindOriginalEditSource} from "../src/edit-jobs";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3} from "../src/current-film-mixed-jobs";
import {assertCurrentFilmMixedCurrent} from "../src/current-film-mixed-authority";
import {assertCurrentFilmGenerationCurrent,assertCurrentFilmMixedGenerationCurrent} from "../src/current-film-authority";
import {contentHash as hash} from "../../generator/src/capabilities";
import {castingSnapshot,currentCasting} from "../src/casting";
import type {Job} from "../../queue/src/index";
import {compileCurrentFilmJob} from "../src/current-film-jobs";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,plan:CurrentFilmJobV3;
beforeAll(async()=>{
  f=await currentFilmSourceFixture();const ordinal=1,slot=f.plan.materialization.slots[ordinal]!,record=f.job.currentFilmCheckpoint!.rows[ordinal]!.record;
  plan=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[{ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,
    source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}}]});
},180000);
afterAll(async()=>{await f?.close();});

test("mixed target authority returns detached plans on first and repeated validation without retaining caller changes",()=>{
  const now=Date.now(),target=compileCurrentFilmJob(f.plan.library,f.plan.selector,f.plan.request,now);
  // A newly compiled timestamped plan has not passed the mixed validator in
  // this test. The next call then exercises the successful full-body cache.
  const current=compileCurrentFilmMixedJob(target,{origins:plan.origins.map(origin=>origin.binding),choices:plan.selection.flatMap(row=>row.kind==="reuse"?[{
    ordinal:row.ordinal,inputRevision:row.inputRevision,originId:row.originId,source:row.source,
  }]:[])}),before=hash({current,project:f.project});
  const first=assertCurrentFilmMixedGenerationCurrent(current,f.project,now),second=assertCurrentFilmMixedGenerationCurrent(current,f.project,now);
  expect(first).toEqual(current);expect(second).toEqual(current);expect(first).not.toBe(current);expect(second).not.toBe(first);
  expect(first.origins[0]!.binding.source).not.toBe(current.origins[0]!.binding.source);
  expect(second.target.state.context.plan.document).not.toBe(first.target.state.context.plan.document);
  expect(second.materialization).not.toBe(current.materialization);
  first.origins[0]!.binding.source.facts.label="Returned source mutation";
  second.materialization.script.text="Returned screenplay mutation";
  expect(hash({current,project:f.project})).toBe(before);
  expect(assertCurrentFilmMixedGenerationCurrent(current,f.project,now)).toEqual(current);
  const changed=structuredClone(current);changed.selection[0]!.inputRevision="f".repeat(64);
  expect(changed.revision).toBe(current.revision);
  expect(()=>assertCurrentFilmMixedGenerationCurrent(changed,f.project,now)).toThrow();
  expect(assertCurrentFilmMixedGenerationCurrent(current,f.project,now)).toEqual(current);
},90000);

test("mixed target authority refuses real V2 plans instead of accepting a fresh-only fallback",()=>{
  const now=Date.now();expect(()=>assertCurrentFilmGenerationCurrent(f.plan,f.project,now)).not.toThrow();
  expect(()=>assertCurrentFilmMixedGenerationCurrent(f.plan as unknown as CurrentFilmJobV3,f.project,now)).toThrow("version-three");
  const changed=structuredClone(plan),{revision:_revision,...body}=changed;
  const wrongSchema={...body,schema:"hv-current-film-job/2"};
  expect(()=>assertCurrentFilmMixedGenerationCurrent({...wrongSchema,revision:hash(wrongSchema)} as unknown as CurrentFilmJobV3,f.project,now)).toThrow("version-three");
  expect(()=>assertCurrentFilmMixedGenerationCurrent(null as unknown as CurrentFilmJobV3,f.project,now)).toThrow();
},90000);

test("mixed target authority rejects schema and nested getters without invoking them even after a warm result",()=>{
  const now=Date.now();assertCurrentFilmMixedGenerationCurrent(plan,f.project,now);let reads=0;
  const schema=structuredClone(plan);Object.defineProperty(schema,"schema",{enumerable:true,get(){reads++;return plan.schema;}});
  expect(()=>assertCurrentFilmMixedGenerationCurrent(schema,f.project,now)).toThrow("portable");expect(reads).toBe(0);
  const nested=structuredClone(plan);Object.defineProperty(nested.origins[0]!.binding.source.facts,"label",{enumerable:true,get(){reads++;return "Untrusted source label";}});
  expect(()=>assertCurrentFilmMixedGenerationCurrent(nested,f.project,now)).toThrow("portable");expect(reads).toBe(0);
  const project=structuredClone(f.project);Object.defineProperty(project.versions[0]!,"text",{enumerable:true,get(){reads++;return "Untrusted current version";}});
  expect(()=>assertCurrentFilmMixedGenerationCurrent(plan,project,now)).toThrow("accessors");expect(reads).toBe(0);
  const hidden=structuredClone(plan);Object.defineProperty(hidden,"selection",{value:hidden.selection,enumerable:false});
  expect(()=>assertCurrentFilmMixedGenerationCurrent(hidden,f.project,now)).toThrow("portable");
  const extra=structuredClone(plan);Object.defineProperty(extra,"unreviewed",{value:undefined,enumerable:true});
  expect(JSON.stringify(extra)).toBe(JSON.stringify(plan));expect(()=>assertCurrentFilmMixedGenerationCurrent(extra,f.project,now)).toThrow("exact");
},90000);

test("a warm mixed target result does not preserve revoked project rights or expired retention",()=>{
  const now=Date.now(),project=structuredClone(f.project),rights=project.rightsAttestedAt,expiry=project.deleteAfter;
  expect(assertCurrentFilmMixedGenerationCurrent(plan,project,now)).toEqual(plan);
  project.rightsAttestedAt=null;
  expect(()=>assertCurrentFilmMixedGenerationCurrent(plan,project,now)).toThrow("rights or retention");
  project.rightsAttestedAt=rights;expect(assertCurrentFilmMixedGenerationCurrent(plan,project,now)).toEqual(plan);
  project.deleteAfter=new Date(now).toISOString();
  expect(()=>assertCurrentFilmMixedGenerationCurrent(plan,project,now)).toThrow("rights or retention");
  project.deleteAfter=expiry;
  expect(()=>assertCurrentFilmMixedGenerationCurrent(plan,project,Date.parse(expiry))).toThrow("rights or retention");
  expect(assertCurrentFilmMixedGenerationCurrent(plan,project,now)).toEqual(plan);
  const cast=currentCasting(project.id,project.castingHistory),characters=structuredClone(cast.characters);
  characters[0]!.permission.status="revoked";project.castingHistory!.push(castingSnapshot(project.id,cast.version+1,characters,now));
  expect(()=>assertCurrentFilmMixedGenerationCurrent(plan,project,now)).toThrow();
  expect(assertCurrentFilmMixedGenerationCurrent(plan,f.project,now)).toEqual(plan);
},90000);

test("mixed authority checks the exact current target and every distinct held carrier without mutating historical evidence",()=>{
  const before=hash({plan,project:f.project,source:f.job}),now=Date.now();
  expect(()=>assertCurrentFilmGenerationCurrent(plan,f.project,now)).not.toThrow();
  expect(()=>assertCurrentFilmMixedCurrent(plan,f.project,[f.job],now)).not.toThrow();
  expect(()=>assertCurrentFilmMixedCurrent(plan,f.projects.peekProject(f.project.id),[f.job],now)).not.toThrow();
  expect(hash({plan,project:f.project,source:f.job})).toBe(before);
  const allFresh=compileCurrentFilmMixedJob(f.plan,{origins:[],choices:[]});
  expect(()=>assertCurrentFilmMixedCurrent(allFresh,f.project,[],now)).not.toThrow();
  expect(()=>assertCurrentFilmMixedCurrent(allFresh,f.project,[f.job],now)).toThrow();
},90000);

test("a matching historical reuse review does not preserve expired, missing or changed carrier availability",()=>{
  const now=Date.now();assertCurrentFilmMixedCurrent(plan,f.project,[f.job],now);
  expect(()=>assertCurrentFilmMixedCurrent(plan,f.project,[],now)).toThrow();
  expect(()=>assertCurrentFilmMixedCurrent(plan,f.project,[f.job,f.job],now)).toThrow();
  expect(()=>assertCurrentFilmMixedCurrent(plan,f.project,[{...f.job,id:"other-carrier"}],now)).toThrow("exact owning project");
  expect(()=>assertCurrentFilmMixedCurrent(plan,f.project,[f.job],Date.parse(f.job.linkExpiresAt!))).toThrow();
  const changed=structuredClone(f.job);changed.output!.currentFilm!.assembly.frames++;
  expect(()=>assertCurrentFilmMixedCurrent(plan,f.project,[changed],now)).toThrow();
},90000);

test("mixed permission is fresh after warm checks and an accepted new head requires a newly reviewed target",()=>{
  const now=Date.now();assertCurrentFilmMixedCurrent(plan,f.project,[f.job],now);
  expect(()=>assertCurrentFilmMixedCurrent(plan,{...f.project,rightsAttestedAt:null},[f.job],now)).toThrow();
  expect(()=>assertCurrentFilmMixedCurrent(plan,{...f.project,deleteAfter:new Date(now).toISOString()},[f.job],now)).toThrow();
  const project=structuredClone(f.project),cast=currentCasting(project.id,project.castingHistory),characters=structuredClone(cast.characters);
  characters[0]!.permission.status="revoked";project.castingHistory!.push(castingSnapshot(project.id,cast.version+1,characters,now));
  expect(()=>assertCurrentFilmMixedCurrent(plan,project,[f.job],now)).toThrow();
  expect(()=>assertCurrentFilmMixedCurrent(plan,f.accept(now),[f.job],now+1)).toThrow();
},90000);

test("mixed authority checks descriptors before reading target, project or carrier fields",()=>{
  let reads=0;const now=Date.now(),target=structuredClone(plan);
  Object.defineProperty(target,"schema",{enumerable:true,get(){reads++;return plan.schema;}});
  expect(()=>assertCurrentFilmGenerationCurrent(target,f.project,now)).toThrow("accessors");
  const project=structuredClone(f.project);Object.defineProperty(project,"currentScreenplay",{enumerable:true,get(){reads++;return f.project.currentScreenplay;}});
  expect(()=>assertCurrentFilmMixedCurrent(plan,project,[f.job],now)).toThrow("accessors");
  const carrier=structuredClone(f.job);Object.defineProperty(carrier,"id",{enumerable:true,get(){reads++;return f.job.id;}});
  expect(()=>assertCurrentFilmMixedCurrent(plan,f.project,[carrier],now)).toThrow("portable");
  expect(reads).toBe(0);
  expect(()=>assertCurrentFilmMixedCurrent(plan,f.project,{length:0} as Job[],now)).toThrow();
},90000);
