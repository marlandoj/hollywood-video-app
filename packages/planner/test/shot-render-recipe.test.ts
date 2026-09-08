import {afterAll,expect,spyOn,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {contentHash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {DeterministicMockImageProvider} from "../../generator/src/image";
import {DeterministicMockProvider,type GenParams,type VideoClip} from "../../generator/src/index";
import {RichAnimaticProvider} from "../../generator/src/animatic";
import {AnchorStoryboardProvider} from "../../generator/src/anchor-storyboard";
import {parseFountain} from "../../parser/src/index";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {DurableJobStore,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {ProjectService} from "../../api/src/index";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {castingSnapshot,characterRecord} from "../src/casting";
import {assertSheetDispatch,characterSheetShots,createCharacterSheet} from "../src/sheets";
import {sourcePlan} from "../src/scene-cuts";
import {directionEntry,directionSettings,directionSnapshot,directShots} from "../src/direction";
import {compilePerformances,lineSources} from "../src/performances";
import {renderInputHash,renderShots} from "../src/shot-reuse";
import {compileShotRenderRecipe,resolveShotRenderAttempt,validateShotRenderRecipe,type ShotRenderRecipeInput,type ShotRenderRecipe} from "../src/shot-render-recipe";
import type {Shot} from "../src/index";
import type {ReferenceAsset} from "../src/references";

const scratch=mkdtempSync(join(tmpdir(),"hv-shot-recipe-"));afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
const script="INT. ROOM - DAY\n\nA lamp glows.",projectId="recipe-project",now=Date.now();
const legacy=[{adapter:"mock",model:"mock-deterministic-v1",richAnimatic:false,capability:null}];
const shot=():Shot=>({id:"shot-1-1",sceneIndex:0,prompt:"INT. ROOM - DAY. A lamp glows.",dialogue:[],durationSec:2,seed:7000});
const input=(over:Partial<ShotRenderRecipeInput>={}):ShotRenderRecipeInput=>({projectId,stage:"animatic",shot:shot(),sceneHeading:"INT. ROOM - DAY",outputSize:"320x180",legacyProviders:structuredClone(legacy),...over});
function pinned(stage:"animatic"|"final"|"character-sheet",pool:string[],rich:boolean[],over:Partial<ShotRenderRecipeInput>={}):ShotRenderRecipeInput {
  const env=stage==="final"?{HV_PROVIDER_POOL:JSON.stringify(pool)}:stage==="character-sheet"?{HV_CHARACTER_SHEET_PROVIDER_POOL:JSON.stringify(pool)}:{HV_ANIMATIC_PROVIDER_POOL:JSON.stringify(pool)};
  const result=input({...over,stage,providerPlan:createProviderPlan(stage,5,undefined,env),richAnimaticProviders:rich});delete result.legacyProviders;return result;
}
function reseal(value:ShotRenderRecipe):ShotRenderRecipe {const {revision:_revision,...body}=value;return {...body,revision:contentHash(body)};}
function reference():ReferenceAsset{return {schema:"hv-reference/1",id:"dce4b051-9e2a-4026-aa03-9c0621f866e8",projectId,sha256:"a".repeat(64),originalSha256:"a".repeat(64),bytes:24,width:32,height:24,contentType:"image/png",createdAt:new Date(now).toISOString(),attestedAt:new Date(now).toISOString()};}
const digest=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
function frameDigest(path:string):string {const result=Bun.spawnSync(["ffmpeg","-v","error","-i",path,"-map","0:v:0","-f","framemd5","-"],{stdout:"pipe",stderr:"pipe"});if(result.exitCode)throw new Error(result.stderr.toString());return result.stdout.toString();}
/** Independent snapshot of the replaced worker expressions, including explicit undefined keys. */
function original(input:ShotRenderRecipeInput,attempt:number):{prompt:string;seed:number;params:GenParams} {
  const s=input.shot,rich=input.providerPlan?input.richAnimaticProviders!.some(Boolean):input.legacyProviders!.some(p=>p.richAnimatic),sheet=input.stage==="character-sheet";
  const durationSec=input.stage!=="final"&&!s.direction?.frameAnchors&&s.direction?.durationFrames==null&&!rich?1:s.durationSec;
  const cameraMove=sheet?"static" as const:input.stage==="animatic"?s.direction?.previewMove??undefined:undefined;
  return {prompt:s.prompt,seed:s.seed+(sheet?0:attempt*10000),params:{seed:s.seed,durationSec,fps:30,widthxheight:input.outputSize,shotId:s.id,dialogue:s.dialogue,performances:s.performances,sceneHeading:input.sceneHeading,action:s.sourcePrompt??s.prompt,
    ...(s.direction?.framing?{framing:s.direction.framing}:{}),...(s.direction?.cameraPath?{cameraPath:s.direction.cameraPath}:{}),...(cameraMove?{cameraMove}:{}),...(s.direction?.durationFrames!=null?{exactDuration:true}:{}),routingRequirements:input.providerPlan?.requirements}};
}

test("dispatch preserves stage, mixed pool, exact-duration and legacy class semantics at every repair seed",()=>{
  const directed={...shot(),durationSec:3,direction:directionSettings({durationFrames:90,previewMove:"pan-left"})};
  const cases=[input(),input({stage:"final"}),input({stage:"character-sheet"}),input({shot:directed}),pinned("animatic",["legacy-mock"],[false]),pinned("animatic",["legacy-mock","mock"],[false,true]),pinned("final",["mock"],[false]),pinned("character-sheet",["mock"],[true]),
    input({legacyProviders:[{...legacy[0]!,adapter:"rich-animatic",richAnimatic:false}]}),input({legacyProviders:[{...legacy[0]!,adapter:"subclass",richAnimatic:true}]})];
  const noHeading=input();delete noHeading.sceneHeading;cases.push(noHeading);
  for(const value of cases){const recipe=compileShotRenderRecipe(value);expect(validateShotRenderRecipe(recipe)).toEqual(recipe);for(const attempt of [0,1,2]){const actual=resolveShotRenderAttempt(recipe,attempt),expected=original(value,attempt);expect(actual).toEqual(expected);expect(Object.keys(actual.params).sort()).toEqual(Object.keys(expected.params).sort());}}
  expect(compileShotRenderRecipe(cases[4]!).dispatch.params.durationSec).toBe(1);expect(compileShotRenderRecipe(cases[5]!).dispatch.params.durationSec).toBe(2);
  expect(compileShotRenderRecipe(cases[8]!).dispatch.params.durationSec).toBe(1);expect(compileShotRenderRecipe(cases[9]!).dispatch.params.durationSec).toBe(2);
});

test("anchor modes preserve ordered verified metadata handles without serialized media",()=>{
  for(const stage of ["animatic","final"] as const)for(const fallback of ["stop","storyboard"] as const){
    const s={...shot(),referenceAssets:[reference()],direction:directionSettings({frameAnchors:{frames:[{at:0,asset:reference()},{at:10000,asset:{...reference(),id:"53453256-d5b7-4c72-b9f1-f69ea7090c95",sha256:"b".repeat(64)}}],fallback}})};
    const recipe=compileShotRenderRecipe(input({stage,shot:s}));expect(recipe.dispatch.params.durationSec).toBe(2);expect(recipe.anchors?.mode).toBe(stage==="animatic"?"storyboard":fallback==="stop"?"native":"prefer-native");
    expect(recipe.anchors?.frames.map(f=>f.at)).toEqual([0,10000]);expect(recipe.references).toEqual(s.referenceAssets);expect(JSON.stringify(recipe)).not.toContain("data:image");expect(validateShotRenderRecipe(recipe)).toEqual(recipe);
  }
  const foreign=input({shot:{...shot(),direction:directionSettings({frameAnchors:{frames:[{at:0,asset:{...reference(),projectId:"another-project"}}],fallback:"stop"}})}});
  expect(()=>compileShotRenderRecipe(foreign)).toThrow(/reference metadata/);
  const own=compileShotRenderRecipe(input({shot:{...shot(),direction:directionSettings({frameAnchors:{frames:[{at:0,asset:reference()}],fallback:"stop"}})}})),changed=structuredClone(own);changed.anchors!.frames[0]!.asset.projectId="another-project";
  expect(()=>validateShotRenderRecipe(reseal(changed))).toThrow(/reference metadata/);
});

test("effective text, labels, voice, timing, framing, reference order and pinned runtime change the recipe",()=>{
  const spoken={...shot(),dialogue:[{character:"MARLA",lines:["Again.","Again."]}]},performances=compilePerformances(spoken.dialogue,undefined),base=input({shot:{...spoken,performances}}),first=compileShotRenderRecipe(base);
  const mutations:((v:ShotRenderRecipeInput)=>void)[]=[v=>v.shot.id="shot-2-1",v=>v.shot.seed++,v=>v.shot.prompt+=" Soft light.",v=>v.sceneHeading="INT. ROOM - NIGHT",v=>v.shot.sourcePrompt="A lamp fades.",v=>v.shot.durationSec=3,
    v=>{v.shot.direction=directionSettings({previewMove:"static"});},v=>{v.shot.direction=directionSettings({framing:{x:1000,y:1000,size:8000}});},v=>{v.shot.performances![1]!.voice.rateWpm=140;},v=>{v.shot.performances![1]!.beforeMs=100;},v=>{v.shot.performances![1]!.notes="Let the thought land.";},v=>{v.outputSize="96x64";},v=>{v.shot.referenceAssets=[reference()];}];
  // Automatic legacy duration is intentionally one second; compare a rich runtime for planned-duration changes.
  base.legacyProviders![0]!.richAnimatic=true;const rich=compileShotRenderRecipe(base);
  for(const mutate of mutations){const changed=structuredClone(base);mutate(changed);expect(compileShotRenderRecipe(changed).revision).not.toBe(rich.revision);}
  const refs=input({shot:{...shot(),referenceAssets:[reference(),{...reference(),id:"53453256-d5b7-4c72-b9f1-f69ea7090c95",sha256:"b".repeat(64)}]}}),one=compileShotRenderRecipe(refs);refs.shot.referenceAssets!.reverse();expect(compileShotRenderRecipe(refs).revision).not.toBe(one.revision);
  const policy=pinned("animatic",["mock"],[true]),before=compileShotRenderRecipe(policy);policy.providerPlan=createProviderPlan("animatic",5,undefined,{HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_ANIMATIC_CAPTIONS:"1"});expect(compileShotRenderRecipe(policy).revision).not.toBe(before.revision);
  expect(first.dispatch.params.performances?.map(p=>p.source.index)).toEqual([0,1]);
});

test("recipes are independent frozen snapshots and reject malformed or resealed derived fields",()=>{
  const raw=input(),recipe=compileShotRenderRecipe(raw);raw.shot.prompt="Changed caller";expect(recipe.dispatch.prompt).not.toBe(raw.shot.prompt);expect(Object.isFrozen(recipe.dispatch.params)).toBe(true);
  const attempt=resolveShotRenderAttempt(recipe,1);attempt.params.dialogue!.push({character:"X",lines:["changed"]});expect(recipe.dispatch.params.dialogue).toEqual([]);
  for(const mutate of [(v:ShotRenderRecipe)=>{v.dispatch.params.durationSec=99;},(v:ShotRenderRecipe)=>{v.repair.seedStep=0;},(v:ShotRenderRecipe)=>{v.dispatch.params.fps=24;},(v:ShotRenderRecipe)=>{v.duration.fallback="planned";},(v:ShotRenderRecipe)=>{(v.dispatch.params as any).referenceFrames=["data:image/png;base64,AA=="];}]){const bad=structuredClone(recipe);mutate(bad);expect(()=>validateShotRenderRecipe(reseal(bad))).toThrow();}
  for(const attempt of [-1,3,.5,NaN])expect(()=>resolveShotRenderAttempt(recipe,attempt)).toThrow();
  let reads=0;const accessor=input();Object.defineProperty(accessor,"stage",{enumerable:true,get(){reads++;return "animatic";}});expect(()=>compileShotRenderRecipe(accessor)).toThrow(/accessors/);expect(reads).toBe(0);
  const sparse:unknown[]=[];sparse.length=2;sparse[1]=legacy[0];
  for(const bad of [undefined,{...input(),unknown:true},{...input(),outputSize:"0x0"},{...input(),shot:{...shot(),seed:NaN}},{...input(),legacyProviders:sparse},{...input(),shot:{...shot(),prompt:"x".repeat(8*1024**2+1)}}])expect(()=>compileShotRenderRecipe(bad as ShotRenderRecipeInput)).toThrow();
  const missing=pinned("animatic",["mock"],[true]);missing.richAnimaticProviders=[];expect(()=>compileShotRenderRecipe(missing)).toThrow(/every actual/);
});

test("actual still, motion and directed-speech media match the original request expressions at normal and repair seeds",async()=>{
  const dialogue=[{character:"MARLA",lines:["Welcome to the little room.","Again."]}],lines=compilePerformances(dialogue,undefined);lines[1]!.voice.rateWpm=135;lines[1]!.beforeMs=100;
  const cases=[{name:"motion",provider:()=>new DeterministicMockProvider(),value:input({stage:"final"})},{name:"still",provider:()=>new RichAnimaticProvider(new DeterministicMockImageProvider()),value:input({legacyProviders:[{...legacy[0]!,richAnimatic:true}]})},
    {name:"speech",provider:()=>new RichAnimaticProvider(new DeterministicMockImageProvider(),{narration:true,captions:true}),value:input({legacyProviders:[{...legacy[0]!,richAnimatic:true}],shot:{...shot(),dialogue,performances:lines}})}];
  for(const c of cases)for(const attempt of [0,2]){
    const previous=original(c.value,attempt),next=resolveShotRenderAttempt(compileShotRenderRecipe(c.value),attempt),a=await c.provider().generate(previous.prompt,previous.seed,previous.params,join(scratch,`${c.name}-${attempt}-before.mp4`)),b=await c.provider().generate(next.prompt,next.seed,next.params,join(scratch,`${c.name}-${attempt}-after.mp4`));
    expect(b.seed).toBe(previous.seed);expect(b.durationSec).toBe(a.durationSec);expect(frameDigest(b.path)).toBe(frameDigest(a.path));expect(b.speech).toEqual(a.speech);if(a.posterPath)expect(digest(b.posterPath!)).toBe(digest(a.posterPath));if(a.audioPath)expect(digest(b.audioPath!)).toBe(digest(a.audioPath));
    if(c.name==="speech"){expect(b.speech?.lines).toHaveLength(2);expect(b.durationSec).toBeGreaterThan(2);expect(b.speech!.lines[1]!.source.index).toBe(1);}
  }
},60000);

test("actual anchored storyboard keeps the original mode, frame order and decoded media",async()=>{
  const path=(await new DeterministicMockImageProvider().generateFrame("A fictional lamp",1,{widthxheight:"320x180"},join(scratch,"anchor.png"))).path,bytes=readFileSync(path),asset={...reference(),bytes:bytes.length,width:320,height:180,sha256:digest(path)};
  const value=input({shot:{...shot(),direction:directionSettings({frameAnchors:{frames:[{at:0,asset},{at:10000,asset}],fallback:"storyboard"}})}}),recipe=compileShotRenderRecipe(value),prior=original(value,0),next=resolveShotRenderAttempt(recipe,0);
  const materialized={frames:recipe.anchors!.frames.map(f=>({at:f.at,image:"data:image/png;base64,"+bytes.toString("base64")})),mode:recipe.anchors!.mode};
  const provider=new AnchorStoryboardProvider(),a=await provider.generate(prior.prompt,prior.seed,{...prior.params,frameAnchors:materialized},join(scratch,"anchor-before.mp4")),b=await provider.generate(next.prompt,next.seed,{...next.params,frameAnchors:materialized},join(scratch,"anchor-after.mp4"));
  expect(b.frameAnchorControl).toEqual(a.frameAnchorControl);expect(frameDigest(b.path)).toBe(frameDigest(a.path));
},20000);

test("the actual legacy worker consumes the recipe for directed speech and all forced repair seeds",async()=>{
  const text="INT. ROOM - DAY\n\nA lamp glows.\n\nThe door opens.\n\nMARLA\nWelcome to the little room.\nAgain.",parsed=parseFountain(text),planned=sourcePlan(parsed,undefined,7000,24),sources=lineSources(planned[0]!.dialogue),direction=directionSnapshot(projectId,1,[directionEntry(planned[0]!,{lines:[{index:1,sourceHash:sources[1]!.hash,rateWpm:135,pitch:null,level:null,beforeMs:100,afterMs:200,notes:"Let the thought land."}]})],now),resolved=directShots(planned,direction),calls:{prompt:string;seed:number;params:GenParams}[]=[];
  class CapturingRich extends RichAnimaticProvider {override async generate(prompt:string,seed:number,params:GenParams,path:string):Promise<VideoClip>{const {signal:_signal,beforeAttempt:_before,onAttemptCost:_cost,afterAttempt:_after,onProviderRequest:_request,...saved}=params;calls.push({prompt,seed,params:structuredClone(saved)});const clip=await super.generate(prompt,seed,params,path);return {...clip,fingerprint:(params.shotId==="shot-1-1"?"0":"f").repeat(64)};}}
  const root=join(scratch,"worker"),store=new DurableJobStore(join(root,"jobs.json")),provider=new CapturingRich(new DeterministicMockImageProvider(),{narration:true,captions:true}),job:JobInput={id:"recipe-worker",idempotencyKey:"recipe-worker",projectId,tier:"free",stage:"animatic",scriptVersion:1,scriptText:text,direction,totalFrames:120,retryPolicy:{maxRetries:0,backoffMs:1},timeoutMs:60000,costCapUsd:5,rightsAttestedAt:new Date(now).toISOString(),animaticJobId:null,animaticApprovedAt:null};
  store.enqueue(job);const completed=await processNextJob(store,join(root,"artifacts"),{animaticProvider:provider,ledger:new CostLedger(join(root,"ledger.json")),reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))});expect(completed?.failureReason).toBeUndefined();expect(completed?.status).toBe("done");
  expect(calls.map(c=>[c.params.shotId,c.seed])).toEqual([["shot-1-1",7000],["shot-1-2",7001],["shot-1-2",17001],["shot-1-2",27001]]);
  for(const call of calls){const s=resolved.find(s=>s.id===call.params.shotId)!,expected=original(input({shot:s,outputSize:"640x360",legacyProviders:[{...legacy[0]!,richAnimatic:true}]}),(call.seed-s.seed)/10000);expect(call.prompt).toBe(expected.prompt);expect(call.params).toEqual({...expected.params,referenceFrames:undefined,frameAnchors:undefined});}
  const clips=JSON.parse(readFileSync(join(root,"artifacts",projectId,job.id,"clips","manifest.json"),"utf8")) as VideoClip[];expect(clips[0]!.speech?.lines[1]!.voice.rateWpm).toBe(135);expect(clips[0]!.durationSec).toBeGreaterThan(2);expect(readFileSync(join(root,"artifacts",completed!.output!.captionsPath),"utf8")).toContain("Again.");
},45000);

test("compiling execution recipes leaves legacy shot input hashes and schemas unchanged",()=>{
  const job={projectId,stage:"final" as const,tier:"free" as const,scriptText:script,providerPlan:createProviderPlan("final",5,undefined,{})},s=renderShots(job,now)[0]!,before=renderInputHash(job,s),recipe=compileShotRenderRecipe({projectId,stage:"final",shot:s,sceneHeading:"INT. ROOM - DAY",outputSize:"1280x720",providerPlan:job.providerPlan,richAnimaticProviders:[false]});
  expect(recipe.schema).toBe("hv-shot-execution/1");expect(renderInputHash(job,s)).toBe(before);expect(before).toBe(contentHash({schema:"hv-shot-input/1",engine:1,projectId,stage:"final",tier:"free",providerPlanRevision:job.providerPlan.revision,sceneHeading:"INT. ROOM - DAY",shot:{id:s.id,sceneIndex:s.sceneIndex,prompt:s.prompt,sourcePrompt:s.sourcePrompt??s.prompt,dialogue:s.dialogue,durationSec:s.durationSec,seed:s.seed,characterIds:s.characterIds??[],referenceAssets:s.referenceAssets??[],direction:directionSettings(s.direction??{})}}));
});

test("a narration-disabled worker preserves valid long dialogue while the speech-specific limit stays enforced",async()=>{
  const text="INT. ROOM - DAY\nA lamp glows.\n\nMARLA\n"+"A calm thought. ".repeat(1400),parsed=parseFountain(text),s=sourcePlan(parsed,undefined,7000,24)[0]!,calls:{prompt:string;seed:number;params:GenParams}[]=[];
  expect(parsed.rejected).toBe(false);expect(text.length).toBeLessThan(200000);expect(s.prompt.length).toBe(30);expect(s.dialogue[0]!.lines[0]!.length).toBe(22399);
  class SilentRich extends RichAnimaticProvider {override async generate(prompt:string,seed:number,params:GenParams,path:string){const {signal:_signal,beforeAttempt:_before,onAttemptCost:_cost,afterAttempt:_after,onProviderRequest:_request,...saved}=params;calls.push({prompt,seed,params:structuredClone(saved)});return super.generate(prompt,seed,params,path);}}
  const root=join(scratch,"long-dialogue"),store=new DurableJobStore(join(root,"jobs.json")),job:JobInput={id:"long-dialogue",idempotencyKey:"long-dialogue",projectId,tier:"free",stage:"animatic",scriptVersion:1,scriptText:text,totalFrames:60,retryPolicy:{maxRetries:0,backoffMs:1},timeoutMs:60000,costCapUsd:5,rightsAttestedAt:new Date(now).toISOString(),animaticJobId:null,animaticApprovedAt:null};
  store.enqueue(job);const completed=await processNextJob(store,join(root,"artifacts"),{animaticProvider:new SilentRich(new DeterministicMockImageProvider(),{narration:false,captions:false}),ledger:new CostLedger(join(root,"ledger.json")),reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))});
  expect(completed?.failureReason).toBeUndefined();expect(completed?.status).toBe("done");expect(calls).toHaveLength(1);
  const value=input({shot:s,outputSize:"640x360",legacyProviders:[{...legacy[0]!,richAnimatic:true}]}),previous=original(value,0),next=resolveShotRenderAttempt(compileShotRenderRecipe(value),0);
  expect(calls[0]).toEqual({...previous,params:{...previous.params,referenceFrames:undefined,frameAnchors:undefined}});expect(next).toEqual(previous);
  const before=await new RichAnimaticProvider(new DeterministicMockImageProvider(),{narration:false,captions:false}).generate(previous.prompt,previous.seed,previous.params,join(root,"before-extraction.mp4"));
  const clips=JSON.parse(readFileSync(join(root,"artifacts",projectId,job.id,"clips","manifest.json"),"utf8")) as VideoClip[];expect(frameDigest(clips[0]!.path)).toBe(frameDigest(before.path));expect(clips[0]!.speech).toBeUndefined();
  let imageCalls=0;class CountedImage extends DeterministicMockImageProvider {override async generateFrame(...args:Parameters<DeterministicMockImageProvider["generateFrame"]>){imageCalls++;return super.generateFrame(...args);}}
  await expect(new RichAnimaticProvider(new CountedImage(),{narration:true}).generate(next.prompt,next.seed,next.params,join(root,"speech-must-reject.mp4"))).rejects.toThrow(/at most 20000 characters/);expect(imageCalls).toBe(0);
  const excessive=input({shot:{...s,dialogue:[{character:"MARLA",lines:["a".repeat(200001)]}]}});expect(()=>compileShotRenderRecipe(excessive)).toThrow(/dialogue/);
},30000);

test("the actual legacy wardrobe-sheet worker preserves an absent source-scene heading",async()=>{
  const text="INT. ROOM - DAY\nSpud waves.",parsed=parseFountain(text),character=characterRecord({...CAST_INPUT,wardrobe:[...CAST_INPUT.wardrobe,{sceneNumber:2,description:"A green coat"}]},"74f87c10-a588-42a5-aa25-972719425f58",now),casting=castingSnapshot(projectId,1,[character],now),sheet=createCharacterSheet(casting,parsed,character.id,{kind:"wardrobe",seed:12,sceneNumber:null}),shots=characterSheetShots(sheet,casting,parsed,now);
  expect(character.sceneBindings).toEqual([]);expect(shots.map(s=>s.sceneIndex)).toEqual([0,1]);expect(parsed.scenes[shots[1]!.sceneIndex]?.heading).toBeUndefined();expect(()=>assertSheetDispatch(sheet,casting,casting,"sheet-2",parsed,now)).not.toThrow();
  const projects=ProjectService.fromState({version:1,projects:[{id:projectId,createdAt:new Date(now).toISOString(),deleteAfter:new Date(now+86400000).toISOString(),operatorExtensions:[],rightsAttestedAt:new Date(now).toISOString(),animaticApprovals:[],versions:[],castingHistory:[casting]}],reviewLinks:[],takenDown:[],takedownLog:[]});
  const root=join(scratch,"legacy-sheet"),store=new DurableJobStore(join(root,"jobs.json")),providerPlan=createProviderPlan("character-sheet",5,undefined,{HV_CHARACTER_SHEET_PROVIDER_POOL:'["mock"]'}),job:JobInput={id:"legacy-sheet",idempotencyKey:"legacy-sheet",projectId,tier:"free",stage:"character-sheet",scriptVersion:1,scriptText:text,casting,characterSheet:sheet,providerPlan,totalFrames:60,retryPolicy:{maxRetries:0,backoffMs:1},timeoutMs:60000,costCapUsd:5,rightsAttestedAt:new Date(now).toISOString(),animaticJobId:null,animaticApprovedAt:null},calls:{prompt:string;seed:number;params:GenParams}[]=[];
  const generate=RichAnimaticProvider.prototype.generate,spy=spyOn(RichAnimaticProvider.prototype,"generate").mockImplementation(async function(this:RichAnimaticProvider,prompt,seed,params,path){const {signal:_signal,beforeAttempt:_before,onAttemptCost:_cost,afterAttempt:_after,onProviderRequest:_request,...saved}=params;calls.push({prompt,seed,params:structuredClone(saved)});return generate.call(this,prompt,seed,params,path);});
  let completed:Awaited<ReturnType<typeof processNextJob>>;
  try{store.enqueue(job);completed=await processNextJob(store,join(root,"artifacts"),{projects,ledger:new CostLedger(join(root,"ledger.json")),reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))});}finally{spy.mockRestore();}
  expect(completed?.failureReason).toBeUndefined();expect(completed?.status).toBe("done");expect(completed?.output?.sheetPath).toBeDefined();expect(calls.map(c=>[c.params.shotId,c.seed])).toEqual([["sheet-1",12],["sheet-2",12]]);
  for(const [index,s]of shots.entries()){
    const value:ShotRenderRecipeInput={projectId,stage:"character-sheet",shot:s,outputSize:"512x512",providerPlan,richAnimaticProviders:[true],...(parsed.scenes[s.sceneIndex]?{sceneHeading:parsed.scenes[s.sceneIndex]!.heading}:{})},expected=original(value,0);
    expect(calls[index]).toEqual({...expected,params:{...expected.params,referenceFrames:undefined,frameAnchors:undefined}});expect(Object.hasOwn(calls[index]!.params,"sceneHeading")).toBe(true);
  }
  expect(calls[1]!.params.sceneHeading).toBeUndefined();expect(calls[1]!.params.action).toContain("Scene 2 wardrobe");
  const prior=original({projectId,stage:"character-sheet",shot:shots[1]!,outputSize:"512x512",providerPlan,richAnimaticProviders:[true]},0),before=await new RichAnimaticProvider(new DeterministicMockImageProvider(),{narration:false,captions:false}).generate(prior.prompt,prior.seed,prior.params,join(root,"before-extraction.mp4")),clips=JSON.parse(readFileSync(join(root,"artifacts",projectId,job.id,"clips","manifest.json"),"utf8")) as VideoClip[];
  expect(frameDigest(clips[1]!.path)).toBe(frameDigest(before.path));expect(digest(clips[1]!.posterPath!)).toBe(digest(before.posterPath!));
},30000);
