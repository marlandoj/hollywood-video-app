import {afterAll,beforeAll,expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash as hash} from "../../generator/src/capabilities";
import type {ScriptVersion} from "../../parser/src/index";
import {currentCasting,castingSnapshot} from "../src/casting";
import {currentDirection,directionSnapshot,directionEntry} from "../src/direction";
import {bootstrapLivingScriptDocument,compileLivingScriptDocument,type LivingScriptDocument} from "../src/living-script-document";
import {bootstrapLivingScriptShotPlan} from "../src/living-script-shot-plan";
import {materializeCurrentShotPlan,proposeShotPlanEvolution,createCurrentShotPlanRequest} from "../src/living-script-current-plan";
import {createCurrentDirectionRequest} from "../src/living-script-current-direction";
import {createLivingScriptStructureBase,compileLivingScriptStructure,livingScriptStructureBlock as block,livingScriptStructureBoundary as boundary,type LivingScriptStructureOperation} from "../src/living-script-structure";
import {renderCurrentScreenplay} from "../src/living-script-current-render";
import {renderShots} from "../src/shot-reuse";
import {CURRENT_SCREENPLAY_LIBRARY_LIMITS,emptyCurrentScreenplayLibrary,bootstrapCurrentScreenplayLibrary,saveCurrentScreenplayProposal,acceptCurrentScreenplayProposal,validateCurrentScreenplayLibrary,validateCurrentScreenplayState,validateProjectCurrentScreenplay,currentScreenplayHead,currentScreenplayTarget,resolveCurrentScreenplayTarget,type CurrentScreenplayLibrary,type CurrentScreenplayBootstrapRequest,type CurrentScreenplayProposalRequest} from "../src/current-screenplay-library";

const SCENE="INT. SAME - DAY\r\nSpud waves.\r\n\r\nSPUD\r\nWelcome, friend.\r\nCome inside.\r\n\r\n";
let studio:Awaited<ReturnType<typeof dubStudio>>,request:CurrentScreenplayBootstrapRequest,root:CurrentScreenplayLibrary,at:number,projectVersions:ScriptVersion[];
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...body,revision:hash(body)} as T;};
beforeAll(async()=>{
  studio=await dubStudio(undefined,"Title: Current owner state\r\n\r\n"+SCENE+SCENE);
  const source=await inspectEditSource(studio.film,"Captured current-film origin",studio.paths.artifactRoot,async()=>{}),project=studio.projects.snapshot().projects.find(value=>value.id===studio.owner.projectId)!;
  projectVersions=structuredClone(project.versions);const script=projectVersions.find(value=>value.version===source.job.scriptVersion)!,base=createLivingScriptStructureBase({projectId:source.job.projectId,version:script.version,text:script.text,locks:[]}),documentSource=bootstrapLivingScriptDocument(source,{base,ancestry:[]});
  request={id:"owner-root",label:"Original accepted screenplay",script,source,documentSource,originalPlan:bootstrapLivingScriptShotPlan(source,documentSource),baseline:{casting:currentCasting(project.id,project.castingHistory),direction:currentDirection(project.id,project.directionHistory)}};
  at=Date.now();root=bootstrapCurrentScreenplayLibrary(emptyCurrentScreenplayLibrary(project.id),request,0,at).library;
},180000);
afterAll(async()=>{await studio?.close();});
function change(document:LivingScriptDocument,operations:LivingScriptStructureOperation[]):LivingScriptDocument {
  const patch=compileLivingScriptStructure(document.context.base,{baseRevision:document.context.base.revision,operations});return compileLivingScriptDocument({base:patch.after,ancestry:[...document.context.ancestry,patch]});
}
function lineChange(library:CurrentScreenplayLibrary,text:string,id="physical-line"):LivingScriptDocument {
  const state=currentScreenplayHead(library)!.state,document=state.context.plan.document,line=document.lines.find(row=>row.id===state.context.plan.shots[0]!.recipe.dialogue[0]!.lineIds[0])!;
  return change(document,[{id,kind:"replace",block:block(document.context.base,line.line,line.line+1),text}]);
}
function propose(library:CurrentScreenplayLibrary,document:LivingScriptDocument,id:string):CurrentScreenplayProposalRequest {
  const head=currentScreenplayHead(library)!,state=head.state,capacity={tier:"free" as const,maxShots:24 as const},plan=proposeShotPlanEvolution({previous:state.context.plan,lineage:state.context.lineage,originals:state.context.originals,beforeDocument:state.context.plan.document,afterDocument:document,requestId:id+"-plan",capacity});
  return {id,label:"Review "+id,expectedHeadRevision:head.revision,beforeStateRevision:state.revision,afterDocument:document,planRequest:plan.request,capacity,
    directionRequest:plan.review.candidate?createCurrentDirectionRequest(state.direction,plan.review.candidate,{id:id+"-direction",settings:[],lines:[],retired:[]}):null};
}
function adopt(library:CurrentScreenplayLibrary,input:CurrentScreenplayProposalRequest,now:number){
  const saved=saveCurrentScreenplayProposal(library,input,library.version,now),accepted=acceptCurrentScreenplayProposal(saved.library,{id:input.id+"-acceptance",proposalRevision:saved.proposal.revision,expectedHeadRevision:input.expectedHeadRevision},saved.library.version,now+1);return {saved,accepted};
}

test("real captured bootstrap retains exact original, saved settings and independently materialized current inputs without authority",()=>{
  const original=hash({request,root,film:studio.film}),head=currentScreenplayHead(root)!;
  expect(root.version).toBe(1);expect(root.headRevision).toBe(root.origin!.revision);expect(head.script).toEqual(request.script);
  expect(head.state.context.originals).toEqual([request.source]);expect(head.state.context.lineage.steps).toEqual([]);expect(head.state.castOrigin.steps).toEqual([]);
  expect(head.state.context.plan.document.context.ancestry).toEqual([]);expect(head.state.casting.candidate).toEqual(request.baseline.casting);
  expect(request.source.job.executionCheckpoints).toEqual(studio.film.executionCheckpoints!);expect(request.source.job.output!.shotExecutions).toEqual(studio.film.output!.shotExecutions!);
  expect(validateCurrentScreenplayState(head.state)).toEqual(head.state);expect(validateCurrentScreenplayLibrary(JSON.parse(JSON.stringify(root)))).toEqual(root);
  expect(renderCurrentScreenplay(head.state,{documentRevision:head.state.context.plan.document.revision,casting:request.baseline.casting},at)).toEqual(renderShots(studio.film,at));
  const target=currentScreenplayTarget(root,{kind:"accepted",revision:root.headRevision!});expect(target.state).toEqual(head.state);expect(target.recordRevision).toBe(root.origin!.revision);
  expect(hash({request,root,film:studio.film})).toBe(original);
},30000);

test("successive accepted multiline replacement, reorder-plus-insert suffix and next forward edit retain complete current identity and every durable version",()=>{
  const before=hash(root),first=adopt(root,propose(root,lineChange(root,"Welcome back.\r\nStay for a while.\r\n"),"multiline"),at+10),one=first.accepted.library,head=currentScreenplayHead(one)!,document=head.state.context.plan.document;
  expect(first.accepted.versions.map(value=>value.version)).toEqual([request.script.version+1]);expect(document.context.base.text).toContain("Welcome back.\r\nStay for a while.");
  expect(head.state.context.plan.shots.map(row=>[row.id,row.renderId,row.seed])).toEqual(root.origin!.state.context.plan.shots.map(row=>[row.id,row.renderId,row.seed]));
  const moved=change(document,[{id:"move-second",kind:"move",block:block(document.context.base,document.scenes[1]!.startLine,document.scenes[1]!.endLine),to:boundary(document.context.base,document.scenes[0]!.startLine)}]);
  const lastLine=moved.lines.find(row=>row.id===head.state.context.plan.shots[0]!.recipe.dialogue[0]!.lineIds.at(-1))!,inserted=change(moved,[{id:"insert-current-dialogue",kind:"insert",at:boundary(moved.context.base,lastLine.line+1),text:"The garden is ready.\r\n"}]),second=adopt(one,propose(one,inserted,"move-and-insert"),at+20),two=second.accepted.library;
  expect(second.accepted.versions).toEqual([moved,inserted].map((doc,i)=>({version:doc.context.base.version,text:doc.context.base.text,createdAt:new Date(at+21).toISOString(),parentVersion:i?moved.context.base.version:document.context.base.version})));
  expect(currentScreenplayHead(two)!.state.context.lineage.steps).toHaveLength(2);expect(currentScreenplayHead(two)!.state.context.plan.document.context.ancestry).toHaveLength(3);
  expect(currentScreenplayHead(two)!.state.context.plan.shots.map(row=>row.id)).toEqual([...head.state.context.plan.shots].reverse().map(row=>row.id));
  const third=adopt(two,propose(two,lineChange(two,"Another current welcome.\r\n","next-forward"),"next-forward"),at+30),versions=[...projectVersions,...first.accepted.versions,...second.accepted.versions,...third.accepted.versions];
  expect(validateProjectCurrentScreenplay(third.accepted.library,{projectId:root.projectId,versions})).toEqual(third.accepted.library);
  expect(third.accepted.library.acceptances).toHaveLength(3);expect(currentScreenplayHead(third.accepted.library)!.state.context.plan.document.context.base.text).toContain("Another current welcome.");
  expect(hash(root)).toBe(before);expect(studio.projects.snapshot().projects[0]!.versions).toEqual(projectVersions);
},60000);

test("same-version different-body proposals remain distinct, exact replay survives later acceptance, and stale targets never become current",()=>{
  const a=propose(root,lineChange(root,"First reviewed text.\r\n","patch-a"),"proposal-a"),b=propose(root,lineChange(root,"Second reviewed text.\r\n","patch-b"),"proposal-b"),first=saveCurrentScreenplayProposal(root,a,1,at+1),second=saveCurrentScreenplayProposal(first.library,b,2,at+2);
  expect(a.afterDocument.context.base.version).toBe(b.afterDocument.context.base.version);expect(first.proposal.candidate!.revision).not.toBe(second.proposal.candidate!.revision);
  const pending=currentScreenplayTarget(second.library,{kind:"proposal",revision:second.proposal.revision}),acceptInput={id:"accept-first",proposalRevision:first.proposal.revision,expectedHeadRevision:root.headRevision!},accepted=acceptCurrentScreenplayProposal(second.library,acceptInput,3,at+3),before=hash(accepted.library);
  expect(currentScreenplayTarget(second.library,{kind:"proposal",revision:second.proposal.revision})).toEqual(pending);
  expect(()=>currentScreenplayTarget(accepted.library,{kind:"proposal",revision:second.proposal.revision})).toThrow(/exact frozen current head/);
  expect(()=>currentScreenplayTarget(accepted.library,{kind:"accepted",revision:root.headRevision!})).toThrow(/exact frozen current/);
  const retry=saveCurrentScreenplayProposal(accepted.library,a,1,at+100);expect(retry.replayed).toBe(true);expect(retry.proposal).toEqual(first.proposal);expect(retry.library).toEqual(accepted.library);
  expect(acceptCurrentScreenplayProposal(accepted.library,acceptInput,0,at+100).replayed).toBe(true);expect(bootstrapCurrentScreenplayLibrary(accepted.library,request,0,at+100).replayed).toBe(true);
  expect(()=>saveCurrentScreenplayProposal(accepted.library,{...a,label:"Different submitted body"},accepted.library.version,at+101)).toThrow(/different exact request/);
  expect(()=>acceptCurrentScreenplayProposal(accepted.library,{...acceptInput,proposalRevision:second.proposal.revision},accepted.library.version,at+101)).toThrow(/different exact request/);
  expect(()=>saveCurrentScreenplayProposal(accepted.library,{...b,id:"stale-new-request"},accepted.library.version,at+101)).toThrow(/head changed/);
  expect(()=>acceptCurrentScreenplayProposal(accepted.library,{id:"stale-sibling",proposalRevision:second.proposal.revision,expectedHeadRevision:accepted.library.headRevision!},accepted.library.version,at+101)).toThrow(/exact saved proposal/);
  expect(hash(accepted.library)).toBe(before);
},60000);

test("one-pass target resolution retains the accepted before head and full saved candidate without an unchecked public path",()=>{
  const saved=saveCurrentScreenplayProposal(root,propose(root,lineChange(root,"One current target.\r\n"),"resolve-once"),1,at+1),original=hash(saved.library),selector={kind:"proposal" as const,revision:saved.proposal.revision},resolved=resolveCurrentScreenplayTarget(saved.library,selector);
  expect(resolved.library).toEqual(saved.library);expect(resolved.head).toEqual(currentScreenplayHead(saved.library)!);expect(resolved.target).toEqual(currentScreenplayTarget(saved.library,selector));
  expect(resolved.head.state.revision).toBe(root.origin!.state.revision);expect(resolved.target.state.revision).toBe(saved.proposal.candidate!.revision);expect(resolved.head.state.revision).not.toBe(resolved.target.state.revision);
  resolved.target.state.context.plan.shots[0]!.seed++;expect(hash(saved.library)).toBe(original);
  const forged=structuredClone(saved.library);forged.proposals[0]!.candidate!.context.plan.shots[0]!.seed++;forged.proposals[0]!.candidate!.context.plan=reseal(forged.proposals[0]!.candidate!.context.plan);forged.proposals[0]=reseal(forged.proposals[0]!);
  expect(()=>resolveCurrentScreenplayTarget(reseal(forged),{kind:"proposal",revision:forged.proposals[0]!.revision})).toThrow();
},30000);

test("incomplete shot or performance review can be saved as evidence but cannot be accepted or rendered",()=>{
  const head=currentScreenplayHead(root)!,document=lineChange(root,"Same slot, explicit physical replacement.\r\n"),input=propose(root,document,"unresolved");
  input.planRequest=createCurrentShotPlanRequest(head.state.context.plan,document,{id:"unreviewed-plan",scenes:[],retired:[]});input.directionRequest=null;
  const saved=saveCurrentScreenplayProposal(root,input,1,at+1);expect(saved.proposal.candidate).toBeNull();expect(saved.proposal.planReview.conflicts.length).toBeGreaterThan(0);expect(saved.proposal.directionReview).toBeNull();
  expect(()=>acceptCurrentScreenplayProposal(saved.library,{id:"bad-accept",proposalRevision:saved.proposal.revision,expectedHeadRevision:root.headRevision!},2,at+2)).toThrow(/Resolve the complete/);
  expect(()=>currentScreenplayTarget(saved.library,{kind:"proposal",revision:saved.proposal.revision})).toThrow(/complete saved proposal/);
  expect(validateCurrentScreenplayLibrary(saved.library)).toEqual(saved.library);
},30000);

test("bootstrap can bind explicitly saved direction settings while retaining original film inputs, and stale membership or moved-root shortcuts fail",()=>{
  const context=root.origin!.state.context,shots=materializeCurrentShotPlan(context.plan,context.plan.document,context.lineage,context.originals),baseline={...request.baseline,direction:directionSnapshot(root.projectId,request.baseline.direction.version+1,[directionEntry(shots[0]!,{seed:987,durationFrames:120,performance:"Quiet and unhurried."})],at+1)},asked={...request,id:"current-settings",baseline},result=bootstrapCurrentScreenplayLibrary(emptyCurrentScreenplayLibrary(root.projectId),asked,0,at+2),state=result.origin.state;
  expect(state.direction.entries[0]!.settings!.seed).toBe(987);expect(state.context.originals[0]).toEqual(request.source);expect(state.context.plan.shots[0]!.seed).not.toBe(987);expect(state.casting.candidate).toEqual(request.baseline.casting);
  const forged=structuredClone(asked);forged.baseline.direction=directionSnapshot(root.projectId,2,[directionEntry({...shots[0]!,prompt:"A different physical action"},{})],at+1);
  expect(()=>bootstrapCurrentScreenplayLibrary(emptyCurrentScreenplayLibrary(root.projectId),forged,0,at+2)).toThrow(/stale legacy shot membership/);
  const doc=context.plan.document,moved=change(doc,[{id:"skip-ancestry",kind:"move",block:block(doc.context.base,doc.scenes[1]!.startLine,doc.scenes[1]!.endLine),to:boundary(doc.context.base,doc.scenes[0]!.startLine)}]),binding=bootstrapLivingScriptDocument(request.source,moved.context);
  expect(()=>bootstrapCurrentScreenplayLibrary(emptyCurrentScreenplayLibrary(root.projectId),{...request,documentSource:binding},0,at+2)).toThrow(/exact original root document/);
},30000);

test("resealed output, missing events, forked lineage, foreign context and altered accepted scripts fail independent replay",()=>{
  const value=adopt(root,propose(root,lineChange(root,"A verified current line.\r\n"),"sealed"),at+1).accepted.library;
  const changes:((library:CurrentScreenplayLibrary)=>void)[]=[
    lib=>{lib.origin!.request.source.job.scriptText+="changed";},
    lib=>{lib.origin!.state.context.plan.shots[0]!.seed++;lib.origin!.state.context.plan=reseal(lib.origin!.state.context.plan);lib.origin!.state=reseal(lib.origin!.state);lib.origin=reseal(lib.origin!);},
    lib=>{lib.proposals[0]!.candidate!.direction.entries[0]!.renderId="shot-v2-forged";lib.proposals[0]!.candidate!.direction=reseal(lib.proposals[0]!.candidate!.direction);lib.proposals[0]!.candidate=reseal(lib.proposals[0]!.candidate!);lib.proposals[0]=reseal(lib.proposals[0]!);},
    lib=>{lib.proposals=[];},
    lib=>{lib.acceptances[0]!.versions[0]!.text+="same version, different bytes";lib.acceptances[0]=reseal(lib.acceptances[0]!);lib.headRevision=lib.acceptances[0]!.revision;},
    lib=>{lib.acceptances[0]!.state.context.lineage.steps=[];lib.acceptances[0]!.state.context.lineage=reseal(lib.acceptances[0]!.state.context.lineage);lib.acceptances[0]!.state=reseal(lib.acceptances[0]!.state);lib.acceptances[0]=reseal(lib.acceptances[0]!);},
    lib=>{lib.proposals[0]!.libraryVersion=1;lib.proposals[0]=reseal(lib.proposals[0]!);},
    lib=>{lib.headRevision=lib.origin!.revision;},
  ];for(const change of changes){const clone=structuredClone(value);change(clone);expect(()=>validateCurrentScreenplayLibrary(reseal(clone))).toThrow();}
  expect(()=>validateCurrentScreenplayLibrary(value,"another-project")).toThrow(/this project/);
  expect(()=>bootstrapCurrentScreenplayLibrary(emptyCurrentScreenplayLibrary(root.projectId),{...request,script:{...request.script,text:"Different same-version script"}},0,at+1)).toThrow(/exact committed screenplay/);
},45000);

test("durable versions preserve all accepted suffixes after later edits and reject altered, missing, squashed or misparented history",()=>{
  const accepted=adopt(root,propose(root,lineChange(root,"A persisted current line.\r\n"),"durable"),at+1).accepted,versions=[...projectVersions,...accepted.versions],latest=versions.at(-1)!,later={version:latest.version+1,text:latest.text+"\r\nA later direct edit.\r\n",createdAt:new Date(at+50).toISOString(),parentVersion:latest.version};
  expect(validateProjectCurrentScreenplay(accepted.library,{projectId:root.projectId,versions:[...versions,later]})).toEqual(accepted.library);
  for(const invalid of [projectVersions,versions.map(v=>v.version===latest.version?{...v,text:v.text+"!"}:v),versions.map(v=>v.version===latest.version?{...v,parentVersion:null}:v),[...versions,{...later,version:latest.version}]])expect(()=>validateProjectCurrentScreenplay(accepted.library,{projectId:root.projectId,versions:invalid})).toThrow();
  expect(validateProjectCurrentScreenplay(undefined,{projectId:root.projectId,versions:projectVersions})).toEqual(emptyCurrentScreenplayLibrary(root.projectId));
  expect(()=>validateProjectCurrentScreenplay(null as any,{projectId:root.projectId,versions:projectVersions})).toThrow();
  expect(validateCurrentScreenplayLibrary(emptyCurrentScreenplayLibrary(root.projectId))).toEqual(emptyCurrentScreenplayLibrary(root.projectId));
},30000);

test("absent and empty libraries preserve unrelated legacy history policy while present roots tolerate later version gaps",()=>{
  const unrelated={version:request.script.version+7,text:"A legacy document".repeat(13000),createdAt:"Tue, 01 Sep 2026 00:00:00 GMT",parentVersion:request.script.version},versions=[...projectVersions,unrelated],before=hash(versions);
  expect(validateProjectCurrentScreenplay(undefined,{projectId:root.projectId,versions})).toEqual(emptyCurrentScreenplayLibrary(root.projectId));
  expect(validateProjectCurrentScreenplay(emptyCurrentScreenplayLibrary(root.projectId),{projectId:root.projectId,versions})).toEqual(emptyCurrentScreenplayLibrary(root.projectId));
  expect(validateProjectCurrentScreenplay(root,{projectId:root.projectId,versions})).toEqual(root);expect(hash(versions)).toBe(before);
  let reads=0;const context={projectId:root.projectId,versions};Object.defineProperty(context,"versions",{enumerable:true,get(){reads++;return versions;}});
  expect(()=>validateProjectCurrentScreenplay(undefined,context)).toThrow(/without accessors/);expect(reads).toBe(0);
},30000);

test("strict portable boundaries reject accessors without reads, symbols, hidden fields, cycles and collection amplification before replay",()=>{
  let reads=0;const getter=structuredClone(root);Object.defineProperty(getter.origin!.request.source.job,"scriptText",{enumerable:true,get(){reads++;return request.script.text;}});
  expect(()=>validateCurrentScreenplayLibrary(getter)).toThrow(/accessors/);expect(reads).toBe(0);
  const cycle:any={};cycle.self=cycle;
  const invalids:any[]=[{...root,version:-0},{...root,proposals:Array(2)},{...root,proposals:[...Array(CURRENT_SCREENPLAY_LIBRARY_LIMITS.proposals+1)].map(()=>({}))},{...root,origin:cycle},Object.assign(Object.create({unexpected:true}),root)];
  const symbol=structuredClone(root);Object.defineProperty(symbol,Symbol("private"),{enumerable:true,value:"hidden"});invalids.push(symbol);
  const hidden=structuredClone(root);Object.defineProperty(hidden,"private",{enumerable:false,value:"hidden"});invalids.push(hidden);
  for(const value of invalids)expect(()=>validateCurrentScreenplayLibrary(value)).toThrow();
  const original=hash(root);expect(()=>saveCurrentScreenplayProposal(root,propose(root,lineChange(root,"Wrong version.\r\n"),"stale-version"),0,at+1)).toThrow(/another window/);expect(hash(root)).toBe(original);
  expect(()=>bootstrapCurrentScreenplayLibrary(emptyCurrentScreenplayLibrary(root.projectId),request,0,Date.parse(request.source.job.completedAt!)-1)).toThrow(/historical settings/);
},30000);

test("a different current cast snapshot never silently changes an immutable bootstrap request",()=>{
  const different=castingSnapshot(root.projectId,request.baseline.casting.version+1,request.baseline.casting.characters.map(character=>({...character,appearance:character.appearance+" A blue hat."})),at+1);
  expect(()=>bootstrapCurrentScreenplayLibrary(root,{...request,baseline:{...request.baseline,casting:different}},root.version,at+2)).toThrow(/another request/);
  const fresh=bootstrapCurrentScreenplayLibrary(emptyCurrentScreenplayLibrary(root.projectId),{...request,baseline:{...request.baseline,casting:different}},0,at+2);
  expect(fresh.origin.state.casting.candidate).toEqual(different);expect(fresh.origin.state.context.originals[0]!.job.casting).toEqual(request.source.job.casting);
  // This pure constructor can describe a candidate origin; only the service checks saved authority and live permissions.
  expect(fresh.origin.state.revision).not.toBe(root.origin!.state.revision);
},30000);
