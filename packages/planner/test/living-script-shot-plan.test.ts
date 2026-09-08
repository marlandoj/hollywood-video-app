import {beforeAll,afterAll,expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash} from "../../generator/src/capabilities";
import {parseFountain} from "../../parser/src/index";
import {type Job} from "../../queue/src/index";
import {bootstrapLivingScriptDocument,type LivingScriptDocumentSource} from "../src/living-script-document";
import {createLivingScriptStructureBase,livingScriptStructureLines,livingScriptStructureBlock as block,livingScriptStructureBoundary as boundary,compileLivingScriptStructure,type LivingScriptStructureOperation} from "../src/living-script-structure";
import {bootstrapLivingScriptShotPlan,validateLivingScriptShotPlan,reviewLivingScriptShotPlan,materializeLivingScriptBaseShots,LIVING_SCRIPT_SHOT_PLAN_LIMITS,type LivingScriptShotPlan} from "../src/living-script-shot-plan";
import {sourcePlan} from "../src/scene-cuts";
import {renderInputHash,renderShots,renderRecord} from "../src/shot-reuse";
import {editFactsRevision,editSourceAudio,editSourceVoiceWindows,editSourceKnownFiles,editSourceRequiredPaths,type EditSourceReceipt} from "../src/edit-sources";
import {EDIT_AUDIO_LANES} from "../src/edit-timeline";

const SCENE="INT. SAME - DAY\r\n[[Keep this note.]]\r\nSpud waves.\r\n\r\nSPUD\r\nWelcome to the garden.\r\nCUT TO:\r\nCome inside, friend.\r\n\r\nSpud opens the gate.\r\n\r\nSPUD\r\nWelcome again.\r\n\r\n";
const SCRIPT="Title: Physical coverage\r\n\r\n"+SCENE+SCENE+"INT. EMPTY - NIGHT\r\n";
let fixture:Awaited<ReturnType<typeof dubStudio>>,source:EditSourceReceipt,binding:LivingScriptDocumentSource,plan:LivingScriptShotPlan;
const root=(receipt:EditSourceReceipt)=>createLivingScriptStructureBase({projectId:receipt.job.projectId,version:receipt.job.scriptVersion,text:receipt.job.scriptText,locks:[]});
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;};
beforeAll(async()=>{
  fixture=await dubStudio(undefined,SCRIPT);source=await inspectEditSource(fixture.film,"Original legacy film",fixture.paths.artifactRoot,async()=>{});
  binding=bootstrapLivingScriptDocument(source,{base:root(source),ancestry:[]});plan=bootstrapLivingScriptShotPlan(source,binding);
},180000);
afterAll(async()=>{await fixture?.close();});
function changed(operations:LivingScriptStructureOperation[]){const base=root(source),patch=compileLivingScriptStructure(base,{baseRevision:base.revision,operations});return {patch,binding:bootstrapLivingScriptDocument(source,{base:patch.after,ancestry:[patch]})};}

test("actual legacy film retains ordered original records and reproduces default sourcePlan including continuation dialogue and heading fallback",()=>{
  const original=contentHash({source,binding}),expected=sourcePlan(parseFountain(source.job.scriptText),source.job.direction,7000,24),actual=materializeLivingScriptBaseShots(source,plan,binding),rendered=renderShots(source.job,Date.parse(source.job.startedAt!));
  expect(actual).toEqual(expected);expect(plan.shots).toHaveLength(5);expect(plan.provenanceComplete).toBe(true);expect(plan.reuseAuthority).toBe(false);expect(plan.issues).toEqual([]);
  expect(plan.shots.map(row=>row.originalOrdinal)).toEqual([0,1,2,3,4]);expect(plan.recordInventory.map(row=>row.revision)).toEqual(source.job.output!.shotRenders!.map(row=>row.revision));
  expect(plan.shots[0]!.recipe!.dialogue[0]!.beatIds).toHaveLength(2);expect(actual[0]!.dialogue[0]!.lines).toEqual(["Welcome to the garden.","Come inside, friend."]);
  expect(plan.shots[0]!.lines.map(row=>row.physicalLineId)).toHaveLength(3);expect(new Set(plan.shots.flatMap(row=>row.lines.map(line=>line.physicalLineId))).size).toBe(6);
  expect(plan.shots[0]!.lines.every(row=>row.entryId!==null)).toBe(true);expect(plan.shots.at(-1)!.recipe).toMatchObject({kind:"legacy-default/1",headingFallback:true,actionBeatIds:[]});
  for(const [i,row]of plan.shots.entries()){
    expect(row.base.shotRevision).toBe(contentHash(expected[i]));expect(row.directed.inputHash).toBe(renderInputHash(source.job,rendered[i]!));expect(row.actual!.seed).toBe(source.job.output!.shotRenders![i]!.clip.seed);
    expect(row.actual!.durationSec).toBe(source.job.output!.shotRenders![i]!.clip.durationSec);expect(row.windows.some(value=>value.window.evidence==="shot-coverage")).toBe(true);
  }
  expect(plan.shots[0]!.actual!.frames).not.toBe(plan.shots[0]!.base.requestedFrames);expect(contentHash({source,binding})).toBe(original);
  expect(validateLivingScriptShotPlan(source,JSON.parse(JSON.stringify(plan)))).toEqual(plan);
});

test("equal-text whole scenes reorder stable shot identities, original seeds and grouping without global replanning",()=>{
  const base=root(source),a=plan.rootDocument.scenes[0]!,b=plan.rootDocument.scenes[1]!,moved=changed([{id:"move-second",kind:"move",block:block(base,b.startLine,b.endLine),to:boundary(base,a.startLine)}]),review=reviewLivingScriptShotPlan(source,plan,moved.binding),actual=materializeLivingScriptBaseShots(source,plan,moved.binding),expected=sourcePlan(parseFountain(base.text),source.job.direction,7000,24);
  expect(review.materializable).toBe(true);expect(review.reuseAuthority).toBe(false);expect(review.shots.map(row=>row.currentOrdinal)).toEqual([2,3,0,1,4]);expect(review.shots.map(row=>row.status)).toEqual(["moved","moved","moved","moved","unchanged"]);
  expect(actual.map(row=>row.id)).toEqual(["shot-2-1","shot-2-2","shot-1-1","shot-1-2","shot-3-1"]);
  expect(actual.map(({sceneIndex:_index,...row})=>row)).toEqual([expected[2],expected[3],expected[0],expected[1],expected[4]].map(({sceneIndex:_index,...row})=>row));
  expect(actual.map(row=>row.sceneIndex)).toEqual([0,0,1,1,2]);expect(plan.shots[0]!.sceneId).not.toBe(plan.shots[2]!.sceneId);expect(plan.shots[0]!.id).not.toBe(plan.shots[2]!.id);
  expect(bootstrapLivingScriptShotPlan(source,moved.binding)).toEqual(plan);
});

test("physical line replacement and added dialogue membership are separate explicit conflicts, even for equal words",()=>{
  const base=root(source),line=plan.rootDocument.lines.find(row=>row.id===plan.shots[0]!.lines[0]!.physicalLineId)!;
  for(const text of [line.text,"Different words.\r\n"]){const result=changed([{id:"replace-line",kind:"replace",block:block(base,line.line,line.line+1),text}]),review=reviewLivingScriptShotPlan(source,plan,result.binding);
    expect(review.materializable).toBe(false);expect(review.conflicts.some(row=>row.code==="replaced-physical-line")).toBe(true);expect(()=>materializeLivingScriptBaseShots(source,plan,result.binding)).toThrow(/every structural/);
    expect(review.shots.filter(row=>row.sceneId===plan.shots[2]!.sceneId).every(row=>row.status==="unchanged")).toBe(true);
  }
  const result=changed([{id:"add-line",kind:"insert",at:boundary(base,line.line+1),text:"A new spoken line.\r\n"}]),review=reviewLivingScriptShotPlan(source,plan,result.binding);
  expect(review.conflicts.some(row=>row.code==="changed-line-membership")).toBe(true);expect(review.conflicts.some(row=>row.code==="replaced-physical-line")).toBe(false);expect(review.shots).toHaveLength(plan.shots.length);
});

test("inserted, replaced, removed and split scenes/beats retain complete conflict inventories without silently dropping shots",()=>{
  const base=root(source),first=plan.rootDocument.scenes[0]!,second=plan.rootDocument.scenes[1]!,last=plan.rootDocument.scenes[2]!;
  const cases:LivingScriptStructureOperation[][]=[
    [{id:"new-scene",kind:"insert",at:boundary(base,second.startLine),text:"INT. NEW - DAY\r\nNew action.\r\n\r\n"}],
    [{id:"replace-heading",kind:"replace",block:block(base,first.startLine,first.startLine+1),text:livingScriptStructureLines(base)[first.startLine-1]!.text}],
    [{id:"delete-scene",kind:"delete",block:block(base,last.startLine,last.endLine)}],
    [{id:"split-scene",kind:"insert",at:boundary(base,first.beats[2]!.startLine),text:"INT. SPLIT - DAY\r\n"}],
  ];
  for(const operations of cases){const result=changed(operations),review=reviewLivingScriptShotPlan(source,plan,result.binding);expect(review.materializable).toBe(false);expect(review.shots).toHaveLength(plan.shots.length);expect(review.conflicts.length).toBeGreaterThan(0);expect(()=>materializeLivingScriptBaseShots(source,plan,result.binding)).toThrow();}
  const added=reviewLivingScriptShotPlan(source,plan,changed(cases[0]!).binding);expect(added.introducedSceneIds).toHaveLength(1);
  const removed=reviewLivingScriptShotPlan(source,plan,changed(cases[2]!).binding);expect(removed.shots.at(-1)!.currentOrdinal).toBeNull();
});

test("within-scene action reorder and dialogue split/merge require explicit recipe review",()=>{
  const base=root(source),scene=plan.rootDocument.scenes[0]!,action=scene.beats.filter(beat=>beat.kind==="action"),moved=changed([{id:"move-action",kind:"move",block:block(base,action[1]!.startLine,action[1]!.endLine),to:boundary(base,action[0]!.startLine)}]);
  expect(reviewLivingScriptShotPlan(source,plan,moved.binding).conflicts.some(row=>row.code==="changed-beat-membership")).toBe(true);
  const transition=scene.beats.find(beat=>beat.kind==="transition")!,merged=changed([{id:"merge-dialogue",kind:"delete",block:block(base,transition.startLine,transition.endLine)}]);
  expect(merged.binding.document.relations.some(row=>row.treatment==="merged")).toBe(true);expect(reviewLivingScriptShotPlan(source,plan,merged.binding).materializable).toBe(false);
});

test("protected comment bytes survive while unsupported constructs remain explicit planning conflicts",()=>{
  const base=root(source),last=livingScriptStructureLines(base).length+1,result=changed([{id:"unbound",kind:"insert",at:boundary(base,last),text:"\r\n>>>UNSUPPORTED\r\n"}]),review=reviewLivingScriptShotPlan(source,plan,result.binding);
  expect(review.conflicts.some(row=>row.code==="unbound-document")).toBe(true);expect(review.materializable).toBe(false);expect(result.binding.document.context.base.text).toContain("[[Keep this note.]]\r\n");
});

/** Model a sealed historical metadata receipt; this helper does not claim to regenerate its bytes. */
function resealedSource(job:Job):EditSourceReceipt {
  const value=structuredClone(source);value.job=job;value.audio=editSourceAudio(job);value.facts={...value.facts,...editSourceVoiceWindows(job),audio:EDIT_AUDIO_LANES.filter(lane=>value.audio[lane])};
  const keep=new Set([...editSourceRequiredPaths(job),...editSourceKnownFiles(job).map(file=>file.path)]);value.files=value.files.filter(file=>keep.has(file.path));
  value.facts.revision=editFactsRevision(job,value.facts.frames,value.facts.width,value.facts.height,value.facts.captions);return reseal(value);
}
test("actual repair seed is independent of directed/base seed; an incomplete or reordered retained inventory never establishes full provenance",()=>{
  const job=structuredClone(source.job),record=job.output!.shotRenders![0]!,{schema:_schema,revision:_revision,...data}=record;job.output!.shotRenders![0]=renderRecord({...data,clip:{...record.clip,seed:record.clip.seed+10000}});
  const repaired=resealedSource(job),bound=bootstrapLivingScriptDocument(repaired,{base:root(repaired),ancestry:[]}),result=bootstrapLivingScriptShotPlan(repaired,bound);
  expect(result.shots[0]!.base.seed).toBe(plan.shots[0]!.base.seed);expect(result.shots[0]!.directed.seed).toBe(plan.shots[0]!.directed.seed);expect(result.shots[0]!.actual!.seed).toBe(plan.shots[0]!.actual!.seed+10000);expect(result.reuseAuthority).toBe(false);
  const missingJob=structuredClone(source.job);missingJob.output!.shotRenders!.pop();const missing=resealedSource(missingJob),missingBinding=bootstrapLivingScriptDocument(missing,{base:root(missing),ancestry:[]}),partial=bootstrapLivingScriptShotPlan(missing,missingBinding);
  expect(partial.shots).toHaveLength(5);expect(partial.recordInventory).toHaveLength(4);expect(partial.shots.at(-1)!.actual).toBeNull();expect(partial.provenanceComplete).toBe(false);expect(partial.issues.some(row=>row.code==="record-order")).toBe(true);expect(partial.issues.some(row=>row.code==="missing-record")).toBe(true);expect(partial.issues.some(row=>row.code==="unbound-source-clock")).toBe(true);
  const reorderedJob=structuredClone(source.job);reorderedJob.output!.shotRenders!.reverse();const reordered=resealedSource(reorderedJob),orderPlan=bootstrapLivingScriptShotPlan(reordered,bootstrapLivingScriptDocument(reordered,{base:root(reordered),ancestry:[]}));
  expect(orderPlan.recordInventory[0]!.shotId).toBe("shot-3-1");expect(orderPlan.provenanceComplete).toBe(false);expect(orderPlan.shots[0]!.actual!.recordOrdinal).toBe(4);
});

test("resealed plans cannot forge recipes, stable ancestry, seeds, actual records, windows or original order",()=>{
  const modifications=[(p:LivingScriptShotPlan)=>{p.shots[0]!.base.seed++;},(p:LivingScriptShotPlan)=>{p.shots[0]!.actual!.seed++;},(p:LivingScriptShotPlan)=>{p.shots[0]!.id="a".repeat(64);},(p:LivingScriptShotPlan)=>{p.shots[0]!.recipe!.dialogue[0]!.lineIds.reverse();},(p:LivingScriptShotPlan)=>{p.shots[0]!.windows[0]!.window.startSample++;},(p:LivingScriptShotPlan)=>{p.shots.reverse();},(p:LivingScriptShotPlan)=>{p.source.indexRevision="b".repeat(64);}];
  for(const mutate of modifications){const value=structuredClone(plan);mutate(value);expect(()=>validateLivingScriptShotPlan(source,reseal(value))).toThrow(/provenance changed/);}
  const stale=structuredClone(binding);stale.document.context.base.version++;expect(()=>reviewLivingScriptShotPlan(source,plan,stale)).toThrow();
  const foreign=structuredClone(source);foreign.job.projectId="foreign";expect(()=>validateLivingScriptShotPlan(foreign,plan)).toThrow();
  const otherVersion=createLivingScriptStructureBase({projectId:source.job.projectId,version:source.job.scriptVersion+1,text:source.job.scriptText,locks:[]});expect(()=>bootstrapLivingScriptDocument(source,{base:otherVersion,ancestry:[]})).toThrow(/exact document ancestry root/);
});

test("capacity, nonportable records, sparse arrays and hostile accessors fail before expensive compilation or field execution",()=>{
  const excessive=structuredClone(source);excessive.job.output!.shotRenders=Array(LIVING_SCRIPT_SHOT_PLAN_LIMITS.shots+1).fill(source.job.output!.shotRenders![0]!);expect(()=>bootstrapLivingScriptShotPlan(excessive,binding)).toThrow(/60-shot/);
  let calls=0;const accessor={...source,get job(){calls++;return source.job;}};expect(()=>bootstrapLivingScriptShotPlan(accessor,binding)).toThrow(/accessors/);expect(calls).toBe(0);
  const sparse=structuredClone(plan);delete sparse.shots[1];expect(()=>validateLivingScriptShotPlan(source,sparse)).toThrow(/dense/);
  const negative=structuredClone(plan);negative.shots[0]!.base.seed=-0;expect(()=>validateLivingScriptShotPlan(source,negative)).toThrow(/portable/);
  const hidden=structuredClone(plan);Object.defineProperty(hidden,"hidden",{value:true,enumerable:false});expect(()=>validateLivingScriptShotPlan(source,hidden)).toThrow(/hidden/);
  const derived=structuredClone(source);Object.assign(derived.job,{dialogueReplacement:null});expect(()=>bootstrapLivingScriptShotPlan(derived,binding)).toThrow(/direct original/);
  const count=structuredClone(plan);Object.assign(count,{excess:Array(LIVING_SCRIPT_SHOT_PLAN_LIMITS.nodes).fill(null)});expect(()=>validateLivingScriptShotPlan(source,count)).toThrow(/metadata capacity/);
});

test("actual authored coverage preserves notes, alternate anchors, grouping and directed versus planned durations on current-scene reorder",async()=>{
  const proposal=await(await fixture.call(fixture.base+"/direction/scene-cuts","POST",{sceneIndex:0,maxShots:24},fixture.owner.token)).json() as any;
  const cut=proposal.proposal.cut,shots=structuredClone(cut.shots);shots[0].notes="Hold the original physical action.";shots[0].durationFrames=60;
  shots.splice(1,0,{...structuredClone(shots[0]),id:"shot-1-99999",beatIds:[],afterBeatId:shots[0].beatIds.at(-1),coverage:{...shots[0].coverage,role:"reaction"},durationFrames:30,notes:"A silent response."});
  const reviewed=await(await fixture.call(fixture.base+"/direction/scene-cuts","POST",{sceneIndex:0,maxShots:24,binding:proposal.proposal.binding,edits:{shots,notes:"Retain complete physical coverage."}},fixture.owner.token)).json() as any;
  expect(reviewed.error).toBeUndefined();const accepted=await fixture.call(fixture.base+"/direction/scene-cuts/accept","POST",{proposal:reviewed.proposal,removeDirectionIds:reviewed.impact.removeDirectionIds},fixture.owner.token);expect(accepted.status).toBe(200);
  const direction=await(await fixture.call(fixture.base+"/direction","GET",undefined,fixture.owner.token)).json() as any,first=direction.plan.find((row:any)=>row.source.id===shots[0].id);
  const directed=await fixture.call(fixture.base+"/direction/"+first.source.id,"PUT",{settings:{durationFrames:90,seed:32123},expectedVersion:direction.direction.version,expectedScriptVersion:direction.scriptVersion,sourceHash:first.sourceHash},fixture.owner.token);expect(directed.status).toBe(200);
  const admitted=await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:"authored-shot-plan"},fixture.owner.token);expect(admitted.status).toBe(202);const film=await fixture.worker();expect(film?.failureReason).toBeUndefined();expect(film?.status).toBe("done");
  const receipt=await inspectEditSource(film!,"Authored retained film",fixture.paths.artifactRoot,async()=>{}),base=root(receipt),bound=bootstrapLivingScriptDocument(receipt,{base,ancestry:[]}),authored=bootstrapLivingScriptShotPlan(receipt,bound),actual=materializeLivingScriptBaseShots(receipt,authored,bound),expected=sourcePlan(parseFountain(base.text),film!.direction,7000,24);
  expect(actual).toEqual(expected);expect(authored.shots[0]!.base.requestedFrames).toBe(60);expect(authored.shots[0]!.directed.requestedFrames).toBe(90);expect(authored.shots[0]!.base.seed).not.toBe(32123);expect(authored.shots[0]!.directed.seed).toBe(32123);expect(authored.shots[0]!.actual!.seed).toBe(32123);
  expect(authored.shots[1]!.recipe).toMatchObject({kind:"authored-coverage/1",beatIds:[],shotNotes:"A silent response.",sceneNotes:"Retain complete physical coverage."});expect(actual[1]!.dialogue).toEqual([]);expect(actual[1]!.prompt).toContain("Silent alternate view after: Spud waves.");
  const scene=authored.rootDocument.scenes[0]!,last=livingScriptStructureLines(base).length+1,move=compileLivingScriptStructure(base,{baseRevision:base.revision,operations:[{id:"move-authored",kind:"move",block:block(base,scene.startLine,scene.endLine),to:boundary(base,last)}]}),moved=bootstrapLivingScriptDocument(receipt,{base:move.after,ancestry:[move]}),reordered=materializeLivingScriptBaseShots(receipt,authored,moved);
  expect(reviewLivingScriptShotPlan(receipt,authored,moved).materializable).toBe(true);expect(reordered.filter(row=>row.sceneIndex===2).map(({sceneIndex:_index,...row})=>row)).toEqual(expected.filter(row=>row.sceneIndex===0).map(({sceneIndex:_index,...row})=>row));
  expect(authored.recordInventory.map(row=>row.shotId)).toEqual(film!.output!.shotRenders!.map(row=>row.shotId));expect(validateLivingScriptShotPlan(receipt,authored)).toEqual(authored);
},180000);
