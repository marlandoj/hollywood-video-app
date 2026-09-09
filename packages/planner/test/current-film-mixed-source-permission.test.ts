import {afterAll,afterEach,beforeAll,describe,expect,test} from "bun:test";
import type {PersistedProject} from "../../api/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {prepareCurrentFilmMixedSourceFixture} from "./current-film-mixed-source.fixture";
import {assertCurrentFilmMixedSourcePermission,validateCompletedCurrentFilmMixedSource} from "../src/current-film-mixed-source-permission";
import {validateCompletedCurrentFilmSource} from "../src/current-film-job-context";
import type {CurrentFilmMixedJob} from "../src/current-film-mixed-job-context";
import {castingSnapshot,currentCasting} from "../src/casting";
import {currentScreenplayHead} from "../src/current-screenplay-library";
import {assertEditOriginalSelection,assertEditSourceAvailable} from "../src/edit-sources";
import {inspectEditSource} from "../../generator/src/edit-source-media";

describe("completed V3 source historical evidence and fresh permission",()=>{
  let fixture:Awaited<ReturnType<typeof prepareCurrentFilmMixedSourceFixture>>|undefined,completed:CurrentFilmMixedJob|undefined;
  let pending:Promise<unknown>|undefined,stopped=false,inspection:AbortController|undefined;
  function track<T>(run:()=>Promise<T>):Promise<T>{
    const work=run().finally(()=>{if(pending===work)pending=undefined;});pending=work;void work.catch(()=>{});return work;
  }
  function source():CurrentFilmMixedJob {
    if(stopped||pending||!completed||!fixture||fixture.active)throw new Error("The actual mixed source fixture must settle before permission checks.");
    return completed;
  }
  async function drain(work:Promise<unknown>,milliseconds:number):Promise<boolean>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([work.then(()=>true,()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),milliseconds);})]);}
    finally{if(timer!==undefined)clearTimeout(timer);}
  }
  function undrained():never {
    process.stderr.write("Mixed source permission fixture did not drain; preserving its resources and stopping this failed test runner.\n");process.exit(1);
  }
  // Actual V2/bootstrap and V3 generation have distinct, unchanged budgets.
  beforeAll(async()=>{await track(async()=>{fixture=await prepareCurrentFilmMixedSourceFixture();if(stopped)throw new Error("Source setup was abandoned.");});},600000);
  beforeAll(async()=>{
    if(!fixture||pending||stopped)throw new Error("Actual source setup did not settle.");
    await track(async()=>{const job=await fixture!.run();if(stopped)throw new Error("Source execution was abandoned.");completed=job;});
  },600000);
  afterEach(()=>{if(pending){stopped=true;inspection?.abort(new Error("Source permission scenario was abandoned."));}});
  afterAll(async()=>{
    stopped=true;inspection?.abort(new Error("Source permission fixture teardown."));
    if(pending){
      const work=pending,held=fixture?.store.get(fixture.request.id);
      if(fixture&&held?.status==="running"&&held.projectId===fixture.project.id&&held.claimedBy==="mixed-source-fixture"){
        // Synchronous local holder check/cancel: no different holder can be
        // substituted between these operations. The worker still must settle.
        try{fixture.store.cancel(held.id,held.claimedBy,"Source permission fixture failed or timed out");}catch{/* Lease loss is handled by the real worker. */}
      }
      if(!await drain(work,10000))undrained();
    }
    if(fixture){const closing=fixture.close();void closing.catch(()=>{});if(!await drain(closing,10000))undrained();await closing;}
  },25000);

  test("requires actual V3 mixed execution, prepared proof and complete immutable output",()=>{
    const job=source(),before=contentHash(job),checked=validateCompletedCurrentFilmMixedSource(job);
    expect(checked.status).toBe("done");expect(checked.currentFilmCheckpoint!.rows.some(row=>row.kind==="generated")).toBe(true);
    expect(checked.currentFilmCheckpoint!.rows.some(row=>row.kind==="reused")).toBe(true);
    expect(checked.output!.currentFilm.proofRevision).toBe(checked.currentFilmProof!.revision);
    expect(checked.currentFilmCheckpoint!.rows).toHaveLength(checked.currentFilm.materialization.slots.length);
    expect(checked).toEqual(job);expect(checked).not.toBe(job);expect(checked.currentFilmProof).not.toBe(job.currentFilmProof);
    checked.output!.currentFilm.assembly.frames++;checked.currentFilmProof!.revision="a".repeat(64);
    expect(validateCompletedCurrentFilmMixedSource(job)).toEqual(job);expect(contentHash(job)).toBe(before);
    expect(()=>validateCompletedCurrentFilmMixedSource(fixture!.f.job)).toThrow();
    expect(()=>validateCompletedCurrentFilmSource(job)).toThrow();
  },30000);

  test("rejects missing custody, incomplete checkpoints and resealed output-to-proof substitution",()=>{
    const job=source();
    const modifications:((value:CurrentFilmMixedJob)=>void)[]=[
      value=>{delete value.currentFilmProof;},value=>{delete value.currentFilmOrigins;},value=>{delete value.currentFilmCheckpoint;},value=>{delete value.output;},
      value=>{value.currentFilmCheckpoint!.rows.pop();},value=>{value.routeDecisions=[];},
      value=>{value.output!.currentFilm.proofRevision="b".repeat(64);const {revision:_revision,...body}=value.output!.currentFilm;value.output!.currentFilm.revision=contentHash(body);},
      value=>{value.currentFilmProof!.specification.target!.jobId="different-target";},
      value=>{value.status="queued";},value=>{value.completedAt=new Date(Date.parse(value.startedAt!)-1).toISOString();},
      value=>{value.completedAt=new Date(Date.parse(value.currentFilmProof!.preparedAt)-1).toISOString();},value=>{value.linkExpiresAt=value.completedAt;},
    ];
    for(const modify of modifications){const changed=structuredClone(job);modify(changed);expect(()=>validateCompletedCurrentFilmMixedSource(changed)).toThrow();}
    expect(validateCompletedCurrentFilmMixedSource(job)).toEqual(job);
  },60000);

  test("descriptor checks precede original, proof and output reads on warm inputs",()=>{
    const job=source();validateCompletedCurrentFilmMixedSource(job);let reads=0;
    const candidates=[structuredClone(job),structuredClone(job),structuredClone(job),structuredClone(job)];
    Object.defineProperty(candidates[0]!,"currentFilm",{enumerable:true,get(){reads++;return job.currentFilm;}});
    Object.defineProperty(candidates[1]!.currentFilmProof!,"specification",{enumerable:true,get(){reads++;return job.currentFilmProof!.specification;}});
    Object.defineProperty(candidates[2]!.output!.currentFilm.assembly,"frames",{enumerable:true,get(){reads++;return job.output!.currentFilm.assembly.frames;}});
    Object.defineProperty(candidates[3]!.currentFilm.origins[0]!.binding.source.job,"casting",{enumerable:true,get(){reads++;return fixture!.f.job.casting;}});
    for(const value of candidates)expect(()=>validateCompletedCurrentFilmMixedSource(value)).toThrow("portable");expect(reads).toBe(0);
    const hidden=structuredClone(job);Object.defineProperty(hidden,"unreviewed",{value:undefined,enumerable:false});
    expect(()=>validateCompletedCurrentFilmMixedSource(hidden)).toThrow("portable");
    expect(()=>validateCompletedCurrentFilmMixedSource({...job,currentFilmProof:undefined})).toThrow();
  },30000);

  test("retained target and original execution follow accepted ancestry without fresh carrier leases",()=>{
    const job=source(),now=Date.now()+1000,accepted=fixture!.accept(now),before=contentHash(job);
    expect(()=>assertCurrentFilmMixedSourcePermission(job,fixture!.project,now+1)).not.toThrow();
    expect(()=>assertCurrentFilmMixedSourcePermission(job,accepted,now+1)).not.toThrow();
    expect(accepted.currentScreenplay!.headRevision).not.toBe(job.currentFilm.baseline.headRevision);
    const expired={...job,linkExpiresAt:new Date(Date.parse(job.completedAt!)+1).toISOString()};
    expect(()=>assertCurrentFilmMixedSourcePermission(expired,accepted,now+1)).not.toThrow();
    const live=fixture!.context.projects.peekProject(job.projectId);expect(live).not.toBeNull();
    expect(()=>assertCurrentFilmMixedSourcePermission(job,live,now+1)).not.toThrow();expect(contentHash(job)).toBe(before);
  },60000);

  test("current project rights, retention, cast revocation and exact saved ancestry remain mandatory",()=>{
    const job=source(),now=Date.now()+1000,accepted=fixture!.accept(now);
    const modifications:((value:PersistedProject)=>void)[]=[
      value=>{value.rightsAttestedAt=null;},value=>{value.deleteAfter=new Date(now).toISOString();},value=>{value.id="foreign-project";},
      value=>{value.currentScreenplay=undefined;},value=>{value.versions=value.versions.slice(0,-1);},
      value=>{const last=value.versions.at(-1)!;value.versions.push({...last,version:last.version+1,parentVersion:last.version,text:last.text+"\nUnrelated script edit.\n",createdAt:new Date(now).toISOString()});},
    ];
    for(const modify of modifications){const current=structuredClone(accepted);modify(current);expect(()=>assertCurrentFilmMixedSourcePermission(job,current,now+1)).toThrow();}
    const revoked=structuredClone(accepted),cast=currentCasting(revoked.id,revoked.castingHistory),characters=structuredClone(cast.characters);
    const used=job.currentFilm.materialization.slots.flatMap(slot=>slot.shot.characterIds??[])[0]!;
    characters.find(character=>character.id===used)!.permission.status="revoked";
    revoked.castingHistory!.push(castingSnapshot(revoked.id,cast.version+1,characters,now));
    expect(()=>assertCurrentFilmMixedSourcePermission(job,revoked,now+1)).toThrow();
    for(const time of [NaN,Infinity,-1])expect(()=>assertCurrentFilmMixedSourcePermission(job,accepted,time)).toThrow();
  },60000);

  test("scene grants follow the same physical heading across distinct source and target scene numbers",()=>{
    const job=source(),now=Date.now()+1000,accepted=fixture!.accept(now),target=job.currentFilm.materialization.slots[fixture!.ordinal]!,
      original=fixture!.f.plan.materialization.slots[fixture!.sourceOrdinal]!,document=currentScreenplayHead(accepted.currentScreenplay!)!.state.context.plan.document;
    expect(target.sceneIndex).not.toBe(original.sceneIndex);expect(target.physical.headingLineId).toBe(original.physical.headingLineId);
    const physical=document.scenes.find(scene=>scene.headingLineId===target.physical.headingLineId)!,number=physical.sceneIndex+1,
      cast=currentCasting(accepted.id,accepted.castingHistory),characters=structuredClone(cast.characters),character=characters.find(value=>value.id===target.shot.characterIds![0])!;
    character.permission.scope="scenes";character.permission.sceneNumbers=[number];character.sceneBindings=[{sceneNumber:number,heading:physical.heading}];
    accepted.castingHistory!.push(castingSnapshot(accepted.id,cast.version+1,characters,now));
    expect(()=>assertCurrentFilmMixedSourcePermission(job,accepted,now+1)).not.toThrow();
    const wrongHeading=structuredClone(accepted);character.sceneBindings[0]!.heading="INT. DIFFERENT PHYSICAL SCENE - NIGHT";
    wrongHeading.castingHistory!.push(castingSnapshot(accepted.id,cast.version+2,characters,now));
    expect(()=>assertCurrentFilmMixedSourcePermission(job,wrongHeading,now+1)).toThrow("physical scene");
    character.sceneBindings=[{sceneNumber:original.sceneIndex+1,heading:original.heading}];character.permission.sceneNumbers=[original.sceneIndex+1];
    const staleNumber=structuredClone(accepted);staleNumber.castingHistory!.push(castingSnapshot(accepted.id,cast.version+2,characters,now));
    expect(()=>assertCurrentFilmMixedSourcePermission(job,staleNumber,now+1)).toThrow();
  },60000);

  test("renewing current grants cannot silently extend the saved execution grant",()=>{
    const job=source(),accepted=fixture!.accept(Date.now()),used=new Set(job.currentFilm.materialization.slots.flatMap(slot=>slot.shot.characterIds??[])),
      saved=job.casting!.characters.find(character=>used.has(character.id)&&character.permission.expiresAt!==null)!;
    expect(saved).toBeDefined();const now=Date.parse(saved.permission.expiresAt!),cast=currentCasting(accepted.id,accepted.castingHistory),characters=structuredClone(cast.characters);
    for(const character of characters)character.permission.expiresAt=null;
    accepted.castingHistory!.push(castingSnapshot(accepted.id,cast.version+1,characters,now-1));
    expect(Date.parse(accepted.deleteAfter)).toBeGreaterThan(now);
    expect(()=>assertCurrentFilmMixedSourcePermission(job,accepted,now)).toThrow("not permitted");
  },60000);

  test("fresh authority getters never run, including retained screenplay and current grants",()=>{
    const job=source(),now=Date.now()+1000;let reads=0;
    for(const key of ["id","versions","currentScreenplay","castingHistory","referenceAssets","rightsAttestedAt","deleteAfter"] as const){
      const project=structuredClone(fixture!.project),value=project[key];
      Object.defineProperty(project,key,{enumerable:true,get(){reads++;return value;}});
      expect(()=>assertCurrentFilmMixedSourcePermission(job,project,now)).toThrow();
    }
    const nested=structuredClone(fixture!.project);Object.defineProperty(nested.castingHistory!.at(-1)!.characters[0]!.permission,"status",{enumerable:true,get(){reads++;return "permitted";}});
    expect(()=>assertCurrentFilmMixedSourcePermission(job,nested,now)).toThrow();expect(reads).toBe(0);
  },60000);

  test("selection validates the complete current V3 body before comparing identities",()=>{
    const job=source(),now=Date.now()+1000;let reads=0;
    expect(()=>assertEditOriginalSelection(job,job,fixture!.project,now)).not.toThrow();
    for(const key of ["currentFilm","output","id","completedAt","linkExpiresAt"] as const){
      const current=structuredClone(job),value=current[key];Object.defineProperty(current,key,{enumerable:true,get(){reads++;return value;}});
      expect(()=>assertEditOriginalSelection(job,current,fixture!.project,now)).toThrow();
    }
    expect(reads).toBe(0);
  },60000);

  test("availability validates current descriptors after an actual complete V3 inspection",async()=>{
    const job=source();inspection=new AbortController();const signal=inspection.signal;
    const receipt=await track(()=>inspectEditSource(job,"Actual mixed permission source",fixture!.root,async()=>{signal.throwIfAborted();},signal));
    if(stopped)throw new Error("Source inspection was abandoned.");
    expect(receipt.schema).toBe("hv-edit-source/4");expect(receipt.delivery!.segments.length).toBeGreaterThan(0);
    const now=Date.now();expect(()=>assertEditSourceAvailable(receipt,job,now)).not.toThrow();let reads=0;
    for(const key of ["currentFilm","output","id","completedAt","linkExpiresAt"] as const){
      const current=structuredClone(job),value=current[key];Object.defineProperty(current,key,{enumerable:true,get(){reads++;return value;}});
      expect(()=>assertEditSourceAvailable(receipt,current,now)).toThrow();
    }
    expect(reads).toBe(0);
  },300000);
});
