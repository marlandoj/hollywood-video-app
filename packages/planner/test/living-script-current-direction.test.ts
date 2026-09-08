import {afterAll,beforeAll,expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash as hash} from "../../generator/src/capabilities";
import {bootstrapLivingScriptDocument,compileLivingScriptDocument} from "../src/living-script-document";
import {bootstrapLivingScriptShotPlan} from "../src/living-script-shot-plan";
import {bootstrapCurrentShotPlan,materializeCurrentShotPlan,proposeShotPlanEvolution} from "../src/living-script-current-plan";
import {createLivingScriptStructureBase,compileLivingScriptStructure,livingScriptStructureBlock as block,livingScriptStructureBoundary as boundary,type LivingScriptStructureOperation} from "../src/living-script-structure";
import {bootstrapCurrentDirection,validateCurrentDirection,createCurrentDirectionRequest,reviewCurrentDirection,applyCurrentDirection,type CurrentDirectionContext,type CurrentDirectionSnapshot,type CurrentDirectionRequest} from "../src/living-script-current-direction";
import {directionSettings,directShots} from "../src/direction";
import {lineSources,lineDirections,compilePerformances,voiceProfile} from "../src/performances";
import {proposeLivingScriptCastOrigin,compileLivingScriptCastRebind} from "../src/living-script-cast-rebind";
import {renderCurrentScreenplay} from "../src/living-script-current-render";
import {renderShots} from "../src/shot-reuse";
import {pictureBaseRevision} from "../src/picture-performance";
import {parseFountain} from "../../parser/src/index";
import {castingSnapshot} from "../src/casting";

const SCENE="INT. SAME - DAY\r\nSpud waves.\r\n\r\nSPUD\r\nWelcome, friend.\r\nCome inside.\r\n\r\n";
let fixture:Awaited<ReturnType<typeof dubStudio>>,root:CurrentDirectionContext,initial:CurrentDirectionSnapshot,directed:CurrentDirectionSnapshot;
const material=(state:CurrentDirectionContext)=>materializeCurrentShotPlan(state.plan,state.plan.document,state.lineage,state.originals);
const choices=(extra:Partial<Pick<CurrentDirectionRequest,"id"|"settings"|"lines"|"retired">>={})=>({id:"direction-review",settings:[],lines:[],retired:[],...extra});
function review(before:CurrentDirectionContext,after:CurrentDirectionContext,snapshot:CurrentDirectionSnapshot,extra:Parameters<typeof choices>[0]={}){
  return reviewCurrentDirection({before,after,snapshot,request:createCurrentDirectionRequest(snapshot,after.plan,choices(extra))});
}
function evolve(before:CurrentDirectionContext,operations:LivingScriptStructureOperation[],requestId="evolve"):CurrentDirectionContext {
  const base=before.plan.document.context.base,patch=compileLivingScriptStructure(base,{baseRevision:base.revision,operations}),afterDocument=compileLivingScriptDocument({base:patch.after,ancestry:[...before.plan.document.context.ancestry,patch]});
  const proposal=proposeShotPlanEvolution({previous:before.plan,lineage:before.lineage,originals:before.originals,beforeDocument:before.plan.document,afterDocument,capacity:{tier:"free",maxShots:24},requestId});
  expect(proposal.review.conflicts).toEqual([]);return {plan:proposal.review.candidate!,lineage:proposal.review.proposedLineage!,originals:before.originals};
}
beforeAll(async()=>{
  fixture=await dubStudio(undefined,SCENE+SCENE);const source=await inspectEditSource(fixture.film,"Direction original",fixture.paths.artifactRoot,async()=>{}),base=createLivingScriptStructureBase({projectId:source.job.projectId,version:source.job.scriptVersion,text:source.job.scriptText,locks:[]}),binding=bootstrapLivingScriptDocument(source,{base,ancestry:[]});
  root={...bootstrapCurrentShotPlan(source,bootstrapLivingScriptShotPlan(source,binding),binding),originals:[source]};initial=bootstrapCurrentDirection(root);
  const spoken=lineSources(material(root)[0]!.dialogue),settings=directionSettings({seed:909,durationFrames:90,performance:"A warm welcome.",lines:lineDirections(spoken.map(line=>({index:line.index,sourceHash:line.hash,pitch:line.index?44:66,beforeMs:line.index?90:130,notes:line.index?"Quiet invitation.":"Warm."})))});
  const proposal=review(root,root,initial,{settings:[{shotId:root.plan.shots[0]!.id,settings}]});expect(proposal.conflicts).toEqual([]);directed=proposal.candidate!;
},180000);
afterAll(async()=>{await fixture?.close();});

test("original implicit directions preserve legacy base behavior; explicit current overrides preserve inherited character voices",()=>{
  const base=material(root),original=root.originals[0]!.job.direction;expect(applyCurrentDirection(initial,root,base)).toEqual(original?directShots(base,original):base);
  expect(initial.entries.every(row=>row.settings===null)).toBe(true);expect(validateCurrentDirection(JSON.parse(JSON.stringify(directed)),root)).toEqual(directed);
  const voice=voiceProfile({voice:"en-gb",rateWpm:188}),resolved=base.map(shot=>({...shot,performances:compilePerformances(shot.dialogue,undefined).map(line=>({...line,voice}))})),result=applyCurrentDirection(directed,root,resolved);
  expect(result[0]!.seed).toBe(909);expect(result[0]!.durationSec).toBe(3);expect(result[0]!.performances![0]!.voice).toMatchObject({voice:"en-gb",rateWpm:188,pitch:66});expect(result[0]!.performances![1]!.beforeMs).toBe(90);
  expect(result[1]).toEqual(resolved[1]);expect(result[0]!.directionRevision).toBe(directed.revision);expect(base[0]!.seed).not.toBe(909);
  expect(()=>applyCurrentDirection(directed,root,result)).toThrow(/resolved shot|once/);
  const altered=structuredClone(base);altered[0]!.seed++;expect(()=>applyCurrentDirection(directed,root,altered)).toThrow(/resolved shot/);
});

test("equal-text scene reorder preserves physical settings and provider-visible IDs, then inserting a line rebinds local indices only",()=>{
  const scene=root.plan.document.scenes[1]!,base=root.plan.document.context.base,moved=evolve(root,[{id:"move-scene",kind:"move",block:block(base,scene.startLine,scene.endLine),to:boundary(base,1)}]),moveReview=review(root,moved,directed),snapshot=moveReview.candidate!;
  expect(moveReview.conflicts).toEqual([]);expect(snapshot.entries[1]!.shotId).toBe(directed.entries[0]!.shotId);expect(snapshot.entries[1]!.settings).toEqual(directed.entries[0]!.settings);
  const oldLine=snapshot.entries[1]!.lines[0]!,physical=moved.plan.document.lines.find(line=>line.id===oldLine.lineId)!,inserted=evolve(moved,[{id:"insert-before",kind:"insert",at:boundary(moved.plan.document.context.base,physical.line),text:"The gate is open.\r\n"}],"insert-plan"),next=review(moved,inserted,snapshot);
  expect(next.conflicts).toEqual([]);const entry=next.candidate!.entries.find(row=>row.shotId===oldLineShot())!;
  expect(entry.lines.map(line=>line.index)).toEqual([1,2]);expect(entry.lines.map(line=>line.lineId)).toEqual(directed.entries[0]!.lines.map(line=>line.lineId));expect(entry.settings!.lines!.map(line=>line.pitch)).toEqual([66,44]);
  expect(applyCurrentDirection(next.candidate!,inserted,material(inserted))[1]!.performances!.map(line=>line.beforeMs)).toEqual([0,130,90]);
  function oldLineShot(){return directed.entries[0]!.shotId;}
});

test("multiline replacement never matches equal words; explicit one-to-many transfer preserves controls and exact new hashes",()=>{
  const old=directed.entries[0]!.lines[0]!,physical=root.plan.document.lines.find(line=>line.id===old.lineId)!,after=evolve(root,[{id:"replace",kind:"replace",block:block(root.plan.document.context.base,physical.line,physical.line+1),text:"Welcome, friend.\r\nStay for a while.\r\n"}]),refused=review(root,after,directed);
  expect(refused.candidate).toBeNull();expect(refused.conflicts).toEqual([expect.objectContaining({code:"line-review",lineId:old.lineId})]);
  const row=after.plan.shots[0]!,targets=row.recipe.dialogue[0]!.lineIds.slice(0,2).map(lineId=>({shotId:row.id,lineId})),approved=review(root,after,directed,{lines:[{shotId:row.id,lineId:old.lineId,targets,reason:"Apply the same warm delivery to both newly authored lines."}]});
  expect(approved.conflicts).toEqual([]);expect(approved.candidate!.entries[0]!.settings!.lines!.map(line=>line.pitch)).toEqual([66,66,44]);
  expect(approved.candidate!.entries[0]!.lines.map(line=>line.sourceHash)).toEqual(lineSources(material(after)[0]!.dialogue).map(line=>line.hash));
  expect(approved.changes.filter(row=>row.kind==="line-transferred")).toHaveLength(2);expect(directed.entries[0]!.lines[0]!.lineId).toBe(old.lineId);
});

test("new parenthetical cues require review even when physical spoken lines survive",()=>{
  const line=root.plan.document.lines.find(row=>row.id===directed.entries[0]!.lines[0]!.lineId)!,after=evolve(root,[{id:"cue",kind:"insert",at:boundary(root.plan.document.context.base,line.line),text:"(whispering)\r\n"}]),proposal=review(root,after,directed);
  expect(proposal.candidate).toBeNull();expect(proposal.conflicts.filter(row=>row.code==="line-review")).toHaveLength(2);
  const explicit=review(root,after,directed,{lines:directed.entries[0]!.lines.map(line=>({shotId:directed.entries[0]!.shotId,lineId:line.lineId,targets:[],reason:"Use the character's scene voice with the new whispered cue; remove local overrides."}))});
  expect(explicit.conflicts).toEqual([]);expect(explicit.candidate!.entries[0]!.settings!.lines).toEqual([]);expect(explicit.candidate!.entries[0]!.settings!.performance).toBe("A warm welcome.");
});

test("retired saved direction and line overrides each require explicit disposal; new opaque-ID shots receive implicit settings",()=>{
  const first=root.plan.document.scenes[0]!,after=evolve(root,[{id:"replace-scene",kind:"replace",block:block(root.plan.document.context.base,first.startLine,first.endLine),text:"EXT. NEW - NIGHT\r\nSpud looks up.\r\n\r\n"}]),refused=review(root,after,directed);
  expect(refused.candidate).toBeNull();expect(refused.conflicts.some(row=>row.code==="retired-settings")).toBe(true);
  const old=directed.entries[0]!,explicit=review(root,after,directed,{retired:[{shotId:old.shotId,reason:"Retire this scene's prior artistic direction."}],lines:old.lines.map(line=>({shotId:old.shotId,lineId:line.lineId,targets:[],reason:"The spoken line was removed from this version."}))});
  expect(explicit.conflicts).toEqual([]);expect(explicit.candidate!.entries[0]!.renderId).toMatch(/^shot-v2-/);expect(explicit.candidate!.entries[0]!.settings).toBeNull();
  expect(applyCurrentDirection(explicit.candidate!,after,material(after))[0]!.id).toBe(after.plan.shots[0]!.renderId);
});

test("cross-shot explicit transfer is supported; duplicate targets, stale baselines and unrelated equal-word targets cannot silently inherit",()=>{
  const old=directed.entries[0]!,target=root.plan.shots[1]!,lineId=target.recipe.dialogue[0]!.lineIds[0]!,move={shotId:old.shotId,lineId:old.lines[0]!.lineId,targets:[{shotId:target.id,lineId}],reason:"Use this explicitly selected performance on the second scene."};
  const result=review(root,root,directed,{lines:[move]});expect(result.conflicts).toEqual([]);expect(result.candidate!.entries[0]!.settings!.lines).toHaveLength(1);expect(result.candidate!.entries[1]!.lines[0]!.lineId).toBe(lineId);
  expect(()=>review(root,root,directed,{lines:[move,{...move,lineId:old.lines[1]!.lineId}]})).toThrow(/Multiple old performances/);
  expect(()=>review(root,root,directed,{lines:[{...move,lineId:"a".repeat(64)}]})).toThrow(/existing saved/);
  const request=createCurrentDirectionRequest(initial,root.plan,choices());expect(()=>reviewCurrentDirection({before:root,after:root,snapshot:directed,request})).toThrow(/baseline changed/);
});

test("full explicit replacement can reset directions; resealed physical source forgery and nonportable data are rejected",()=>{
  const reset=review(root,root,directed,{settings:[{shotId:directed.entries[0]!.shotId,settings:null}]});expect(reset.conflicts).toEqual([]);expect(reset.candidate).toEqual(initial);
  const forged=structuredClone(directed);forged.entries[0]!.lines[0]!.lineId=directed.entries[0]!.lines[1]!.lineId;const {revision:_revision,...body}=forged;forged.revision=hash(body);expect(()=>validateCurrentDirection(forged,root)).toThrow(/exact current/);
  const resolved=material(root);resolved.reverse();expect(()=>applyCurrentDirection(directed,root,resolved)).toThrow(/resolved shot/);
  let reads=0;const hostile={...root,get plan(){reads++;return root.plan;}};expect(()=>bootstrapCurrentDirection(hostile)).toThrow(/accessors/);expect(reads).toBe(0);
  const sparse=structuredClone(directed);delete sparse.entries[0];expect(()=>validateCurrentDirection(sparse,root)).toThrow(/dense/);
});

test("complete effective current rendering preserves legacy root inputs, cast permissions and reviewed picture/line controls after a scene move",()=>{
  const source=root.originals[0]!.job,casting=source.casting!,at=Date.parse(source.startedAt!),origin=proposeLivingScriptCastOrigin(root.plan.document,casting),current={documentRevision:root.plan.document.revision,casting};
  const unchanged=compileLivingScriptCastRebind({before:root.plan.document,after:root.plan.document,casting,origin},at);
  expect(renderCurrentScreenplay({context:root,direction:initial,casting:unchanged},current,at)).toEqual(renderShots(source,at));
  const character=casting.characters[0]!,scene=parseFountain(source.scriptText).scenes[0]!,pictured=review(root,root,directed,{settings:[{shotId:directed.entries[0]!.shotId,settings:directionSettings({...directed.entries[0]!.settings!,picture:[{characterId:character.id,baseRevision:pictureBaseRevision(character,scene),controls:{emotion:"joyful",gestures:["smile"]}}]})}]}).candidate!;
  const effective=renderCurrentScreenplay({context:root,direction:pictured,casting:unchanged},current,at);
  expect(effective[0]!.picturePerformance!.characters[0]!.controls).toEqual({emotion:"joyful",gestures:["smile"]});expect(effective[0]!.performances![0]!.voice.pitch).toBe(66);expect(effective[0]!.prompt).toContain("emotion joyful");
  const second=root.plan.document.scenes[1]!,base=root.plan.document.context.base,moved=evolve(root,[{id:"effective-move",kind:"move",block:block(base,second.startLine,second.endLine),to:boundary(base,1)}],"effective-plan"),castMove=compileLivingScriptCastRebind({before:root.plan.document,after:moved.plan.document,casting,origin},at),directionMove=review(root,moved,pictured).candidate!;
  expect(()=>renderCurrentScreenplay({context:moved,direction:directionMove,casting:castMove},current,at)).toThrow(/picture performance/);
  const movedEntry=directionMove.entries.find(row=>row.shotId===pictured.entries[0]!.shotId)!,movedCharacter=castMove.candidate!.characters.find(row=>row.id===character.id)!,movedScene=parseFountain(moved.plan.document.context.base.text).scenes[1]!;
  const rebound=review(moved,moved,directionMove,{settings:[{shotId:movedEntry.shotId,settings:directionSettings({...movedEntry.settings!,picture:movedEntry.settings!.picture!.map(value=>({...value,baseRevision:pictureBaseRevision(movedCharacter,movedScene)}))})}]}).candidate!;
  const result=renderCurrentScreenplay({context:moved,direction:rebound,casting:castMove},current,at);expect(result[1]!.id).toBe(effective[0]!.id);expect(result[1]!.seed).toBe(909);expect(result[1]!.picturePerformance!.characters[0]!.controls).toEqual(effective[0]!.picturePerformance!.characters[0]!.controls);
  const revoked=castingSnapshot(casting.projectId,casting.version+1,casting.characters.map(value=>({...value,permission:{...value.permission,status:"revoked" as const}})),at);
  expect(()=>renderCurrentScreenplay({context:moved,direction:rebound,casting:castMove},{...current,casting:revoked},at)).toThrow(/Current casting changed/);
  expect(renderCurrentScreenplay({context:moved,direction:rebound,casting:castMove},{documentRevision:moved.plan.document.revision,casting:castMove.candidate!},at)).toEqual(result);
});
