import {afterAll,afterEach,beforeAll,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {existsSync,readFileSync,realpathSync,renameSync,writeFileSync} from "node:fs";
import {join,sep} from "node:path";
import {prepareCurrentFilmMixedSourceFixture} from "../../planner/test/current-film-mixed-source.fixture";
import {CURRENT_FILM_SOURCE_CACHE_CASE_NAMES,currentFilmMixedSourceCacheCases,assertCurrentFilmMixedSourceFreshAuthorityAfterWarm} from "../../planner/test/current-film-mixed-source-cache.assertions";
import {assertCurrentFilmMixedCaptionMismatch} from "../../planner/test/current-film-mixed-caption.assertions";
import {currentFilmMixedSourceClock} from "../../planner/src/current-film-mixed-source-clock";
import type {CurrentFilmMixedJob} from "../../planner/src/current-film-mixed-job-context";
import {validateEditSourceReceipt,type EditSourceReceipt} from "../../planner/src/edit-sources";
import {editTimeline,type EditClip} from "../../planner/src/edit-timeline";
import {contentHash as hash} from "../src/capabilities";
import {speechWavHeader} from "../src/speech";
import {soundWavHeader} from "../src/sound-audio";
import {soundProcessingCommand} from "../src/sound-finishing";
import {editFrameHashes} from "../src/edit-picture";
import {conformEdit,editVtt} from "../src/edit-conform";
import {editSourceRecipe,inspectEditSource,prepareEditSources,validatePreparedEditSources,verifyPreparedEditSources,type PreparedEditSources} from "../src/edit-source-media";
import type {DialogueArtifactReader} from "../src/dialogue-replacement";

let f:Awaited<ReturnType<typeof prepareCurrentFilmMixedSourceFixture>>,job:CurrentFilmMixedJob,receipt:EditSourceReceipt,prepared:PreparedEditSources;
let setupActive=false,setupComplete=false,failed=false,passed=0,registered=0,sourceRevision="";
let setupPromise:Promise<void>|undefined;
type Scope={controller:AbortController;finished:boolean;promise:Promise<void>};let active:Scope|undefined;
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...body,revision:hash(body)} as T;};
function current(){if(!setupComplete||failed||!active||active.finished||active.controller.signal.aborted)throw new Error("The mixed editorial media fixture is no longer active.");}
async function drained(promise:Promise<unknown>,milliseconds:number){let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise.then(()=>true,()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),milliseconds);})]);}finally{if(timer)clearTimeout(timer);}}
function cancelWorker(){if(!f?.active)return;const saved=f.store.get(f.request.id);
  if(saved?.status!=="running"||saved.projectId!==f.request.projectId||saved.claimedBy!=="mixed-source-fixture"||hash(saved.currentFilm)!==hash(f.plan))return;
  // Local store reads/cancellation are synchronous: no await can replace this
  // exact holder between observing its fence and the ordinary domain transition.
  const held=f.store.get(saved.id);if(!held||held.claimedBy!==saved.claimedBy||held.leaseVersion!==saved.leaseVersion)return;
  try{f.store.cancel(saved.id,saved.claimedBy,"Mixed source fixture timed out.");}catch{/* An expired/replaced holder must not be cancelled by this fixture. */}
}
function failStop():never{process.stderr.write("Mixed-source fixture work did not drain after failure; preserving resources and stopping this failed runner.\n");process.exit(1);}
const access=async()=>{current();};
async function step<T>(run:(signal:AbortSignal)=>Promise<T>):Promise<T>{current();const result=await run(active!.controller.signal);current();return result;}
function scenario(name:string,run:()=>Promise<void>,timeout=600000){const index=registered++;test(name,async()=>{
  if(!setupComplete||failed||passed!==index||active&&!active.finished)throw new Error("The preceding actual mixed-source phase did not settle.");
  const scope:Scope={controller:new AbortController(),finished:false,promise:Promise.resolve()};active=scope;
  scope.promise=run().then(()=>{current();passed++;},error=>{failed=true;throw error;}).finally(()=>{scope.finished=true;});void scope.promise.catch(()=>{});await scope.promise;
},timeout);}
beforeAll(async()=>{setupActive=true;setupPromise=(async()=>{try{f=await prepareCurrentFilmMixedSourceFixture({longDelivery:true});if(failed)throw new Error("Mixed-source setup was abandoned.");setupComplete=true;}finally{setupActive=false;}})();void setupPromise.catch(()=>{});await setupPromise;},600000);
afterEach(async()=>{if(!active||active.finished)return;failed=true;active.controller.abort(new Error("Mixed source test timed out."));cancelWorker();await drained(active.promise,5000);
},6000);
afterAll(async()=>{if(setupActive||active&&!active.finished||f?.active){failed=true;active?.controller.abort(new Error("Mixed source fixture teardown."));cancelWorker();
    if(setupActive&&setupPromise&&!await drained(setupPromise,5000))failStop();if(active&&!active.finished&&!await drained(active.promise,5000))failStop();if(f?.active)failStop();}
  if(f){const closing=f.close();void closing.catch(()=>{});if(!await drained(closing,10000)){failed=true;failStop();}await closing;}
},25000);

scenario("V3 source admission settles the exact queued request before the worker budget",async()=>{
  sourceRevision=hash(f.f.job);const queued=f.admit();
  expect(queued.status).toBe("queued");expect(queued.startedAt).toBeNull();expect(queued.retriesUsed).toBe(0);
  expect(queued.timeoutMs).toBe(600000);expect(queued.currentFilm).toEqual(f.plan);
  expect(queued.currentFilmProof).toBeUndefined();expect(queued.currentFilmOrigins).toBeUndefined();expect(queued.currentFilmCheckpoint).toBeUndefined();
  expect(hash(f.f.job)).toBe(sourceRevision);
});

scenario("V3 source executes one genuine moved native adoption and fresh worker invocation",async()=>{
  const result=await step(()=>f.execute());
  expect(result?.failureReason??result?.cancelReason).toBeUndefined();expect(result?.status).toBe("done");
});

scenario("V3 source completion validates moved performance and immutable worker custody",async()=>{
  job=f.read();const clock=currentFilmMixedSourceClock(job),span=clock.spans[f.ordinal]!;
  expect(job.status).toBe("done");expect(job.currentFilmProof).toBeDefined();expect(job.currentFilmCheckpoint!.rows[f.ordinal]!.kind).toBe("reused");
  expect(job.currentFilmCheckpoint!.rows.some(row=>row.kind==="generated")).toBe(true);expect(f.ordinal).not.toBe(f.sourceOrdinal);expect(span.spoken.length).toBeGreaterThan(1);
  const first=span.spoken[0]!,originalLine=f.f.plan.materialization.slots[f.sourceOrdinal]!.physical.lines.find(line=>line.lineId===first.original.lineId)!,targetLine=span.target.physical.lines.find(line=>line.lineId===first.lineId)!;
  expect(targetLine.line).not.toBe(originalLine.line);expect(first.source.hash).toBe(first.original.source.hash);
  expect(span.originalRecord).toEqual(f.f.job.currentFilmCheckpoint!.rows[f.sourceOrdinal]!.record);expect(job.costUsd).toBe(0);expect(hash(f.f.job)).toBe(sourceRevision);
  const directed=job.currentFilm.materialization.slots.filter(slot=>slot.shot.direction?.durationFrames===90);
  expect(directed).toHaveLength(1);const delivery=directed[0]!;
  expect(delivery.ordinal).not.toBe(f.ordinal);expect(delivery.physical.spoken).toEqual([]);expect(delivery.shot.dialogue).toEqual([]);
  expect(job.currentFilm.selection[delivery.ordinal]!.kind).toBe("generate");expect(job.currentFilmCheckpoint!.rows[delivery.ordinal]!.kind).toBe("generated");
  expect(delivery.recipe.dispatch.params.durationSec).toBe(3);expect(delivery.recipe.dispatch.params.exactDuration).toBe(true);
  expect(clock.frames).toBeGreaterThan(250);
  expect(f.f.patch.request.operations.some(operation=>operation.id==="terminate-source-tail"&&operation.kind==="replace")).toBe(true);
});

let cacheChecks:ReturnType<typeof currentFilmMixedSourceCacheCases>|undefined;
for(const [index,name]of CURRENT_FILM_SOURCE_CACHE_CASE_NAMES.entries())scenario("V3 settled historical cache: "+name,async()=>{
  current();if(index===0)cacheChecks=currentFilmMixedSourceCacheCases(job);
  if(!cacheChecks||cacheChecks[index]?.name!==name)throw new Error("The genuine completed cache prerequisite is missing.");
  cacheChecks[index]!.run();current();
},60000);

scenario("V3 warm historical caches preserve fresh accepted rights and original execution expiry",async()=>{
  current();const before=hash(f.context.projects.peekProject(job.projectId)),now=Date.now()+1000,accepted=f.accept(now);
  assertCurrentFilmMixedSourceFreshAuthorityAfterWarm(job,accepted,now);
  expect(hash(f.context.projects.peekProject(job.projectId))).toBe(before);current();
},60000);

scenario("V3 streaming inspection retains exact proof and ordered delivery with original performance identities",async()=>{
  const info=async(path:string)=>{const bytes=readFileSync(join(f.root,path));return {path,bytes:bytes.length,sha256:digest(bytes)};};
  const requested:string[]=[],reader:DialogueArtifactReader={async response(projectId,jobId,path,request){current();request.signal.throwIfAborted();expect([projectId,jobId]).toEqual([job.projectId,job.id]);requested.push(path);
    const file=await info(path);return new Response(Bun.file(join(f.root,path)).stream(),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});}};
  receipt=await step(signal=>inspectEditSource(job,"Moved mixed source",f.root,access,signal,reader,info));
  expect(receipt.schema).toBe("hv-edit-source/4");expect(receipt.audio.dialogue).toEqual({kind:"mixed-film-dialogue"});expect(receipt.facts.audio).toEqual(["mix","dialogue"]);
  expect(receipt.facts.voices).toEqual(currentFilmMixedSourceClock(job).voices);expect(receipt.facts.frames).toBe(job.output!.currentFilm.assembly.frames);expect(editSourceRecipe([receipt]).schema).toBe("hv-edit-source-media/4");
  expect(validateEditSourceReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);expect(receipt.files.map(file=>file.path).sort()).toEqual([...requested].sort());expect(new Set(requested).size).toBe(requested.length);
  const playlist=readFileSync(join(f.root,job.output!.hlsPlaylistPath),"utf8"),prefix=job.output!.hlsPlaylistPath.slice(0,-"index.m3u8".length);
  expect(receipt.delivery!.segments).toEqual(playlist.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith("#")).map(name=>prefix+name));
  // Segmentation follows actual encoder keyframes. Qualify the real precondition
  // here, before expensive retained-copy and conform phases need an order swap.
  expect(receipt.delivery!.segments.length).toBeGreaterThanOrEqual(2);
  expect(receipt.files.some(file=>file.path.includes("/proof/"))).toBe(true);expect(receipt.files.some(file=>file.path.includes("/originals/"))).toBe(true);
  const manifest=readFileSync(join(f.root,job.output!.manifestPath),"utf8");expect(manifest).toContain("hv-provenance/3.0");expect(manifest).not.toContain("hv-shot-execution-capture");expect(manifest).not.toContain("hv-current-film-job/3");
});

scenario("V3 inspected delivery keeps every caption mismatch unbound while measured speech survives",async()=>{
  current();assertCurrentFilmMixedCaptionMismatch(receipt);current();
},60000);

scenario("V3 preparation places immutable native PCM at target spans and converts once globally",async()=>{
  prepared=await step(signal=>prepareEditSources([receipt],f.root,join(f.root,"prepared-mixed-source"),access,signal));
  const clock=currentFilmMixedSourceClock(job),source=prepared.sources[0]!,conversion=source.conversions.find(value=>value.lane==="dialogue")!,pcm=Buffer.alloc(clock.frames*735*2);
  for(const span of clock.spans){if(!span.originalRecord.clip.speech)continue;const wav=readFileSync(join(f.root,span.ownedFiles.audio!.path));wav.subarray(44).copy(pcm,span.startFrame*735*2);}
  const native=Buffer.concat([speechWavHeader(clock.frames*735),pcm]);expect(conversion).toMatchObject({kind:"mixed-film-dialogue",inputSha256:digest(native),decodedSamples:clock.frames*1600,padSamples:0,discardSamples:0});
  const input=join(f.f.studio.root,"expected-mixed-native.wav"),output=join(f.f.studio.root,"expected-mixed-48.pcm");writeFileSync(input,native,{flag:"wx"});
  await step(signal=>soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-i",input,"-af","pan=stereo|c0=c0|c1=c0,aresample=48000:resampler=swr:filter_size=64:phase_shift=10:exact_rational=1:dither_method=none","-c:a","pcm_s24le","-f","s24le",output],f.f.studio.root,access,signal));
  const expected=Buffer.concat([soundWavHeader(clock.frames*1600),readFileSync(output)]);expect(readFileSync(join(f.root,source.media.audio.dialogue!.path)).equals(expected)).toBe(true);
  expect(source.copies.map(copy=>copy.original)).toEqual(receipt.files);for(const copy of source.copies)expect(digest(readFileSync(join(f.root,copy.copy.path)))).toBe(copy.original.sha256);
});

scenario("V3 retained copies independently verify and conform a reordered trim with every old owner hidden",async()=>{
  const root=realpathSync(f.root),original=realpathSync(join(root,job.projectId)),hidden=original+"-hidden";
  if(!original.startsWith(root+sep)||!hidden.startsWith(root+sep)||existsSync(hidden))throw new Error("Unsafe mixed-source recovery fixture path.");
  renameSync(original,hidden);
  try{
    await step(signal=>verifyPreparedEditSources(prepared,root,join(root,"prepared-mixed-source"),access,signal));
    const source=prepared.sources[0]!,clock=currentFilmMixedSourceClock(job),spoken=clock.spans[f.ordinal]!.spoken,starts=[Math.floor(spoken[1]!.startSample/1600),Math.floor(spoken[0]!.startSample/1600)],frames=15;
    const clips:EditClip[]=starts.flatMap((from,i)=>(["picture","dialogue","captions"] as const).map(lane=>({id:"mixed-trim-"+i+"-"+lane,sourceId:job.id,lane,layer:0,link:"mixed-trim-"+i,at:i*frames,from,frames,gainDb:0,opacity:1,crop:null,envelope:{from,frames,fadeIn:0,fadeOut:0}})));
    const timeline=editTimeline({schema:"hv-edit-timeline/1",width:receipt.facts.width,height:receipt.facts.height,frames:frames*2,sources:[receipt.facts],clips,markers:[]});
    const originals=await step(signal=>editFrameHashes(join(root,source.media.picture.path),receipt.facts.frames,join(f.f.studio.root,"mixed-original-frames.txt"),f.f.studio.root,access,signal));
    const destination=join(root,"conformed-mixed-trim"),result=await step(signal=>conformEdit(timeline,[source.media],root,destination,access,signal));
    expect(result.pictureFrames).toEqual(starts.flatMap(from=>originals.slice(from,from+frames)));
    const wav=readFileSync(join(root,source.media.audio.dialogue!.path)),expected=Buffer.concat(starts.map(from=>wav.subarray(44+from*1600*6,44+(from+frames)*1600*6)));
    expect(readFileSync(join(destination,"audio/final.wav")).subarray(44).equals(expected)).toBe(true);expect(readFileSync(join(destination,"captions.vtt"),"utf8")).toBe(editVtt(timeline));
    expect(result.pictureFrames).toHaveLength(30);expect(existsSync(join(root,job.projectId,job.id))).toBe(false);expect(existsSync(join(destination,"hls/index.m3u8"))).toBe(true);
  }finally{renameSync(hidden,original);}
});

scenario("V3 source rejects missing segments, forged ordered delivery, streamed corruption and hostile metadata",async()=>{
  let getterReads=0,accessReads=0;const hostile={...job};Object.defineProperty(hostile,"currentFilm",{enumerable:true,get(){getterReads++;return job.currentFilm;}});
  await expect(inspectEditSource(hostile,"Hostile",f.root,async()=>{accessReads++;})).rejects.toThrow("portable");expect(getterReads).toBe(0);expect(accessReads).toBe(0);
  validateEditSourceReceipt(receipt);
  for(const field of ["schema","job","segment"]){let reads=0;const value=structuredClone(receipt),target=field==="segment"?value.delivery!.segments:value,key=field==="segment"?"0":field;
    Object.defineProperty(target,key,{enumerable:true,get(){reads++;throw new Error("A hostile source getter ran.");}});expect(()=>validateEditSourceReceipt(value)).toThrow();expect(reads).toBe(0);}
  const missingProof=structuredClone(receipt);delete missingProof.job.currentFilmProof;expect(()=>validateEditSourceReceipt(reseal(missingProof))).toThrow();
  const changedProof=structuredClone(receipt),output=changedProof.job.output!.currentFilm;if(output?.schema!=="hv-current-film-output/3")throw new Error("Require the genuine mixed output.");
  output.proofRevision="0".repeat(64);changedProof.job.output!.currentFilm=reseal(output);expect(()=>validateEditSourceReceipt(reseal(changedProof))).toThrow();
  const omitted=structuredClone(receipt);omitted.files=omitted.files.filter(file=>file.path!==omitted.delivery!.segments[0]);expect(()=>validateEditSourceReceipt(reseal(omitted))).toThrow();
  const unreviewed=structuredClone(receipt);unreviewed.files.push({...unreviewed.files[0]!,path:job.projectId+"/"+job.id+"/unreviewed.bin"});expect(()=>validateEditSourceReceipt(reseal(unreviewed))).toThrow();
  const foreign=structuredClone(receipt);foreign.files.push({...foreign.files[0]!,path:"foreign-owner/foreign-job/file.bin"});expect(()=>validateEditSourceReceipt(reseal(foreign))).toThrow();
  expect(()=>validateEditSourceReceipt(reseal({...receipt,schema:"hv-edit-source/3" as const}))).toThrow();
  const info=async(path:string)=>receipt.files.find(file=>file.path===path)!;
  const missing:DialogueArtifactReader={async response(_project,_job,path,request){request.signal.throwIfAborted();if(path===receipt.delivery!.segments[0])return null;const file=await info(path);return new Response(Bun.file(join(f.root,path)).stream(),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});}};
  await step(async signal=>{await expect(inspectEditSource(job,"Missing segment",f.root,access,signal,missing,info)).rejects.toThrow("changed or disappeared");});
  const corrupted:DialogueArtifactReader={async response(_project,_owner,path,request){request.signal.throwIfAborted();const file=await info(path),changed=path===receipt.delivery!.segments[0]?Buffer.from(readFileSync(join(f.root,path))):undefined;if(changed)changed[0]^=1;
    return new Response(changed?new Uint8Array(changed):Bun.file(join(f.root,path)).stream(),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});}};
  await step(async signal=>{await expect(inspectEditSource(job,"Corrupt stream with truthful headers",f.root,access,signal,corrupted,info)).rejects.toThrow("checksum verification");});
  const forged=structuredClone(receipt);forged.delivery!.segments.reverse();expect(forged.delivery!.segments).not.toEqual(receipt.delivery!.segments);
  const sealed=reseal(forged);validateEditSourceReceipt(sealed);
  await step(async signal=>{await expect(prepareEditSources([sealed],f.root,join(f.root,"wrong-mixed-delivery"),access,signal)).rejects.toThrow("ordered delivery");});
},300000);

scenario("V3 retained normalization rejects resealed PCM and current withdrawal without mutating originals",async()=>{
  const source=prepared.sources[0]!,path=join(f.root,source.media.audio.dialogue!.path),before=readFileSync(path),changed=Buffer.from(before);changed[200]^=1;
  const forged=structuredClone(prepared),copy=forged.sources[0]!;copy.media.audio.dialogue!.sha256=digest(changed);copy.conversions.find(value=>value.lane==="dialogue")!.output.sha256=digest(changed);const sealed=reseal(forged);
  validatePreparedEditSources(sealed,"prepared-mixed-source");writeFileSync(path,changed);writeFileSync(join(f.root,"prepared-mixed-source/sources.json"),JSON.stringify(sealed));
  try{await step(async signal=>{await expect(verifyPreparedEditSources(sealed,f.root,join(f.root,"prepared-mixed-source"),access,signal)).rejects.toThrow("do not reproduce");});}
  finally{writeFileSync(path,before);writeFileSync(join(f.root,"prepared-mixed-source/sources.json"),JSON.stringify(prepared));}
  const aborted=new AbortController();aborted.abort(new Error("Mixed source cancelled"));await expect(inspectEditSource(job,"Cancelled",f.root,access,aborted.signal)).rejects.toThrow("Mixed source cancelled");
  let reads=0;await step(async signal=>{await expect(inspectEditSource(job,"Withdrawn",f.root,async()=>{current();if(++reads>=3)throw new Error("Current mixed source permission withdrawn");},signal)).rejects.toThrow("Current mixed source permission withdrawn");});
  expect(hash(f.f.job)).toBe(sourceRevision);expect(job.currentFilmCheckpoint!.rows[f.ordinal]!.kind).toBe("reused");
});
