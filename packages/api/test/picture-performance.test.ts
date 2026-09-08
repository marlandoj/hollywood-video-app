import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {pictureStudio} from "../../../test/fixtures/picture-studio";
import {validateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
import {picturePerformancePrompt} from "../../planner/src/picture-performance";
test("owner picture defaults and overrides survive render, selective reuse, archive validation and stale-scene rebinding",async()=>{
  const f=await pictureStudio();try{
    for(const prefix of ["/api/","/api/direction/","/api/cast/"]){const module=await f.call(prefix+"picture-performance.js");expect(module.status).toBe(200);expect(module.headers.get("content-type")).toContain("text/javascript");}
    expect((await f.scene({emotion:"sad",intensity:"restrained",gestures:["avert-gaze"]})).status).toBe(200);
    const state=await f.view(),character=state.plan[0].pictureCharacters[0],override={characterId:f.id,baseRevision:character.baseRevision,controls:{emotion:"joyful",gestures:["open-palms"]}};
    expect((await f.save({picture:[override]})).status).toBe(200);const first=await f.render(),pictures=first.output!.picturePerformances!;expect(pictures).toHaveLength(2);expect(pictures[0]!.intent.characters[0]!.controls).toEqual({emotion:"joyful",intensity:"restrained",gestures:["open-palms"]});expect(pictures[1]!.intent.characters[0]!.controls.emotion).toBe("sad");
    const manifest=f.manifest(first);expect(manifest.shots[0].picturePerformance).toEqual(pictures[0]!.intent);expect(first.output!.shotRenders![0]!.clip.picturePerformance).toEqual(pictures[0]!.intent);expect((await f.view()).plan[0].picturePrompt).toBe(picturePerformancePrompt(pictures[0]!.intent));
    expect((await f.call(f.base+"/direction","GET")).status).toBe(401);expect((await fetch(new URL("/api/jobs/"+first.id,f.server.url))).status).toBe(404);
    expect((await f.save({picture:[{...override,controls:{emotion:"calm"}}]})).status).toBe(200);const next=await f.render({reuseUnchanged:true});expect(next.shotReuse!.shots.map(s=>s.shotId)).toEqual(["shot-1-2","shot-2-1"]);expect(next.output!.picturePerformances![0]!.intent.characters[0]!.controls.emotion).toBe("calm");expect(f.store.get(first.id)!.output!.picturePerformances).toEqual(pictures);
    const snapshot:StateSnapshot={schema:"hv-state/11",projects:JSON.parse(readFileSync(f.paths.statePath,"utf8")),jobs:f.store.all(),ledger:{events:f.ledger.all(),reservations:[]},reviews:[]};expect(validateSnapshot(snapshot).jobs).toHaveLength(2);
    expect(snapshot.jobs.some(job=>(job.executionCheckpoints??job.dialogueReplacement?.source.executionCheckpoints??[]).length>0)).toBe(true);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/10"})).toThrow("schema 11");
    const bad=structuredClone(snapshot);delete bad.jobs[0]!.output!.picturePerformances;expect(()=>validateSnapshot(bad)).toThrow("exported picture performances");const forged=structuredClone(snapshot);forged.jobs[0]!.output!.shotRenders![0]!.clip.picturePerformance!.characters[0]!.controls.emotion="angry";expect(()=>validateSnapshot(forged)).toThrow("changed");
    expect((await f.scene({emotion:"calm",intensity:"natural"})).status).toBe(200);expect((await f.view()).plan[0].pictureError).toContain("rebind");expect((await f.enqueue()).status).toBe(400);expect((await f.save({picture:[override]})).status).toBe(400);
    const fresh=(await f.view()).plan[0].pictureCharacters[0];expect((await f.save({picture:[{...override,baseRevision:fresh.baseRevision}]})).status).toBe(200);expect((await f.view()).plan[0].pictureError).toBe("");
    expect((await f.save({picture:[{...override,characterId:crypto.randomUUID()}]})).status).toBe(400);
  }finally{await f.close();}
},45000);
test("picture alternatives stay independent in retained take exports and reject stale ownership context",async()=>{
  const f=await pictureStudio();try{
    expect((await f.scene({emotion:"calm",intensity:"natural",gestures:["hold-still"]})).status).toBe(200);const state=await f.view(),shot=state.plan[0],baseRevision=shot.pictureCharacters[0].baseRevision;
    const body={stage:"take-preview",expectedScriptVersion:state.scriptVersion,expectedCastingVersion:2,expectedDirectionVersion:state.direction.version,settings:{shotId:shot.source.id,sourceHash:shot.sourceHash,maxShots:24,takes:[{label:"Restrained",seed:1,settings:{picture:[{characterId:f.id,baseRevision,controls:{intensity:"restrained"}}]}},{label:"Heightened",seed:2,settings:{picture:[{characterId:f.id,baseRevision,controls:{intensity:"heightened",gestures:["shrug"]}}]}}]}};
    const quote=await f.call(f.base+"/takes/quote","POST",body,f.owner.token);expect(await quote.clone().text()).not.toContain('"error"');expect(quote.status).toBe(200);const value=await quote.json() as any;
    const queued=await f.call(f.base+"/takes","POST",{...body,generationApproved:true,providerPlanRevision:value.providerPlanRevision,idempotencyKey:crypto.randomUUID()},f.owner.token);expect(await queued.clone().text()).not.toContain('"error"');expect(queued.status).toBe(202);
    const done=await f.worker();expect(done?.failureReason??done?.cancelReason).toBeUndefined();expect(done?.status).toBe("done");const rendered=done!.output!.picturePerformances!;expect(rendered.map(p=>p.intent.characters[0]!.controls.intensity)).toEqual(["restrained","heightened"]);
    for(const [i,take]of done!.output!.takeClips!.entries()){const manifest=JSON.parse(readFileSync(join(f.paths.artifactRoot,take.manifestPath),"utf8"));expect(manifest.shots[0].picturePerformance).toEqual(rendered[i]!.intent);}
    const snapshot:StateSnapshot={schema:"hv-state/1",projects:JSON.parse(readFileSync(f.paths.statePath,"utf8")),jobs:f.store.all(),ledger:{events:f.ledger.all(),reservations:[]},reviews:[]};expect(validateSnapshot(snapshot).jobs).toHaveLength(1);
  }finally{await f.close();}
},45000);
