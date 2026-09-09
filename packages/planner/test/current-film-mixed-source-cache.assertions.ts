/** Reuse the actual settled native fixture. These synchronous assertions create
 * no Job, worker, media, receipt or current permission grant. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {serialize} from "node:v8";
import type {PersistedProject} from "../../api/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {createCurrentFilmMixedOutput,type CurrentFilmMixedJob} from "../src/current-film-mixed-job-context";
import {currentFilmMixedSourceClock,validateCurrentFilmMixedSourceClock,CURRENT_FILM_MIXED_SOURCE_LIMITS,type CurrentFilmMixedSourceClock} from "../src/current-film-mixed-source-clock";
import {validateCompletedCurrentFilmMixedSource,assertCurrentFilmMixedSourcePermission} from "../src/current-film-mixed-source-permission";
import {castingSnapshot,currentCasting} from "../src/casting";
import {editValidationKey} from "../src/edit-validation-key";

const snapshotDigest=(value:unknown)=>createHash("sha256").update(serialize(value)).digest("hex");
const api={completed:validateCompletedCurrentFilmMixedSource,clock:currentFilmMixedSourceClock,
  validateClock:validateCurrentFilmMixedSourceClock,limits:CURRENT_FILM_MIXED_SOURCE_LIMITS};
const refused=(run:()=>unknown)=>{try{run();return false;}catch{return true;}};
export const CURRENT_FILM_SOURCE_CACHE_CASE_NAMES=["same-object-and-equal-copy-are-detached", "returned-job-and-clock-mutations-do-not-escape", "same-object-retained-revision-mutation-misses", "warm-completed-source-refuses-invalid-progress-proof-and-lifetime", "warm-clock-refuses-complete-input-and-resealed-result-changes", "warm-hidden-accessor-and-sparse-inputs-remain-fail-closed", "runtime-readable-clock-capacities-are-not-bypassed", "unmarked-metadata-clock-compatibility-remains-distinct", "map-collision", "array-iterator-descriptor-skip", "native-next-descriptor-skip", "intrinsic-descriptor-getters-stay-unread"] as const;

/** Each case is invoked by its own settled native scenario. A missing/failed
 * prerequisite refuses before any mutation, including global hook mutation. */
export function currentFilmMixedSourceCacheCases(input:CurrentFilmMixedJob):ReadonlyArray<{name:string;run:()=>void}> {
  const original=snapshotDigest(input),cases:{name:string;run:()=>void}[]=[];let passed=0,failed=false;
  const phase=(name:string,run:()=>void)=>{const index=cases.length;cases.push({name,run(){
    assert.equal(failed,false);assert.equal(passed,index);assert.equal(snapshotDigest(input),original);
    try{run();assert.equal(snapshotDigest(input),original);passed++;}catch(error){failed=true;throw error;}
  }});};
  let baseline:CurrentFilmMixedSourceClock;
  phase("same-object-and-equal-copy-are-detached",()=>{
    const one=api.completed(input),two=api.completed(input),three=api.completed(structuredClone(input));
    for(const value of [one,two,three]){assert.deepEqual(value,input);assert.notEqual(value,input);assert.notEqual(value.currentFilmProof,input.currentFilmProof);}
    assert.notEqual(one.currentFilmProof,two.currentFilmProof);assert.notEqual(two.output,three.output);
    baseline=api.clock(input);const next=api.clock(input),equal=api.clock(structuredClone(input));
    assert.deepEqual(next,baseline);assert.deepEqual(equal,baseline);assert.notEqual(next.spans,baseline.spans);
    assert.notEqual(next.spans[0]!.originalCapture,baseline.spans[0]!.originalCapture);
  });
  phase("returned-job-and-clock-mutations-do-not-escape",()=>{
    const checked=api.completed(input),clock=api.clock(input);
    checked.currentFilmProof!.specification.target!.jobId="mutated-return";
    checked.output!.currentFilm.assembly.frames++;checked.currentFilmCheckpoint!.rows.reverse();
    clock.spans[0]!.target.shot.prompt="mutated returned target";
    clock.spans[0]!.originalCapture.routes.reverse();clock.spans[0]!.originalRecord.clip.seed++;
    clock.spans[0]!.ownedFiles.video.sha256="f".repeat(64);
    const spoken=clock.spans.flatMap(span=>span.spoken)[0];assert.ok(spoken);
    spoken.source.text="mutated returned source";spoken.original.source.text="mutated returned original";
    clock.voices[0]!.start++;assert.deepEqual(api.completed(input),input);assert.deepEqual(api.clock(input),baseline!);
  });
  phase("same-object-retained-revision-mutation-misses",()=>{
    const value=structuredClone(input);api.completed(value);api.clock(value);
    value.output!.mp4Path=value.projectId+"/"+value.id+"/unindexed-other.mp4";
    // This path is syntactically owned, so a full-body cache must not return the
    // old public Job. Existing metadata semantics determine acceptance; no new
    // byte/index assertion is invented at this historical-only boundary.
    const checked=api.completed(value);assert.equal(checked.output!.mp4Path,value.output!.mp4Path);
    assert.notEqual(api.clock(value).sourceOutputRevision,baseline!.sourceOutputRevision);
  });
  phase("warm-completed-source-refuses-invalid-progress-proof-and-lifetime",()=>{
    const mutations:((value:CurrentFilmMixedJob)=>void)[]=[
      value=>{value.status="queued";},value=>{delete value.currentFilmProof;},
      value=>{Object.assign(value,{currentFilmProof:undefined});},value=>{value.currentFilmCheckpoint!.rows.pop();},
      value=>{value.routeDecisions=[];},value=>{value.linkExpiresAt=value.completedAt;},
      value=>{value.output!.currentFilm.proofRevision="e".repeat(64);},
    ];
    for(const mutate of mutations){const value=structuredClone(input) as CurrentFilmMixedJob;mutate(value);assert.throws(()=>api.completed(value));}
  });
  phase("warm-clock-refuses-complete-input-and-resealed-result-changes",()=>{
    const moved=structuredClone(input);moved.output!.currentFilm!.assembly.spans[0]!.endFrame++;assert.throws(()=>api.clock(moved));
    const journal=structuredClone(input);journal.routeDecisions=[];assert.throws(()=>api.clock(journal));
    const changed=structuredClone(baseline!);changed.spans[0]!.startSample++;
    const {revision:_old,...body}=changed;changed.revision=contentHash(body);
    assert.throws(()=>api.validateClock(changed,input));assert.deepEqual(api.validateClock(baseline!,input),baseline!);
  });
  phase("warm-hidden-accessor-and-sparse-inputs-remain-fail-closed",()=>{
    let reads=0;
    for(const location of ["currentFilm","proof","output"]){const value=structuredClone(input);
      const object=location==="proof"?value.currentFilmProof!:location==="output"?value.output!:value;
      const key=location==="proof"?"specification":location==="output"?"currentFilm":"currentFilm";
      Object.defineProperty(object,key,{enumerable:true,get(){reads++;throw new Error("Hostile getter was invoked.");}});
      assert.throws(()=>api.completed(value));assert.throws(()=>api.clock(value));}
    const hidden=structuredClone(input);Object.defineProperty(hidden,"hiddenCacheAlias",{value:undefined,enumerable:false});
    assert.throws(()=>api.completed(hidden));assert.throws(()=>api.clock(hidden));
    const sparse=structuredClone(input);delete sparse.currentFilmCheckpoint!.rows[0];assert.throws(()=>api.clock(sparse));
    // A transparent Proxy can reproduce the warm canonical key, but the
    // original structuredClone fence must still refuse it before any hit.
    const proxy=new Proxy(input,{});assert.throws(()=>api.completed(proxy));assert.throws(()=>api.clock(proxy));
    assert.equal(reads,0);assert.deepEqual(api.clock(input),baseline!);
  });
  phase("runtime-readable-clock-capacities-are-not-bypassed",()=>{
    const before=Object.getOwnPropertyDescriptors(api.limits);
    try{
      for(const [key,value]of [["spans",0],["spoken",0],["outputBytes",1],["inputBytes",1]] as const){
        Object.defineProperty(api.limits,key,{...before[key]!,value});assert.throws(()=>api.clock(input));
        Object.defineProperty(api.limits,key,before[key]!);assert.deepEqual(api.clock(input),baseline!);
      }
    }finally{Object.defineProperties(api.limits,before);}
  });
  phase("unmarked-metadata-clock-compatibility-remains-distinct",()=>{
    // Compatibility projection only: all execution rows are the authentic
    // completed bytes' records, but this stripped proof envelope is not claimed
    // to be an actual saved historical unmarked run or a recoverable /4 source.
    const unmarked=structuredClone(input) as CurrentFilmMixedJob;delete unmarked.currentFilmProof;
    const output=unmarked.output!;output.currentFilm=createCurrentFilmMixedOutput(unmarked,output.currentFilm.assembly,output.currentFilm.degradedShots);
    assert.throws(()=>api.completed(unmarked));
    const derived=api.clock(unmarked);assert.equal(derived.frames,baseline!.frames);assert.equal(derived.authority,"historical-only");
    assert.equal(derived.mediaVerified,false);assert.deepEqual(api.clock(unmarked),derived);
    assert.deepEqual(api.completed(input),input);assert.deepEqual(api.clock(input),baseline!);
  });
  for(const name of ["map-collision","array-iterator-descriptor-skip","native-next-descriptor-skip"]){phase(name,()=>{
    api.completed(input);api.clock(input);const warmKey=editValidationKey(input,256*1024**2);
    assert.notEqual(warmKey,null);
    const mapDescriptor=Object.getOwnPropertyDescriptor(Array.prototype,"map")!,originalMap=mapDescriptor.value;
    const iteratorDescriptor=Object.getOwnPropertyDescriptor(Array.prototype,Symbol.iterator)!,iteratorFactory=iteratorDescriptor.value;
    const iteratorPrototype=Object.getPrototypeOf(Reflect.apply(iteratorFactory,[],[])),nextDescriptor=Object.getOwnPropertyDescriptor(iteratorPrototype,"next")!,originalNext=nextDescriptor.value;
    const invalid=structuredClone(input);let reads=0;
    if(name==="map-collision")invalid.status="failed";
    else Object.defineProperty(invalid,"status",{enumerable:true,configurable:true,get(){return ++reads<=2?"done":"failed";}});
    let keyEqual=false,sourceRejected=false,clockRejected=false;
    // No await, assertion framework or external callback while a global hook is
    // changed. The exact native descriptors are restored before assertions.
    try{
      if(name==="map-collision")Object.defineProperty(Array.prototype,"map",{...mapDescriptor,value:function(this:unknown[],callback:unknown,thisArg?:unknown){
        const mapped=Reflect.apply(originalMap,this,[callback,thisArg]) as unknown[];
        if(this.includes("id")&&this.includes("status")&&this.includes("startedAt"))for(let index=0;index<this.length;index++)
          if(this[index]==="status"&&mapped[index]==='"status":"failed"')mapped[index]='"status":"done"';
        return mapped;
      }});
      else if(name==="array-iterator-descriptor-skip")Object.defineProperty(Array.prototype,Symbol.iterator,{...iteratorDescriptor,value:function(this:unknown[]){
        const iterator=Reflect.apply(iteratorFactory,this,[]),skip=this.includes("id")&&this.includes("startedAt")&&this.includes("status");
        return {next(){let step=Reflect.apply(originalNext,iterator,[]) as IteratorResult<unknown>;if(skip&&!step.done&&step.value==="status")step=Reflect.apply(originalNext,iterator,[]);return step;},[Symbol.iterator](){return this;}};
      }});
      else Object.defineProperty(iteratorPrototype,"next",{...nextDescriptor,value:function(this:unknown,...args:unknown[]){
        let step=Reflect.apply(originalNext,this,args) as IteratorResult<unknown>;
        if(!step.done&&step.value==="status")step=Reflect.apply(originalNext,this,args);return step;
      }});
      reads=0;keyEqual=editValidationKey(invalid,256*1024**2)===warmKey;
      reads=0;sourceRejected=refused(()=>api.completed(invalid));reads=0;clockRejected=refused(()=>api.clock(invalid));
    }finally{
      Object.defineProperty(Array.prototype,"map",mapDescriptor);Object.defineProperty(Array.prototype,Symbol.iterator,iteratorDescriptor);Object.defineProperty(iteratorPrototype,"next",nextDescriptor);
    }
    assert.equal(keyEqual,true);assert.equal(sourceRejected,true);assert.equal(clockRejected,true);
    assert.deepEqual(api.clock(input),baseline!);
  });}
  phase("intrinsic-descriptor-getters-stay-unread",()=>{
    api.completed(input);api.clock(input);
    const mapDescriptor=Object.getOwnPropertyDescriptor(Array.prototype,"map")!,previousValue=Object.getOwnPropertyDescriptor(Object.prototype,"value");
    const invalid=structuredClone(input);Object.defineProperty(invalid,"hidden",{value:undefined,enumerable:false});
    let intrinsicReads=0,valueReads=0,sourceRejected=false,clockRejected=false;
    try{
      const mapAccessor=Object.assign(Object.create(null),{enumerable:mapDescriptor.enumerable,configurable:true,get(){intrinsicReads++;throw new Error("Nonstandard map getter");}});
      Object.defineProperty(Array.prototype,"map",mapAccessor);
      Object.defineProperty(Object.prototype,"value",{configurable:true,get(){valueReads++;throw new Error("Inherited descriptor value getter");}});
      sourceRejected=refused(()=>api.completed(invalid));clockRejected=refused(()=>api.clock(invalid));
    }finally{
      if(previousValue)Object.defineProperty(Object.prototype,"value",previousValue);else delete (Object.prototype as Record<string,unknown>).value;
      Object.defineProperty(Array.prototype,"map",mapDescriptor);
    }
    assert.equal(sourceRejected,true);assert.equal(clockRejected,true);assert.equal(intrinsicReads,0);assert.equal(valueReads,0);
  });
  assert.deepEqual(cases.map(value=>value.name),CURRENT_FILM_SOURCE_CACHE_CASE_NAMES);return cases;
}

/** Warm historical caches never replace a fresh current-project decision. The
 * caller supplies f.accept(now), which returns an authentic detached acceptance. */
export function assertCurrentFilmMixedSourceFreshAuthorityAfterWarm(input:CurrentFilmMixedJob,accepted:PersistedProject,now:number):void {
  const original=snapshotDigest(input),projectBefore=snapshotDigest(accepted);
  api.completed(input);api.clock(input);
  assert.doesNotThrow(()=>assertCurrentFilmMixedSourcePermission(input,accepted,now+1));
  const noRights=structuredClone(accepted);noRights.rightsAttestedAt=null;
  assert.throws(()=>assertCurrentFilmMixedSourcePermission(input,noRights,now+1));
  const expired=structuredClone(accepted);expired.deleteAfter=new Date(now).toISOString();
  assert.throws(()=>assertCurrentFilmMixedSourcePermission(input,expired,now+1));
  const revoked=structuredClone(accepted),cast=currentCasting(revoked.id,revoked.castingHistory),characters=structuredClone(cast.characters);
  const used=new Set(input.currentFilm.materialization.slots.flatMap(slot=>slot.shot.characterIds??[]));
  const current=characters.find(character=>used.has(character.id));assert.ok(current);current.permission.status="revoked";
  revoked.castingHistory!.push(castingSnapshot(revoked.id,cast.version+1,characters,now));
  assert.throws(()=>assertCurrentFilmMixedSourcePermission(input,revoked,now+1));
  const saved=input.casting!.characters.find(character=>used.has(character.id)&&character.permission.expiresAt!==null);assert.ok(saved);
  const at=Date.parse(saved.permission.expiresAt!),renewed=structuredClone(accepted),latest=currentCasting(renewed.id,renewed.castingHistory),renewedCharacters=structuredClone(latest.characters);
  for(const character of renewedCharacters)character.permission.expiresAt=null;
  renewed.castingHistory!.push(castingSnapshot(renewed.id,latest.version+1,renewedCharacters,at-1));
  assert.ok(Date.parse(renewed.deleteAfter)>at);
  assert.throws(()=>assertCurrentFilmMixedSourcePermission(input,renewed,at),/not permitted/);
  assert.equal(snapshotDigest(input),original);assert.equal(snapshotDigest(accepted),projectBefore);
}
