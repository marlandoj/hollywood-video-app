import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {CARTESIA_MULTILINGUAL_CAPABILITY} from "../../generator/src/audio-capabilities";
import {validateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
import {verifyDialogueMedia} from "../../generator/src/dialogue-replacement";
import {outputRevision} from "../../planner/src/dialogue-selection";
import {retainLipSyncSource,lipSyncWindow} from "../../planner/src/lipsync";
test("owned reviewed language tracks preserve localized takes, captions, review links and immutable archive evidence",async()=>{
  const f=await dubStudio();try{
    const studio=await(await f.call(f.base+"/audio-takes","GET",undefined,f.owner.token)).json() as any;expect(studio.multilingualCapabilityRevision).toBe(CARTESIA_MULTILINGUAL_CAPABILITY.revision);expect(studio.voices[0].dubLanguages).toEqual(["ar","en","es","ja"]);expect(studio.jobs[0].audioTake.localization.review).toBe("owner-reviewed");
    const quote=await f.quote(),body=f.requestBody(quote),path=f.base+"/dialogue/"+f.film.id;expect(quote.lines[0].auditions.find((a:any)=>a.language==="es").text).toBe("Bienvenida al jardín.");
    const before=f.store.all().length;
    for(const patch of [{dub:undefined},{dub:{language:"es",reviewed:false}},{dub:{language:"ar",reviewed:true}},{edits:body.edits.slice(0,1)},{edits:[{...body.edits[0],auditionRevision:"f".repeat(64)},body.edits[1]]}])expect((await f.call(path,"POST",{...body,...patch},f.owner.token)).status).toBeOneOf([400,409]);
    expect(f.store.all()).toHaveLength(before);expect((await f.call(path,"GET")).status).toBe(401);
    const admitted=await f.call(path,"POST",body,f.owner.token);expect(await admitted.clone().text()).not.toContain('"error"');expect(admitted.status).toBe(202);const duplicate=await f.call(path,"POST",body,f.owner.token);expect((await duplicate.json() as any).jobId).toBe((await admitted.json() as any).jobId);
    const job=await f.worker();expect(job?.failureReason??job?.cancelReason).toBeUndefined();expect(job?.status).toBe("done");await verifyDialogueMedia(job!,job!.output!,f.paths.artifactRoot);
    const view=await(await f.call("/api/jobs/"+job!.id,"GET",undefined,f.owner.token)).json() as any;expect(view.captionLanguage).toBe("es");expect(view.dialogue.report.lines.map((l:any)=>l.text)).toEqual(["Bienvenida al jardín.","Entra, amigo."]);
    const captions=await(await fetch(new URL(view.output.captionsUrl,f.server.url))).text();expect(captions).toContain("Bienvenida al jardín.");expect(captions).not.toContain("Welcome to the garden.");
    const lipSource=retainLipSyncSource(job!);expect(lipSource.dialogue.plan.dubLanguage).toBe("es");for(const line of lipSource.dialogue.lines){const window=lipSyncWindow(lipSource,line.shotId,line.source.index);expect(window.endSample-window.startSample).toBe(22050);expect(window.startSample).toBe(line.startSample);}
    expect((await f.call(f.base+"/dialogue-selection","PUT",{jobId:job!.id,sourceJobId:f.film.id,expectedVersion:0,expectedOutputRevision:outputRevision(job!)},f.owner.token)).status).toBe(200);
    const review=await(await f.call(f.base+"/reviews","POST",{permission:"read"},f.owner.token)).json() as any;const reviewed=await(await f.call("/api/reviews/"+review.token)).json() as any;expect(reviewed.captionLanguage).toBe("es");expect(reviewed.jobId).toBe(job!.id);
    const snapshot:StateSnapshot={schema:"hv-state/1",projects:JSON.parse(readFileSync(f.paths.statePath,"utf8")),jobs:f.store.all(),ledger:{events:f.ledger.all(),reservations:[]},reviews:[]};
    // These tones bypass dispatch. A full accounting archive must reject them;
    // the independently owned derived export still validates after source-take expiry.
    expect(()=>validateSnapshot(snapshot)).toThrow("accounting provenance");snapshot.jobs=snapshot.jobs.filter(j=>!j.audioTake);expect(validateSnapshot(snapshot).jobs).toHaveLength(2);
    const bad=structuredClone(snapshot),dub=bad.jobs.find(j=>j.id===job!.id)!;dub.dialogueReplacement!.plan.dubLanguage="ar";expect(()=>validateSnapshot(bad)).toThrow();
    expect((await f.quote(job!.id)).dubLanguage).toBe("es");expect(f.store.get(f.film.id)!.scriptText).toBe(f.film.scriptText);
  }finally{await f.close();}
},45000);
