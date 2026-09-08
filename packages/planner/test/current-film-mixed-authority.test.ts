import {afterAll,beforeAll,expect,test} from "bun:test";
import {currentFilmSourceFixture} from "./current-film-source.fixture";
import {bindOriginalEditSource} from "../src/edit-jobs";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3} from "../src/current-film-mixed-jobs";
import {assertCurrentFilmMixedCurrent} from "../src/current-film-mixed-authority";
import {assertCurrentFilmGenerationCurrent} from "../src/current-film-authority";
import {contentHash as hash} from "../../generator/src/capabilities";
import {castingSnapshot,currentCasting} from "../src/casting";
import type {Job} from "../../queue/src/index";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,plan:CurrentFilmJobV3;
beforeAll(async()=>{
  f=await currentFilmSourceFixture();const ordinal=1,slot=f.plan.materialization.slots[ordinal]!,record=f.job.currentFilmCheckpoint!.rows[ordinal]!.record;
  plan=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[{ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,
    source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}}]});
},180000);
afterAll(async()=>{await f?.close();});

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
