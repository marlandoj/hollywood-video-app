import {afterAll,beforeAll,expect,test} from "bun:test";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {ProjectService} from "../../api/src/index";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {createProviderPlan} from "../../generator/src/catalog";
import {contentHash} from "../../generator/src/capabilities";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {currentCasting} from "../src/casting";
import {currentDirection} from "../src/direction";
import {bindOriginalEditSource} from "../src/edit-jobs";
import {bootstrapLivingScriptDocument,compileLivingScriptDocument} from "../src/living-script-document";
import {bootstrapLivingScriptShotPlan} from "../src/living-script-shot-plan";
import {createLivingScriptStructureBase,compileLivingScriptStructure,livingScriptStructureBlock,livingScriptStructureBoundary} from "../src/living-script-structure";
import {proposeShotPlanEvolution} from "../src/living-script-current-plan";
import {createCurrentDirectionRequest} from "../src/living-script-current-direction";
import {currentScreenplayHead} from "../src/current-screenplay-library";
import {compileCurrentFilmJob} from "../src/current-film-jobs";
import {compileEditScriptSource,resolveEditCurrentFilmScriptSource} from "../src/edit-script-source";
import {projectEditScriptNavigation,validateEditScriptSourceIndex} from "../src/edit-script-projection";
import {initialEditTimeline,applyEditOperation} from "../src/edit-timeline";
import {editFactsRevision,type EditSourceReceipt} from "../src/edit-sources";

let studio:Awaited<ReturnType<typeof dubStudio>>,source:EditSourceReceipt,job:Job;
const original="INT. ROOM - DAY\r\n\r\nSpud opens a door.\r\n\r\nSPUD\r\n(quietly)\r\nAgain.\r\nAgain.\r\n\r\n/*\r\nAgain.\r\n*/\r\n\r\nINT. ROOM - DAY\r\n\r\nSpud closes a door.\r\n\r\nSPUD\r\nAgain.\r\n\r\n";
beforeAll(async()=>{
  studio=await dubStudio(undefined,original);const receipt=await inspectEditSource(studio.film,"Original equal-heading screenplay",studio.paths.artifactRoot,async()=>{}),project=studio.projects.snapshot().projects[0]!,script=project.versions.at(-1)!;
  const base=createLivingScriptStructureBase({projectId:project.id,version:script.version,text:script.text,locks:[]}),documentSource=bootstrapLivingScriptDocument(receipt,{base,ancestry:[]});
  const bootstrap=studio.projects.bootstrapCurrentScreenplay(studio.owner.token,{id:"index-root",label:"Original index film",script,source:receipt,documentSource,originalPlan:bootstrapLivingScriptShotPlan(receipt,documentSource),baseline:{casting:currentCasting(project.id,project.castingHistory),direction:currentDirection(project.id,project.directionHistory)}},0,{binding:bindOriginalEditSource(receipt),current:studio.film})!;
  const head=currentScreenplayHead(bootstrap.library)!,context=head.state.context,second=context.plan.document.scenes[1]!;
  const moved=compileLivingScriptStructure(base,{baseRevision:base.revision,operations:[{id:"move-second-room",kind:"move",block:livingScriptStructureBlock(base,second.startLine,second.endLine),to:livingScriptStructureBoundary(base,1)}]});
  const inserted=compileLivingScriptStructure(moved.after,{baseRevision:moved.after.revision,operations:[{id:"insert-opaque-scene",kind:"insert",at:livingScriptStructureBoundary(moved.after,1),text:"EXT. INSERTED - NIGHT\r\n\r\nA lamp glows.\r\n\r\n"}]}),afterDocument=compileLivingScriptDocument({base:inserted.after,ancestry:[moved,inserted]}),capacity={tier:"free" as const,maxShots:24 as const};
  const evolution=proposeShotPlanEvolution({previous:context.plan,lineage:context.lineage,originals:context.originals,beforeDocument:context.plan.document,afterDocument,capacity,requestId:"index-evolution"});expect(evolution.review.conflicts).toEqual([]);
  const proposal=studio.projects.saveCurrentScreenplayProposal(studio.owner.token,{id:"index-proposal",label:"Moved equal scenes and inserted picture",expectedHeadRevision:head.revision,beforeStateRevision:head.state.revision,afterDocument,planRequest:evolution.request,capacity,directionRequest:createCurrentDirectionRequest(head.state.direction,evolution.review.candidate!,{id:"index-direction",settings:[],lines:[],retired:[]})},bootstrap.library.version)!;
  const plan=compileCurrentFilmJob(proposal.library,{kind:"proposal",revision:proposal.proposal.revision},{role:"preview",tier:"free",providerPlan:createProviderPlan("animatic",5)}),id=crypto.randomUUID(),store=new DurableJobStore(null),input:JobInput={id,projectId:project.id,idempotencyKey:id,tier:"free",stage:"animatic",scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,currentFilm:plan,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:plan.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:300000};
  store.enqueue(input);job=(await processNextJob(store,studio.paths.artifactRoot,{projects:ProjectService.fromState(studio.projects.snapshot()),ledger:new CostLedger(join(studio.root,"index-cost.json")),reviewQueue:new OperatorReviewQueue(join(studio.root,"index-review.json"))}))!;
  expect(job.failureReason??job.cancelReason).toBeUndefined();expect(job.status).toBe("done");source=await inspectEditSource(job,"Current canonical screenplay",studio.paths.artifactRoot,async()=>{});
},300000);
afterAll(async()=>{await studio?.close();});

test("actual canonical source indexes duplicate text and moved equal headings by physical identity",()=>{
  const before=contentHash(source),resolved=resolveEditCurrentFilmScriptSource(source),index=resolved.index,document=job.currentFilm!.target.state.context.plan.document;
  expect(source.schema).toBe("hv-edit-source/3");expect(job.output!.shotRenders).toBeUndefined();expect(index).toEqual(compileEditScriptSource(source));expect(validateEditScriptSourceIndex(index,source.facts)).toEqual(index);
  expect(index.scriptText).toBe(document.context.base.text);expect(index.scriptText).toContain("\r\n/*\r\nAgain.\r\n*/\r\n");expect(index.scriptRevision).toBe(document.scriptRevision);expect(resolved.documentRevision).toBe(document.revision);
  const scenes=index.entries.filter(entry=>entry.kind==="scene"),lines=index.entries.filter(entry=>entry.kind==="dialogue");
  expect(scenes.map(entry=>entry.text)).toEqual(["EXT. INSERTED - NIGHT","INT. ROOM - DAY","INT. ROOM - DAY"]);expect(new Set(scenes.map(entry=>entry.id)).size).toBe(3);expect(lines.map(entry=>entry.text)).toEqual(["Again.","Again.","Again."]);expect(new Set(lines.map(entry=>entry.id)).size).toBe(3);
  for(const scene of document.scenes){const linked=resolved.entries.find(entry=>entry.kind==="scene"&&entry.sceneId===scene.id)!;expect(index.entries.find(entry=>entry.id===linked.entryId)!.startLine).toBe(scene.startLine);expect(linked.lineIds).toEqual([scene.headingLineId]);}
  for(const entry of lines){const link=resolved.entries.find(value=>value.entryId===entry.id)!;expect(link.lineIds).toHaveLength(1);expect(document.lines.find(line=>line.id===link.lineIds[0])!.line).toBe(entry.startLine!);expect(entry.performedText).toBe("Again.");}
  expect(index.warnings).toEqual([]);expect(contentHash(source)).toBe(before);expect(JSON.stringify(index)).not.toContain("hv-current-film-job/2");expect(JSON.stringify(index)).not.toContain("hv-shot-execution-capture/1");
},60000);

test("measured native speech maps once onto the actual assembled clock and captions remain separate",()=>{
  const resolved=resolveEditCurrentFilmScriptSource(source),index=resolved.index,output=job.output!.currentFilm!;
  for(const [i,span]of output.assembly.spans.entries()){
    const slot=job.currentFilm!.materialization.slots[i]!,record=output.records[i]!.record;
    for(const line of record.clip.speech?.lines??[]){const physical=slot.physical.spoken.find(value=>value.source.hash===line.source.hash)!,link=resolved.entries.find(value=>value.kind==="dialogue"&&value.lineIds.includes(physical.lineId))!,entry=index.entries.find(value=>value.id===link.entryId)!;
      const speech=entry.windows.find(window=>window.shotId===slot.renderId&&window.evidence==="measured-speech"&&!window.lanes.includes("captions"))!;
      expect([speech.startSample,speech.endSample]).toEqual([Math.round((span.startFrame*735+line.startSample)*320/147),Math.round((span.startFrame*735+line.endSample)*320/147)]);
      expect(speech.lanes).toEqual(["picture","mix","dialogue"]);expect(entry.windows.some(window=>window.lanes.join(",")==="captions")).toBe(true);
      expect(entry.windows.find(window=>window.shotId===slot.renderId&&window.evidence==="shot-coverage")).toMatchObject({startSample:span.startFrame*1600,endSample:span.endFrame*1600,lanes:["picture"]});
    }
  }
  expect(output.assembly.probe.audio.sampleRate).toBe(44100);expect(source.facts.frames).toBe(output.assembly.frames);
},60000);

test("canonical source navigation preserves retained duplicate clips and never introduces a legacy shot plan",()=>{
  const index=compileEditScriptSource(source);let timeline=initialEditTimeline([source.facts],source.facts.id,320,180);const picture=timeline.clips.find(clip=>clip.lane==="picture")!,at=timeline.frames;
  timeline=applyEditOperation(timeline,{kind:"duration",frames:at*2});
  timeline=applyEditOperation(timeline,{kind:"unlink",clipId:picture.id});
  timeline=applyEditOperation(timeline,{kind:"duplicate",clipId:picture.id,linked:false,at,ids:{[picture.id]:"second-picture"},link:null,ripple:false});
  const navigation=projectEditScriptNavigation("canonical-index-cut","a".repeat(64),timeline,[index]),line=index.entries.find(entry=>entry.kind==="dialogue")!;
  expect(new Set(navigation.occurrences.filter(row=>row.entryId===line.id&&row.lane==="picture").map(row=>row.clipId)).size).toBe(2);
  expect(index.entries.flatMap(entry=>entry.windows).some(window=>window.shotId?.startsWith("shot-v2-"))).toBe(true);
},60000);

test("changed canonical document/clock is refused while unsupported caption identity stays explicitly unbound",()=>{
  for(const mutate of [(value:EditSourceReceipt)=>{value.job.currentFilm!.materialization.documentRevision="f".repeat(64);},(value:EditSourceReceipt)=>{value.job.output!.currentFilm!.assembly.spans[0]!.startFrame++;}]){const changed=structuredClone(source);mutate(changed);expect(()=>compileEditScriptSource(changed)).toThrow();}
  const changed=structuredClone(source);changed.facts.captions[0]!.text="A different retained caption";changed.facts.revision=editFactsRevision(changed.job,changed.facts.frames,changed.facts.width,changed.facts.height,changed.facts.captions);const {revision:_revision,...body}=changed;changed.revision=contentHash(body);
  const index=compileEditScriptSource(changed);expect(index.entries.every(entry=>entry.windows.every(window=>!window.lanes.includes("captions")))).toBe(true);expect(index.warnings.join(" ")).toContain("caption-lane navigation remains unbound");
},60000);
