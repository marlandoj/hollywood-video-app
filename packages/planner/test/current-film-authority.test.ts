import {afterAll,beforeAll,expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {ProjectService,type PersistedProject} from "../../api/src/index";
import {castingSnapshot,currentCasting} from "../src/casting";
import {currentDirection,directionSnapshot} from "../src/direction";
import {compileCurrentFilmJob,validateCurrentFilmJobPlan} from "../src/current-film-jobs";
import {assertCurrentFilmGenerationCurrent} from "../src/current-film-authority";
import {currentFilmAuthorityFixture,currentFilmAuthorityProposal} from "./current-film-authority.fixture";

let fixture:Awaited<ReturnType<typeof currentFilmAuthorityFixture>>,proposal:ReturnType<typeof currentFilmAuthorityProposal>,accepted:PersistedProject;
beforeAll(async()=>{fixture=await currentFilmAuthorityFixture(true);proposal=currentFilmAuthorityProposal(fixture.project,"selected",fixture.at+10);accepted=proposal.accept();},180000);
afterAll(async()=>{await fixture?.studio.close();});

test("real retained origin and saved pending target authorize full current content without publishing it",()=>{
  const {project,plan,at}=fixture,before=contentHash({project,plan:proposal.plan,state:proposal.project});
  expect(()=>assertCurrentFilmGenerationCurrent(plan,project,at+20)).not.toThrow();
  expect(()=>assertCurrentFilmGenerationCurrent(proposal.plan,proposal.project,at+20)).not.toThrow();
  expect(proposal.project.versions).toEqual(project.versions);expect(proposal.plan.materialization.script.text).toContain("Stay for a while.");
  const service=ProjectService.fromState({...fixture.studio.projects.snapshot(),projects:[proposal.project]});
  expect(()=>assertCurrentFilmGenerationCurrent(proposal.plan,service.peekProject(project.id),at+20)).not.toThrow();
  expect(contentHash({project,plan:proposal.plan,state:proposal.project})).toBe(before);
},60000);

test("unrelated appended proposals preserve selected current identity; unsaved and same-version different proposals do not",()=>{
  const other=currentFilmAuthorityProposal(proposal.project,"other",fixture.at+30,"Welcome back.\nA different proposal.\n");
  expect(other.project.currentScreenplay!.headRevision).toBe(proposal.project.currentScreenplay!.headRevision);
  expect(()=>assertCurrentFilmGenerationCurrent(proposal.plan,other.project,fixture.at+40)).not.toThrow();
  expect(()=>assertCurrentFilmGenerationCurrent(proposal.plan,fixture.project,fixture.at+40)).toThrow();
  const independent=currentFilmAuthorityProposal(fixture.project,"selected",fixture.at+10,"Welcome elsewhere.\nAnother version.\n");
  expect(independent.plan.materialization.script.version).toBe(proposal.plan.materialization.script.version);
  expect(()=>assertCurrentFilmGenerationCurrent(proposal.plan,independent.project,fixture.at+40)).toThrow();
},90000);

test("accepted head advances invalidate the old plan; a new accepted plan requires all exact durable versions",()=>{
  const plan=compileCurrentFilmJob(accepted.currentScreenplay!,{kind:"accepted",revision:accepted.currentScreenplay!.headRevision!},fixture.plan.request,fixture.at+40);
  expect(()=>assertCurrentFilmGenerationCurrent(proposal.plan,accepted,fixture.at+50)).toThrow();
  expect(()=>assertCurrentFilmGenerationCurrent(plan,accepted,fixture.at+50)).not.toThrow();
  for(const modify of [(p:PersistedProject)=>{p.versions.shift();},(p:PersistedProject)=>{p.versions.at(-1)!.createdAt=new Date(fixture.at+1).toISOString();},(p:PersistedProject)=>{p.versions.push({...p.versions.at(-1)!,parentVersion:p.versions.at(-1)!.version,version:p.versions.at(-1)!.version+1,text:"INT. OUTSIDE - DAY\nChanged."});}]){
    const changed=structuredClone(accepted);modify(changed);expect(()=>assertCurrentFilmGenerationCurrent(plan,changed,fixture.at+50)).toThrow(/durable|outside/);
  }
},60000);

test("current project, rights, time, exact cast and legacy direction are checked independently of historical replay",()=>{
  expect(validateCurrentFilmJobPlan(fixture.plan)).toEqual(fixture.plan);
  const variants:((p:PersistedProject)=>void)[]=[p=>{p.id="foreign-project";},p=>{delete p.currentScreenplay;},p=>{p.rightsAttestedAt=null;},p=>{p.rightsAttestedAt=new Date(fixture.at+1000).toISOString();},p=>{p.deleteAfter=new Date(fixture.at+2).toISOString();},
    p=>{const old=currentCasting(p.id,p.castingHistory),characters=structuredClone(old.characters);characters[0]!.appearance+=" Changed.";p.castingHistory!.push(castingSnapshot(p.id,old.version+1,characters,fixture.at+3));},
    p=>{p.castingHistory!.at(-1)!.createdAt=new Date(fixture.at+4).toISOString();},
    p=>{const old=currentDirection(p.id,p.directionHistory);p.directionHistory=[directionSnapshot(p.id,old.version+1,old.entries,fixture.at+3,old.sceneCuts)];}];
  for(const modify of variants){const project=structuredClone(fixture.project);modify(project);expect(()=>assertCurrentFilmGenerationCurrent(fixture.plan,project,fixture.at+20)).toThrow();}
  for(const now of [NaN,Infinity,-1,fixture.at])expect(()=>assertCurrentFilmGenerationCurrent(fixture.plan,fixture.project,now)).toThrow(/time/);
  expect(()=>assertCurrentFilmGenerationCurrent(fixture.plan,null,fixture.at+20)).toThrow(/unavailable/);
},60000);

test("present asset removal and actual actor expiry block a still-sealed plan; an original media URL expiry does not grant or obstruct all-fresh generation",()=>{
  const project=structuredClone(fixture.project);project.referenceAssets=[];
  expect(()=>assertCurrentFilmGenerationCurrent(fixture.plan,project,fixture.at+20)).toThrow(/catalog/);
  expect(()=>assertCurrentFilmGenerationCurrent(fixture.plan,fixture.project,fixture.at+45*86400000+1)).toThrow(/not permitted/);
  const originExpiry=Date.parse(fixture.plan.library.origin!.request.source.job.linkExpiresAt!);
  expect(originExpiry).toBeLessThan(fixture.at+45*86400000);
  expect(()=>assertCurrentFilmGenerationCurrent(fixture.plan,fixture.project,originExpiry+1)).not.toThrow();
},30000);

test("authority projection and plan reject getters without reads, oversized histories and mutation",()=>{
  let reads=0;const project=structuredClone(fixture.project);Object.defineProperty(project,"currentScreenplay",{enumerable:true,get(){reads++;return fixture.project.currentScreenplay;}});
  expect(()=>assertCurrentFilmGenerationCurrent(fixture.plan,project,fixture.at+20)).toThrow(/accessors/);expect(reads).toBe(0);
  const nested=structuredClone(fixture.project);Object.defineProperty(nested.referenceAssets![0]!,"sha256",{enumerable:true,get(){reads++;return "a".repeat(64);}});
  expect(()=>assertCurrentFilmGenerationCurrent(fixture.plan,nested,fixture.at+20)).toThrow(/accessors/);expect(reads).toBe(0);
  const history=structuredClone(fixture.project);history.versions=Array.from({length:100001},()=>fixture.project.versions[0]!);
  expect(()=>assertCurrentFilmGenerationCurrent(fixture.plan,history,fixture.at+20)).toThrow(/bounded|capacity/);
  const bad=structuredClone(fixture.plan);bad.materialization.slots[0]!.shot.prompt="Changed after admission";
  expect(()=>assertCurrentFilmGenerationCurrent(bad,fixture.project,fixture.at+20)).toThrow(/historical/);
},60000);
