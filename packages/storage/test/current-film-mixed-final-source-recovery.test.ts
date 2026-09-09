// Actual final-mode fixture; QA media providers do not establish production visual quality.
import {afterAll,afterEach,describe,expect,test} from "bun:test";
import {localSourceBrowserCapture,boundedCaptureText} from "./current-film-source-browser-capture.fixture";
import {prepareLegacyMixedSourceOwners} from "./current-film-legacy-mixed-source.fixture";
import {createHash} from "node:crypto";
import {cpSync,existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {join,resolve,sep} from "node:path";
import {prepareCurrentFilmMixedSourceFixture} from "../../planner/test/current-film-mixed-source.fixture";
import {compileCurrentFilmJob} from "../../planner/src/current-film-jobs";
import {compileCurrentFilmMixedJob} from "../../planner/src/current-film-mixed-jobs";
import {currentFilmV3Job} from "../../planner/src/current-film-runtime-context";
import {createCurrentFilmMixedPreviewReview,type CurrentFilmMixedJob} from "../../planner/src/current-film-mixed-job-context";
import {bindOriginalEditSource,bindRetainedEditSource,assertEditBindingAvailable,createEditPlan,editRenderReview,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {assertEditOriginalSelection,type EditSourceReceipt} from "../../planner/src/edit-sources";
import {editHistoryState} from "../../planner/src/edit-history";
import {compileEditScriptSource,resolveEditCurrentFilmMixedScriptSource} from "../../planner/src/edit-script-source";
import {contentHash as hash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {inspectEditSource,verifyEditSourceReceiptMedia} from "../../generator/src/edit-source-media";
import {verifyEditMedia} from "../../generator/src/edit-media";
import {soundRuntimeRevision} from "../../generator/src/sound-audio";
import {parseEditCaptions} from "../../planner/src/edit-captions";
import {DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import {processNextJob,type WorkerContext} from "../../queue/src/worker";
import {verifyCurrentFilmMixedMedia} from "../../queue/src/current-film-mixed-media";
import {ProjectService} from "../../api/src/index";
import {createApiServer,type ApiServer} from "../../api/src/server";
import {mixedSourceOwnerAssertions} from "../../api/test/mixed-source-owner.assertions";
import {readStateSnapshot,writeStateSnapshot,stateSnapshotSchema,validateSnapshot,type StateSnapshot} from "../src/snapshots";

const digest=(path:string)=>{const bytes=readFileSync(path);return {bytes:bytes.byteLength,sha256:createHash("sha256").update(bytes).digest("hex")};};
function removeOwned(path:string,root:string):void {
  if(!existsSync(path))return;
  const owned=realpathSync(root),actual=realpathSync(path);
  if(lstatSync(path).isSymbolicLink()||actual!==resolve(path)||!actual.startsWith(owned+sep))throw new Error("Unsafe final-source fixture removal.");
  rmSync(actual,{recursive:true,force:true});
}
function originalNamespace(binding:EditSourceBinding,artifactRoot:string):string {
  const first=binding.files[0],original=binding.source.files[0];
  if(!first||!original||!first.path.endsWith(original.path))throw new Error("Missing original namespace mapping.");
  const prefix=first.path.slice(0,-original.path.length);
  if(!prefix.endsWith("/")||binding.files.length!==binding.source.files.length)throw new Error("Incomplete original namespace mapping.");
  for(const [i,file]of binding.files.entries()){
    const source=binding.source.files[i]!;
    if(file.path!==prefix+source.path||file.bytes!==source.bytes||file.sha256!==source.sha256)throw new Error("Original namespace changed its ordered copy mapping.");
  }
  const root=realpathSync(artifactRoot),namespace=realpathSync(join(root,prefix));
  if(!namespace.startsWith(root+sep))throw new Error("Original namespace escaped the restored carrier.");
  return namespace;
}

describe("actual approved final /4 retained carrier recovery",()=>{
  type Phase={index:number;controller:AbortController;operation:Promise<void>;finished:boolean};
  let active:Phase|undefined,completed=0,failed=false,fixture:Awaited<ReturnType<typeof prepareCurrentFilmMixedSourceFixture>>|undefined;
  let store:DurableJobStore,preview:CurrentFilmMixedJob,final:CurrentFilmMixedJob,receipt:EditSourceReceipt,carrier:Job,retained:EditSourceBinding;
  let finalInput:JobInput,carrierInput:JobInput,workerResult:Awaited<ReturnType<typeof processNextJob>>;
  let held:{store:DurableJobStore;job:Job}|undefined;
  let base:StateSnapshot,expectedIndex:ReturnType<typeof compileEditScriptSource>,oldOwners:string[]=[],oldJobsRevision:string;
  let prepared:string,archive:string,unpacked:string,recoveryQueuePath:string;
  let approval:NonNullable<ReturnType<ProjectService["recordCurrentFilmDecision"]>>;
  let legacy:ReturnType<typeof prepareLegacyMixedSourceOwners>|undefined,legacyPending:JobInput|undefined,legacyCarrier:JobInput|undefined;
  const legacyReady=()=>{current();if(!legacy)throw new Error("Complete the genuine legacy-wrapper branch first.");return legacy;};
  const actualResult=()=>{current();if(!workerResult)throw new Error("The actual worker did not return a result.");return workerResult;};
  let previousFinalPool:string|undefined,poolCaptured=false;
  let ownerServer:ApiServer|undefined,ownerStatePath:string,ownerAssertions:ReturnType<typeof mixedSourceOwnerAssertions>;
  let directReceipt:EditSourceReceipt;
  const httpPending=new Set<Promise<unknown>>();let closingServer:Promise<void>|undefined;
  const children=new Set<object>();
  const browserCapture=localSourceBrowserCapture();
  let qualifiedArchive:ReturnType<typeof archiveStamp>|undefined;
  function archiveStamp(){const stat=lstatSync(archive);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024**3)throw new Error("The captured archive must be the bounded original regular file.");
    return {dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs};}
  function current():void {if(failed||!active||active.finished||active.controller.signal.aborted)throw new Error("The final-source fixture phase is no longer active.");}
  function signal():AbortSignal {current();return active!.controller.signal;}
  async function checked<T>(run:()=>PromiseLike<T>|T):Promise<T>{current();const result=await run();current();return result;}
  function ready(){current();if(!fixture)throw new Error("Complete genuine source setup first.");return fixture;}
  function cancelHeld():void {
    if(!held)return;
    try{
      const saved=held.store.get(held.job.id);
      if(saved?.status==="running"&&saved.claimedBy===held.job.claimedBy&&saved.leaseVersion===held.job.leaseVersion)
        held.store.cancel(saved.id,saved.claimedBy!,"Final-source recovery fixture phase ended.");
    }catch{/* A lost/expired holder cannot cancel another attempt; teardown still waits or stops the runner. */}
  }
  async function execute(input:JobInput,targetStore=store,baseContext?:WorkerContext):Promise<void>{
    const f=ready(),context:WorkerContext={...(baseContext??f.context),workerId:"final-source-recovery",onJobStarted:async job=>{
      held={store:targetStore,job:structuredClone(job)};
      if(failed||active?.controller.signal.aborted){cancelHeld();throw new Error("The fixture stopped after claim.");}
      current();
    }};
    try{workerResult=await checked(()=>processNextJob(targetStore,f.root,context));}
    finally{held=undefined;}
    if(workerResult?.id!==input.id)throw new Error("The fixture worker processed a different admitted job.");
  }
  async function python(args:string[]):Promise<void>{
    const activeSignal=signal(),child=Bun.spawn(["python",join(import.meta.dir,"../../../scripts/archive-package.py"),...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,HV_BUN_PATH:process.execPath}});
    children.add(child);const abort=()=>child.kill();activeSignal.addEventListener("abort",abort,{once:true});
    try{
      if(activeSignal.aborted)abort();
      if(browserCapture){
        const stdout=boundedCaptureText(child.stdout),stderr=boundedCaptureText(child.stderr);
        try{
          const [code,out,err]=await Promise.all([child.exited,stdout,stderr]);current();
          if(code!==0||err.nonempty){
            await browserCapture.diagnostics(code,out,err,activeSignal,current);current();
            throw new Error("Final-source archive subprocess failed; optional private diagnostics were captured.");
          }
          expect(out.nonempty).toBe(true);
        }catch(error){child.kill();await Promise.allSettled([child.exited,stdout,stderr]);throw error;}
      }else{
        const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
        current();if(code!==0||stderr)throw new Error("Final-source archive subprocess failed; retain the private fixture for diagnosis.");
        expect(stdout.length).toBeGreaterThan(0);
      }
    }finally{activeSignal.removeEventListener("abort",abort);children.delete(child);}
  }
  async function stopOwnerServer():Promise<void>{
    if(closingServer)return closingServer;
    const server=ownerServer;if(!server)return;
    closingServer=Promise.resolve(server.stop(true));
    try{await closingServer;ownerServer=undefined;}finally{closingServer=undefined;}
  }
  function startOwnerServer():void{
    const f=ready();if(ownerServer||closingServer)throw new Error("Close the previous owner server before restart.");
    ownerServer=createApiServer({port:0,hostname:"127.0.0.1",storage:"json",artifactStorage:"local",tls:null,
      statePath:ownerStatePath,queuePath:recoveryQueuePath,costLedgerPath:join(f.f.studio.root,"current-source-ledger.json"),artifactRoot:f.root,
      rateLimit:{api:{limit:10000,windowMs:60000}}});
  }
  async function ownerRequest(method:"GET"|"POST"|"PATCH",path:string,body:Record<string,unknown>|undefined,requestSignal:AbortSignal,authenticated=true){
    const f=ready(),server=ownerServer;if(!server)throw new Error("Start the actual owner HTTP server first.");
    const operation=(async()=>{
      const response=await fetch(new URL("/api/projects/"+f.request.projectId+"/editorial/"+path,server.url),{method,signal:requestSignal,keepalive:false,
        headers:{"content-type":"application/json",...(authenticated?{authorization:"Bearer "+f.f.studio.owner.token}:{})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      const result={status:response.status,body:await response.json() as unknown};requestSignal.throwIfAborted();current();return result;
    })();httpPending.add(operation);
    try{return await operation;}finally{httpPending.delete(operation);}
  }
  function phase(name:string,limit:number,run:()=>Promise<void>){
    const index=phaseCount++;
    test(name,async()=>{
      if(failed||completed!==index||active&&!active.finished)throw new Error("The prior final-source phase did not settle successfully.");
      const scope:Phase={index,controller:new AbortController(),operation:Promise.resolve(),finished:false};active=scope;
      scope.operation=(async()=>{await run();current();completed++;})().catch(error=>{failed=true;throw error;}).finally(()=>{scope.finished=true;});
      void scope.operation.catch(()=>{});await scope.operation;
    },limit);
  }
  let phaseCount=0;
  async function drained(promise:Promise<unknown>,ms:number):Promise<boolean>{let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([promise.then(()=>true,()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]);}
    finally{if(timer!==undefined)clearTimeout(timer);}
  }
  afterEach(async()=>{
    if(!active||active.finished)return;failed=true;active.controller.abort(new Error("Final-source phase deadline."));cancelHeld();await drained(active.operation,5000);
  },6000);
  afterAll(async()=>{
    if(active&&!active.finished){failed=true;active.controller.abort(new Error("Final-source fixture teardown."));cancelHeld();await drained(active.operation,5000);}
    if(active&&!active.finished||children.size||held||fixture?.active||httpPending.size){
      process.stderr.write("Final-source fixture retains unfinished work; stopping this failed runner before another file.\n");process.exit(1);
    }
    const stopping=stopOwnerServer();void stopping.catch(()=>{});
    if(!await drained(stopping,5000)){process.stderr.write("Final-source HTTP shutdown did not drain; preserving fixture and stopping this failed runner.\n");process.exit(1);}await stopping;
    // Restore environment and close only after every signalless worker/child settled.
    if(poolCaptured){if(previousFinalPool===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=previousFinalPool;}
    await fixture?.close();
  },15000);

  phase("prepares genuine bootstrap/V2 sources and the moved mixed preview request",600000,async()=>{
    previousFinalPool=process.env.HV_PROVIDER_POOL;poolCaptured=true;
    fixture=await checked(async()=>{const acquired=await prepareCurrentFilmMixedSourceFixture();fixture=acquired;return acquired;});
    recoveryQueuePath=join(fixture.f.studio.root,"mixed-final-recovery-jobs.json");
    writeFileSync(recoveryQueuePath,JSON.stringify(fixture.store.all()));store=new DurableJobStore(recoveryQueuePath);fixture.store=store;oldJobsRevision=hash(store.all());
    expect(fixture.plan.selection.some(row=>row.kind==="reuse")).toBe(true);
    expect(fixture.plan.selection.some(row=>row.kind==="generate")).toBe(true);
  });
  phase("admits the exact mixed preview as one durable request",60000,async()=>{
    const f=ready(),admitted=store.enqueue(f.request);expect(admitted.currentFilm).toEqual(f.plan);expect(admitted.timeoutMs).toBe(600000);
  });
  // The 900s *harness* bounds match the existing phased PG worker suite; the
  // actual admitted generation deadline stays 600s, with no timeout/clock mocks.
  phase("runs the actual mixed preview under its unchanged 600s worker deadline",900000,async()=>{await execute(ready().request);});
  phase("validates completed preview bytes and records the exact owner approval",600000,async()=>{
    const f=ready();preview=currentFilmV3Job(JSON.parse(JSON.stringify(workerResult)));expect(preview.status).toBe("done");expect(preview.stage).toBe("animatic");
    expect(preview.currentFilmCheckpoint!.rows.some(row=>row.kind==="reused")).toBe(true);
    expect(preview.currentFilmCheckpoint!.rows.some(row=>row.kind==="generated")).toBe(true);
    await checked(()=>verifyCurrentFilmMixedMedia(preview,f.root,async()=>{current();},signal()));
    const review=createCurrentFilmMixedPreviewReview(preview);approval=f.context.projects.recordCurrentFilmDecision(f.f.studio.owner.token,preview,review,"approved","Use the actual mixed preview for this final-source recovery fixture")!;
    expect(approval.approval.currentFilmReview).toEqual(review);const before=hash(f.context.projects.snapshot());
    expect(f.context.projects.recordCurrentFilmDecision(f.f.studio.owner.token,preview,review,"approved","Use the actual mixed preview for this final-source recovery fixture")!.replayed).toBe(true);
    expect(hash(f.context.projects.snapshot())).toBe(before);
  });
  phase("compiles and admits a distinct genuine render-stage final",120000,async()=>{
    const f=ready();process.env.HV_PROVIDER_POOL='["mock"]';
    const render=compileCurrentFilmJob(f.saved.library,f.plan.selector,{role:"render",tier:"free",providerPlan:createProviderPlan("final",5,undefined,process.env)});
    const plan=compileCurrentFilmMixedJob(render,{origins:[],choices:[]});
    finalInput={...f.request,id:"mixed-approved-final",idempotencyKey:"mixed-approved-final",currentFilm:plan,stage:plan.render.stage,tier:plan.render.tier,
      scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,
      totalFrames:plan.materialization.requestedFrames,animaticJobId:preview.id,animaticApprovedAt:approval.approval.at,timeoutMs:600000};
    expect(plan.render.stage).toBe("final");expect(plan.render.role).toBe("render");expect(plan.revision).not.toBe(preview.currentFilm.revision);
    expect(plan.target).toEqual(preview.currentFilm.target);expect(plan.selection.every(row=>row.kind==="generate")).toBe(true);
    expect(store.enqueue(finalInput).timeoutMs).toBe(600000);
  });
  phase("runs the separately admitted final under its unchanged 600s worker deadline",900000,async()=>{await execute(finalInput);});
  phase("verifies actual final media, native records and its owned preview proof",600000,async()=>{
    const f=ready();final=currentFilmV3Job(JSON.parse(JSON.stringify(workerResult)));expect(final.status).toBe("done");expect(final.stage).toBe("final");expect(final.currentFilm.render.role).toBe("render");
    expect(final.id).toBe(finalInput.id);expect(final.animaticJobId).toBe(preview.id);expect(final.animaticApprovedAt).toBe(approval.approval.at);
    expect(final.output).toBeDefined();expect(final.currentFilmCheckpoint!.rows.every(row=>row.kind==="generated")).toBe(true);
    expect(final.currentFilmProof!.specification.target!.animaticJobId).toBe(preview.id);
    expect(final.currentFilmProof!.specification.previews.some(row=>row.jobId===preview.id)).toBe(true);
    expect(final.currentFilmProof!.specification.frozenContext.jobs.some(job=>job.id===preview.id)).toBe(true);
    for(const row of final.currentFilmCheckpoint!.rows){if(row.kind!=="generated")throw new Error("Final recipes must have real fresh records.");expect(row.capture).toBeDefined();expect(row.record.revision).toMatch(/^[a-f0-9]{64}$/);}
    expect(final.routeDecisions!.length).toBeGreaterThan(0);expect(final.costUsd).toBe(0);expect(f.context.ledger.jobSpend(final.id)).toBe(0);
    await checked(()=>verifyCurrentFilmMixedMedia(final,f.root,async()=>{current();},signal()));
    // The fixture is actual final-mode code/clock/approval/custody execution.
    // Its pinned mock visual provider and eSpeak PCM are QA, not production visual/voice approval.
  });
  phase("inspects the genuine final as receipt four without changing its historical execution",600000,async()=>{
    const f=ready(),before=hash(final),access=async()=>{current();assertEditOriginalSelection(final,store.get(final.id),f.context.projects.authorize(f.f.studio.owner.token));};
    receipt=await checked(()=>inspectEditSource(final,"Actual approved final retained original",f.root,access,signal()));
    expect(receipt.schema).toBe("hv-edit-source/4");expect(hash(final)).toBe(before);expect(receipt.job).toEqual(final);
    if(receipt.schema!=="hv-edit-source/4"||!receipt.delivery)throw new Error("The final source must retain the V3 receipt contract.");
    expect(receipt.delivery.segments.length).toBeGreaterThan(0);expect(receipt.audio.dialogue).toEqual({kind:"mixed-film-dialogue"});
    expect(receipt.facts.captions).toEqual(parseEditCaptions(readFileSync(join(f.root,final.output!.captionsPath),"utf8"),receipt.facts.frames));
    directReceipt=receipt;
    expectedIndex=compileEditScriptSource(receipt);expect(resolveEditCurrentFilmMixedScriptSource(receipt).index).toEqual(expectedIndex);
    expect(expectedIndex.scriptText).toBe(final.currentFilm.target.state.context.plan.document.context.base.text);
  });
  // Independent real branch: parent state, queue and ledger remain unchanged.
  // These Jobs are never relabelled as V3 or fabricated from the final output.
  phase("prepares a separate actual current-script ordinary animatic for the legacy wrapper",120000,async()=>{
    const f=ready();legacy=prepareLegacyMixedSourceOwners({state:f.context.projects.snapshot(),jobs:store.all(),context:f.context,root:f.root,workingRoot:f.f.studio.root,token:f.f.studio.owner.token,receipt});legacy.begin();
  });
  phase("runs the actual ordinary animatic under its unchanged 120s worker budget",180000,async()=>{
    const f=legacyReady();await execute(f.ordinaryInput,f.store,f.context);
  });
  phase("saves a real pending proposal whose full library2 retains unselected final4",600000,async()=>{
    const f=legacyReady();legacyPending=await checked(()=>f.propose(actualResult(),async()=>{current();},signal()));
  });
  phase("runs the actual legacy pending animatic under its unchanged 120s worker budget",180000,async()=>{
    const f=legacyReady();if(!legacyPending)throw new Error("Save the exact pending proposal first.");await execute(legacyPending,f.store,f.context);
  });
  phase("inspects the actual legacy receipt and qualifies its catalog owner before admission",600000,async()=>{
    const f=legacyReady();legacyCarrier=await checked(()=>f.retain(actualResult(),async()=>{current();},signal()));
  });
  phase("renders the actual legacy-wrapper editorial carrier under its 180s worker budget",300000,async()=>{
    const f=legacyReady();if(!legacyCarrier)throw new Error("Admit the exact wrapper carrier first.");await execute(legacyCarrier,f.store,f.context);
  });
  phase("qualifies exact input and prepared legacy-wrapper ownership from actual copied media",600000,async()=>{
    const f=legacyReady();await checked(()=>f.verifyCarrier(actualResult(),async()=>{current();},signal()));
  });
  phase("refuses canonical origin replacement and missing authentic nested preview authority",120000,async()=>{legacyReady().rejectCanonicalReplacement();});
  phase("preserves final source bytes and removes only the settled auxiliary branch",120000,async()=>{
    const branch=legacyReady(),f=ready();branch.verifyOriginals();
    for(const id of branch.createdIds)removeOwned(join(f.root,final.projectId,id),f.f.studio.root);
    removeOwned(branch.folder,f.f.studio.root);branch.verifyOriginals();legacy=undefined;
  });
  phase("opens the production owner HTTP server over real persisted state and creates a legacy seed sequence",180000,async()=>{
    const f=ready(),initial=f.context.projects.snapshot();ownerStatePath=join(f.f.studio.root,"final-owner-projects.json");
    expect(initial.projects[0]!.editLibrary?.sources.some(source=>source.schema==="hv-edit-source/4")??false).toBe(false);
    writeFileSync(ownerStatePath,JSON.stringify(initial),{flag:"wx"});f.context.projects=new ProjectService(ownerStatePath);startOwnerServer();
    const unauthorized=await ownerRequest("GET","sources/"+final.id,undefined,signal(),false);expect(unauthorized.status).toBe(401);
    const inspected=await ownerRequest("GET","sources/"+f.f.studio.film.id,undefined,signal());expect(inspected.status).toBe(200);
    const legacy=(inspected.body as {sources:{jobId:string;sourceRevision:string;facts:{id:string}}[]}).sources[0]!;
    const create=await ownerRequest("POST","sequences",{id:"final-source-carrier",label:"Legacy sequence before mixed admission",sources:[{jobId:legacy.jobId,sourceRevision:legacy.sourceRevision}],firstSourceId:legacy.facts.id,width:320,height:180,expectedVersion:initial.projects[0]!.editLibrary?.version??0},signal());
    expect(create.status).toBe(201);expect(new ProjectService(ownerStatePath).snapshot().projects[0]!.editLibrary!.schema).toBe("hv-edit-library/1");
    ownerAssertions=mixedSourceOwnerAssertions({job:final,legacySequenceId:"final-source-carrier",newSequenceId:"final-source-only",
      request:(method,path,body,active)=>ownerRequest(method,path,body,active),
      readState:async()=>{current();return new ProjectService(ownerStatePath).snapshot();},
      executionRevision:async()=>{current();return hash({jobs:store.all(),sourceLedger:f.f.studio.ledger.all(),currentLedger:f.context.ledger.all()});},
      reload:async()=>{
        const stateBytes=readFileSync(ownerStatePath),queueBytes=readFileSync(recoveryQueuePath),old=ownerServer;
        await checked(stopOwnerServer);f.context.projects=new ProjectService(ownerStatePath);startOwnerServer();
        expect(ownerServer).not.toBe(old);expect(readFileSync(ownerStatePath).equals(stateBytes)).toBe(true);expect(readFileSync(recoveryQueuePath).equals(queueBytes)).toBe(true);
      }});
  });
  if(browserCapture)phase("optionally captures the settled owner boundary before any mixed-source save",600000,async()=>{
    const f=ready();await checked(stopOwnerServer);
    const metadata=[ownerStatePath,recoveryQueuePath,f.f.studio.paths.queuePath,join(f.f.studio.root,"current-source-jobs.json"),
      f.f.studio.paths.costLedgerPath,join(f.f.studio.root,"current-source-ledger.json"),join(f.f.studio.root,"reviews.json"),join(f.f.studio.root,"current-source-reviews.json")];
    const read=(path:string):unknown=>{
      current();const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024**2)throw new Error("Capture metadata must be bounded regular files.");
      return JSON.parse(readFileSync(path,"utf8"));
    };
    const seal=()=>metadata.map(path=>{if(!existsSync(path))return null;read(path);return digest(path);});
    const boundary=JSON.stringify(seal());
    const snapshot=():StateSnapshot=>{
      current();if(ownerServer||closingServer||httpPending.size||children.size||held||f.active)throw new Error("Settle all fixture work before browser capture.");
      if(JSON.stringify(seal())!==boundary)throw new Error("The persisted browser-capture boundary changed.");
      const projects=new ProjectService(ownerStatePath).snapshot(),project=projects.projects[0]!;
      if(projects.projects.length!==1||project.id!==final.projectId||project.editLibrary?.sources.some(source=>source.schema==="hv-edit-source/4"))throw new Error("Capture A requires the exact pre-mixed-save project.");
      const jobs:Job[]=[],byId=new Map<string,string>();
      for(const path of [recoveryQueuePath,f.f.studio.paths.queuePath,join(f.f.studio.root,"current-source-jobs.json")]){
        const rows=read(path);if(!Array.isArray(rows))throw new Error("Capture requires complete persisted queue arrays.");
        for(const job of rows as Job[]){const body=JSON.stringify(job),previous=byId.get(job.id);
          if(previous!==undefined){if(previous!==body)throw new Error("Capture queue owners disagree.");continue;}
          byId.set(job.id,body);jobs.push(job);
        }
      }
      const histories=[f.f.studio.paths.costLedgerPath,join(f.f.studio.root,"current-source-ledger.json")].map(path=>read(path) as StateSnapshot["ledger"]);
      const ledger:StateSnapshot["ledger"]={events:histories.flatMap(value=>value.events),reservations:histories.flatMap(value=>value.reservations),
        ...(histories.some(value=>value.audioAttempts!==undefined)?{audioAttempts:histories.flatMap(value=>value.audioAttempts??[])}:{}),
        ...(histories.some(value=>value.lipSyncAttempts!==undefined)?{lipSyncAttempts:histories.flatMap(value=>value.lipSyncAttempts??[])}:{})};
      const reviews=[join(f.f.studio.root,"reviews.json"),join(f.f.studio.root,"current-source-reviews.json")].flatMap(path=>existsSync(path)?read(path) as StateSnapshot["reviews"]:[]);
      return {schema:stateSnapshotSchema(projects,jobs),projects,jobs,ledger,reviews};
    };
    await checked(()=>browserCapture.snapshot(snapshot,f.root,f.f.studio.owner,signal(),current));
    expect(JSON.stringify(seal())).toBe(boundary);f.context.projects=new ProjectService(ownerStatePath);startOwnerServer();
  });
  phase("owner HTTP inspects the genuine final without persisting its mixed receipt",600000,async()=>{await checked(()=>ownerAssertions.inspect(signal()));});
  phase("owner HTTP first creates the mixed-only saved sequence from the inspected receipt",600000,async()=>{await checked(()=>ownerAssertions.create(signal()));});
  phase("owner HTTP admits the exact mixed source into the existing legacy sequence",120000,async()=>{await checked(()=>ownerAssertions.admit(signal()));});
  phase("independent local server restart reopens both sequences and measured physical navigation",120000,async()=>{
    const result=await checked(()=>ownerAssertions.reloadAndNavigate(signal()));
    // Public inspection has a server-authored display label; compare every
    // non-label fact and all original execution/file evidence with direct native inspection.
    const facts=(source:EditSourceReceipt)=>{const {label:_label,...value}=source.facts;return value;};
    expect(result.receipt.job).toEqual(directReceipt.job);expect(result.receipt.files).toEqual(directReceipt.files);
    expect(result.receipt.delivery).toEqual(directReceipt.delivery);expect(result.receipt.audio).toEqual(directReceipt.audio);expect(facts(result.receipt)).toEqual(facts(directReceipt));
    expect(compileEditScriptSource(result.receipt).entries).toEqual(expectedIndex.entries);
    receipt=result.receipt;expectedIndex=compileEditScriptSource(receipt);
  });
  phase("owner HTTP reviews the retained two-source cut and admits the existing provider-free carrier",120000,async()=>{
    ready();const route="sequences/final-source-carrier",saved=new ProjectService(ownerStatePath).snapshot(),project=saved.projects.find(project=>project.id===final.projectId)!,library=project.editLibrary!;
    let sequence=library.sequences.find(sequence=>sequence.id==="final-source-carrier")!,version=library.version;
    const change=async(value:Record<string,unknown>)=>{
      const response=await ownerRequest("PATCH",route,{expectedVersion:version,expectedHistoryRevision:sequence.history.revision,change:value},signal());expect(response.status).toBe(200);
      const result=response.body as {libraryVersion:number;sequence:typeof sequence};version=result.libraryVersion;sequence=result.sequence;
    };
    await change({kind:"edit",label:"One second with full original handles",operation:{kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-editHistoryState(sequence.history).timeline.frames,ripple:true}});
    await change({kind:"edit",label:"Use approved final picture and performance",operation:{kind:"replace",clipId:"initial-0",linked:true,sourceId:receipt.facts.id,from:0,frames:30,timing:"normal",ripple:true}});
    const currentState=new ProjectService(ownerStatePath).snapshot(),currentProject=currentState.projects.find(project=>project.id===final.projectId)!,timeline=editHistoryState(sequence.history).timeline;
    expect(timeline.clips.every(clip=>clip.sourceId===receipt.facts.id)).toBe(true);
    const bindings=sequence.sourceRevisions.map(revision=>{const source=currentProject.editLibrary!.sources.find(source=>source.revision===revision);if(!source)throw new Error("The HTTP sequence lost an exact retained original.");return bindOriginalEditSource(source);});
    expect(bindings.map(binding=>binding.source.schema)).toEqual(["hv-edit-source/1","hv-edit-source/4"]);
    const pictureEdit=createEditPlan(sequence,bindings,soundRuntimeRevision(),"local",hash("mixed-final-source-carrier"),editRenderReview(timeline)),origin=bindings[0]!.source.job;
    carrierInput={id:"mixed-final-retained-carrier",projectId:final.projectId,idempotencyKey:"mixed-final-retained-carrier",tier:"free",stage:"picture-edit",scriptVersion:origin.scriptVersion,scriptText:origin.scriptText,
      rightsAttestedAt:currentProject.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:30,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:180000,pictureEdit};
    expect(store.enqueue(carrierInput).pictureEdit).toEqual(pictureEdit);
    // This is still the original fixture's one carrier worker. Every source
    // catalog entry now has its own actual copy, including the legacy seed.
    await checked(stopOwnerServer);
  });
  phase("renders the actual editorial carrier with the existing 180s editorial deadline",300000,async()=>{await execute(carrierInput);});
  phase("verifies full retained originals and snapshots actual costs, journals and versions",600000,async()=>{
    const f=ready();carrier=JSON.parse(JSON.stringify(workerResult)) as Job;expect(carrier.status).toBe("done");expect(carrier.id).toBe(carrierInput.id);expect(carrier.output).toEqual(carrier.editCheckpoint);
    expect(carrier.output!.editorial!.conform.pictureFrames).toHaveLength(30);expect(carrier.costUsd).toBe(0);
    retained=bindRetainedEditSource(carrier,receipt.revision);assertEditBindingAvailable(retained,carrier);expect(retained.source).toEqual(receipt);
    await checked(()=>verifyEditMedia(carrier,carrier.output!,f.root,async()=>{current();},signal()));
    expect(compileEditScriptSource(retained.source)).toEqual(expectedIndex);
    const histories=[f.f.studio.paths.costLedgerPath,join(f.f.studio.root,"current-source-ledger.json")].map(path=>JSON.parse(readFileSync(path,"utf8")) as StateSnapshot["ledger"]);
    const events=histories.flatMap(value=>value.events),reservations=histories.flatMap(value=>value.reservations);
    expect(reservations).toHaveLength(0);expect(events).toEqual([...f.f.studio.ledger.all(),...f.context.ledger.all()]);
    const reviews=[join(f.f.studio.root,"reviews.json"),join(f.f.studio.root,"current-source-reviews.json")].flatMap(path=>existsSync(path)?JSON.parse(readFileSync(path,"utf8")) as StateSnapshot["reviews"]:[]);
    const projects=f.context.projects.snapshot();oldOwners=[...new Set([...store.all(),...f.f.studio.store.all()].filter(job=>job.id!==carrier.id).map(job=>job.id))];
    expect(oldOwners).toContain(preview.id);expect(oldOwners).toContain(final.id);expect(oldOwners).toContain(f.f.job.id);expect(oldOwners).toContain(f.f.studio.film.id);
    // No history or actual record is removed from nested receipts/proof. Only the
    // outer owner inventory changes after actual editorial copy completion.
    base={schema:"hv-state/16",projects,jobs:[structuredClone(carrier)],ledger:{events,reservations},reviews};
    expect(stateSnapshotSchema(base.projects,base.jobs)).toBe("hv-state/16");
    expect(base.projects.projects[0]!.versions).toEqual(projects.projects[0]!.versions);
    expect(base.projects.projects[0]!.animaticApprovals).toEqual(projects.projects[0]!.animaticApprovals);
    expect(hash(store.all().filter(job=>job.id!==preview.id&&job.id!==final.id&&job.id!==carrier.id))).toBe(oldJobsRevision);
  });
  phase("removes every original and preview top-level owner before validating or packing the carrier-only snapshot",180000,async()=>{
    const f=ready();prepared=join(f.f.studio.root,"approved-final-prepared");archive=join(f.f.studio.root,"approved-final.zip");unpacked=join(f.f.studio.root,"approved-final-unpacked");
    // The service snapshot and the fixture's accessible queues now contain only
    // the genuine carrier. Neither validator nor archive gets a synthetic owner.
    for(const path of [recoveryQueuePath,f.f.studio.paths.queuePath,join(f.f.studio.root,"current-source-jobs.json")])writeFileSync(path,JSON.stringify(base.jobs));
    store=new DurableJobStore(recoveryQueuePath);f.store=store;
    for(const id of oldOwners){removeOwned(join(f.root,final.projectId,id),f.f.studio.root);expect(store.get(id)).toBeUndefined();expect(existsSync(join(f.root,final.projectId,id))).toBe(false);}
    expect(store.all().map(job=>job.id)).toEqual([carrier.id]);
    expect(validateSnapshot(base)).toBe(base); // Fails until own-proof preview scope is supported.
    writeStateSnapshot(prepared,base);mkdirSync(join(prepared,"artifacts",final.projectId),{recursive:true});
    cpSync(join(f.root,final.projectId,carrier.id),join(prepared,"artifacts",final.projectId,carrier.id),{recursive:true});
    for(const id of oldOwners)expect(existsSync(join(prepared,"artifacts",final.projectId,id))).toBe(false);
  });
  phase("packs schema sixteen solely from the completed retained carrier",600000,async()=>{
    ready();await python(["pack","--source",prepared,"--output",archive,"--project",final.projectId]);expect(existsSync(archive)).toBe(true);
    if(browserCapture)qualifiedArchive=archiveStamp();
  });
  phase("removes all source media and independently unpacks the archive",600000,async()=>{
    const f=ready();removeOwned(join(f.root,final.projectId),f.f.studio.root);removeOwned(join(prepared,"artifacts"),f.f.studio.root);
    await python(["unpack","--source",archive,"--output",unpacked]);
    const restored=readStateSnapshot(unpacked);expect(restored).toEqual(base);expect(restored.jobs.map(job=>job.id)).toEqual([carrier.id]);
    expect(readFileSync(join(unpacked,"state/projects.json")).equals(readFileSync(join(prepared,"state/projects.json")))).toBe(true);
    expect(ProjectService.fromState(restored.projects).snapshot()).toEqual(restored.projects);
    for(const id of oldOwners)expect(existsSync(join(unpacked,"artifacts",final.projectId,id))).toBe(false);
  });
  phase("reverifies native proof, exact delivery, physical navigation and the carrier from independent bytes",600000,async()=>{
    const f=ready(),restored=readStateSnapshot(unpacked),restoredJob=restored.jobs[0]!,binding=bindRetainedEditSource(restoredJob,receipt.revision),root=join(unpacked,"artifacts");
    expect(binding).toEqual(retained);expect(binding.source.job).toEqual(final);expect(binding.source.job.currentFilmProof).toEqual(final.currentFilmProof);
    for(const file of restoredJob.output!.editorial!.files)expect(digest(join(root,file.path))).toEqual({bytes:file.bytes,sha256:file.sha256});
    for(const [i,file]of binding.files.entries())expect(digest(join(root,file.path))).toEqual({bytes:receipt.files[i]!.bytes,sha256:receipt.files[i]!.sha256});
    const probe=join(f.f.studio.root,"independent-final-receipt-probe");mkdirSync(probe);
    await checked(()=>verifyEditSourceReceiptMedia(binding.source,originalNamespace(binding,root),probe,async()=>{current();},signal()));
    await checked(()=>verifyEditMedia(restoredJob,restoredJob.output!,root,async()=>{current();},signal()));
    expect(compileEditScriptSource(binding.source)).toEqual(expectedIndex);
    expect(resolveEditCurrentFilmMixedScriptSource(binding.source).documentRevision).toBe(final.currentFilm.target.state.context.plan.document.revision);
    expect(restored.ledger).toEqual(base.ledger);expect(restored.projects).toEqual(base.projects);
    // No standalone bootstrap/source/preview/final directory was reconstructed.
    for(const id of oldOwners)expect(existsSync(join(root,final.projectId,id))).toBe(false);
  });
  if(browserCapture)phase("optionally preserves the already-reverified independent carrier-only archive",600000,async()=>{
    const f=ready();if(children.size||held||f.active||httpPending.size||ownerServer||closingServer)throw new Error("Settle the native/archive fixture before capture B.");
    const state=readStateSnapshot(unpacked);expect(state).toEqual(base);const stamp=qualifiedArchive;
    if(!stamp)throw new Error("Capture the identity of the actual packed archive first.");expect(archiveStamp()).toEqual(stamp);
    await checked(()=>browserCapture.archive(archive,stamp,state,f.f.studio.owner,signal(),current));
    expect(archiveStamp()).toEqual(stamp);expect(readStateSnapshot(unpacked)).toEqual(base);
  });
});
