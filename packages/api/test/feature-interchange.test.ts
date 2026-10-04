/**
 * HV-023-05 — the owner downloads the joined feature's cut as OTIO and as a CMX 3600 EDL.
 *
 * The real studio flow against the real API and worker, on the mock providers, as HV-030-30's own test
 * makes it: a three-sequence feature, each sequence through to its film, the three films joined into
 * one `feature-film` job. Both files are downloaded from
 * `/api/projects/:projectId/feature-film/:jobId/interchange/{otio,edl}`, read back by HV-023-04's
 * independent readers, and checked shot by shot against the finals' own render records and against the
 * joined export's ffprobe length. Nobody but the owner can download them; an unfinished join, an older
 * join and a join whose screenplay has changed since are refused; neither file names a token or URL.
 */
import {afterAll,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {DurableJobStore,type Job} from "../../queue/src/index";
import {processNextJob,type WorkerContext} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {ReferenceBlobStore} from "../../storage/src/references";
import {FEATURE_FILM_CROSSFADE_FRAMES,FINAL_SHOT_CROSSFADE_FRAMES} from "../../planner/src/feature-film";
// @ts-expect-error -- the studio is a plain browser module with no type declarations.
import {createStudioFlow} from "../../frontend/src/studio.js";
import {evenFeature} from "../../../test/fixtures/feature-script";
import {otioAsEvents,readEdl,readOtio,type ReadClip} from "../../../test/fixtures/interchange-readers";

const SCRIPT="Title: The Long Yard\nAuthor: Ana Ruiz\n\n"+evenFeature(3,13);
const TMP=mkdtempSync(join(realpathSync(tmpdir()),"hv-feature-interchange-"));
const config={HV_TOKEN_SECRET:"feature-interchange-fixture-secret-at-least-thirty-two-characters",HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"};
const original=Object.fromEntries([...Object.keys(config),"HV_GRAPHICS_CHROME_PATH"].map(key=>[key,process.env[key]]));
afterAll(()=>{
  rmSync(TMP,{recursive:true,force:true});
  for(const [key,value]of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
});

/** A studio on its own data, a worker over it, and the creator's flow through the front door. */
async function studio(name:string){
  const root=join(TMP,name),paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
  Object.assign(process.env,config);delete process.env.HV_GRAPHICS_CHROME_PATH;
  const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,operatorDiagnosticsSecret:null,rateLimit:{api:{limit:100000,windowMs:60000}},crewModel:null});
  const store=new DurableJobStore(paths.queuePath),ledger=new CostLedger(paths.costLedgerPath);
  const context:WorkerContext={projects:new ProjectService(paths.statePath),ledger,references:new ReferenceBlobStore(paths.artifactRoot),reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))};
  const work=()=>processNextJob(store,paths.artifactRoot,context),base=server.url.origin;
  const api=async(path:string,init:RequestInit={})=>{const response=await fetch(base+path,init),body=await response.json() as any;if(!response.ok)throw new Error(path+" "+response.status+" "+body.error);return body;};
  let project:{projectId:string;token:string}|undefined;
  const flow=createStudioFlow({api,getProject:()=>project,setProject:(value:typeof project)=>{project=value;},wait:async()=>{await work();}});
  const call=(path:string,token:string|undefined,method="GET",body?:unknown)=>fetch(base+path,{method,headers:{...(token?{authorization:"Bearer "+token}:{}),...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {server,store,ledger,paths,flow,work,call,project:()=>project!,close:()=>server.stop(true)};
}

/** Where each sequence's shots sit in the joined film, worked from the finals' render records as the worker and the assembler join them. */
function expectedShots(finals:Job[],films:string[]){
  const sequences=finals.map((final,index)=>{
    const records=final.output!.shotRenders!,frames=records.map(record=>Math.round(record.clip.durationSec*30)),overlap=records.some(record=>record.clip.speech)?0:FINAL_SHOT_CROSSFADE_FRAMES;
    const starts=frames.map((_,shot)=>frames.slice(0,shot).reduce((sum,value)=>sum+value-overlap,0));
    return {number:index+1,film:films[index]!,records,frames,overlap,starts,length:starts.at(-1)!+frames.at(-1)!};
  });
  const join=sequences.every(sequence=>sequence.length>=4*FEATURE_FILM_CROSSFADE_FRAMES)?FEATURE_FILM_CROSSFADE_FRAMES:0;
  const clips:ReadClip[]=[];let start=0;
  for(const sequence of sequences){
    const first=sequence.number===1,last=sequence.number===sequences.length;
    sequence.records.forEach((record,shot)=>{
      const sourceIn=shot===0?(first?0:join/2):sequence.starts[shot]!+Math.floor(sequence.overlap/2);
      const sourceOut=shot===sequence.records.length-1?(last?sequence.length:sequence.length-join/2):sequence.starts[shot+1]!+Math.floor(sequence.overlap/2);
      clips.push({name:`Sequence ${sequence.number} shot ${record.shotId}`,jobId:sequence.film,clipId:`s${sequence.number}-${record.shotId}`,sourceIn,sourceOut,recordIn:start+sourceIn,recordOut:start+sourceOut,
        dissolveIn:shot===0&&!first&&join?{before:join/2,after:join/2}:null});
    });
    start+=sequence.length-(last?0:join);
  }
  return {clips,frames:start,join};
}

test("the owner downloads the joined feature's cut as OTIO and EDL, every shot of every sequence reads back at the joined film's frames, and nobody else can", async () => {
  const f=await studio("feature");
  try{
    await f.flow.pitch({script:SCRIPT,format:"feature",tone:"",rightsAttested:true});
    const sound=f.flow.state.readThrough.questions.find((question:{persona:string})=>question.persona==="sound");
    await f.flow.plan([{id:sound.id,accepted:false,reply:"No music."}]);
    let state=await f.flow.approveLook(true);
    for(const number of [1,2,3]){state=await f.flow.approveRoughCut();if(number<3)state=await f.flow.nextSequence();}
    expect([state.joined,state.final.stage,state.final.status]).toEqual([true,"feature-film","done"]);
    const project=f.project(),jobs=await f.store.all(),joined=(await f.store.get(state.final.id))!,plan=joined.featureFilm!;
    const finals=plan.sequences.map(sequence=>jobs.find(job=>job.id===sequence.finalJobId)!),films=plan.sequences.map(sequence=>sequence.filmJobId);
    expect(finals.map(final=>final.sequence?.number)).toEqual([1,2,3]);
    expect(finals.every(final=>final.output!.shotRenders!.length>1)).toBe(true);

    const route=`/api/projects/${project.projectId}/feature-film/${joined.id}/interchange/`;
    const queueBefore=readFileSync(f.paths.queuePath,"utf8"),artifactsBefore=readdirSync(f.paths.artifactRoot,{recursive:true}).sort();
    const download=async(format:string)=>{
      const response=await f.call(route+format,project.token),text=await response.text();
      expect([response.status,text.includes('"error"')]).toEqual([200,false]);
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${joined.id}.${format}"`);
      expect([response.headers.get("cache-control"),response.headers.get("x-content-type-options"),response.headers.get("referrer-policy")]).toEqual(["private, no-store","nosniff","no-referrer"]);
      expect(response.headers.get("x-hv-interchange-sha256")).toBe(createHash("sha256").update(text).digest("hex"));
      return text;
    };
    const otioText=await download("otio"),edlText=await download("edl"),otio=readOtio(otioText),edl=readEdl(edlText);

    // Every shot of every sequence, in order, where the worker and the assembler put it, with each join a dissolve.
    const expected=expectedShots(finals,films);
    expect(expected.join).toBe(12);
    expect(otio.name).toBe("The Long Yard");
    expect(otio.tracks).toHaveLength(1);
    expect(otio.tracks[0]!.clips).toEqual(expected.clips);
    expect(otio.tracks[0]!.frames).toBe(expected.frames);
    expect(otio.tracks[0]!.clips.filter(clip=>clip.dissolveIn)).toHaveLength(2);
    const shots=JSON.parse(otioText).tracks.children[0].children.filter((item:{OTIO_SCHEMA:string})=>item.OTIO_SCHEMA==="Clip.1").map((clip:{metadata:{hv:{shot:unknown}}})=>clip.metadata.hv.shot);
    expect(shots).toEqual(finals.flatMap((final,index)=>final.output!.shotRenders!.map(record=>({sequence:index+1,finalJobId:final.id,shotId:record.shotId,renderRevision:record.revision}))));
    expect(otio.metadata).toMatchObject({hv:{schema:"hv-feature-interchange/1",featureFilmJobId:joined.id,planRevision:plan.revision,width:plan.width,height:plan.height}});
    expect(edl.title).toBe("The Long Yard");
    expect(edl.events).toEqual(otioAsEvents(otio.tracks[0]!));
    expect(edl.events.filter(event=>event.dissolve).map(event=>event.dissolve)).toEqual([12,12]);

    // The cut is as long as the joined export, to within one frame.
    const probe=JSON.parse(new TextDecoder().decode(Bun.spawnSync(["ffprobe","-v","error","-count_frames","-select_streams","v:0","-show_entries","stream=nb_read_frames:format=duration","-of","json",
      join(f.paths.artifactRoot,joined.output!.mp4Path)]).stdout));
    expect(Math.abs(Number(probe.format.duration)*30-expected.frames)).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(probe.streams[0].nb_read_frames)-expected.frames)).toBeLessThanOrEqual(1);

    // Job ids name the media: no token, URL, storage path or expiry; the download changes nothing and spends nothing.
    for(const text of [otioText,edlText]){
      expect(text).toContain("urn:hv:job:"+films[1]);expect(text).not.toContain(project.token);expect(text).not.toContain(f.paths.artifactRoot);expect(text).not.toContain(project.projectId+"/");
      expect(text).not.toMatch(/:\/\/|token|signature|x-amz|expires|\.mp4|\.wav|\.m3u8|\.mkv/i);
    }
    expect(readFileSync(f.paths.queuePath,"utf8")).toBe(queueBefore);expect(readdirSync(f.paths.artifactRoot,{recursive:true}).sort()).toEqual(artifactsBefore);expect(f.ledger.monthSpend()).toBe(0);

    // Nobody else: no token, another project's token, and this job asked for through another project's route.
    const refused=async(response:Response,statuses:number[])=>{const text=await response.text();expect(statuses).toContain(response.status);expect(text).not.toContain("HV01");expect(text).not.toContain("urn:hv:job");return text;};
    await refused(await f.call(route+"otio",undefined),[401]);
    const other=await(await f.call("/api/projects",undefined,"POST")).json() as {projectId:string;token:string};
    for(const format of ["otio","edl"])await refused(await f.call(route+format,other.token),[401]);
    await refused(await f.call(`/api/projects/${other.projectId}/feature-film/${joined.id}/interchange/edl`,project.token),[401]);
    expect(await refused(await f.call(`/api/projects/${other.projectId}/feature-film/${joined.id}/interchange/edl`,other.token),[409])).toContain("Only a feature the Showrunner split into sequences has a joined film to export.");
    // Not a joined film, an unknown format, a query or an extra path segment.
    expect(await refused(await f.call(`/api/projects/${project.projectId}/feature-film/${finals[0]!.id}/interchange/otio`,project.token),[409])).toContain("That isn't one of this feature's joined films.");
    expect(await refused(await f.call(route+"aaf",project.token),[400])).toContain("Choose otio or edl");
    await refused(await f.call(route+"edl?format=otio",project.token),[400]);
    await refused(await f.call(route+"otio/extra",project.token),[404]);

    // An unfinished join is refused; once it finishes, the older join is stale and the newer one exports.
    const again=await f.call(`/api/projects/${project.projectId}/feature-film`,project.token,"POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,
      sequences:films.map((jobId,index)=>({number:index+1,jobId})),title:null,credits:null});
    const newer=(await again.json() as {jobId:string;admitted:boolean});expect([again.status,newer.admitted]).toEqual([202,true]);
    const newerRoute=`/api/projects/${project.projectId}/feature-film/${newer.jobId}/interchange/`;
    expect(await refused(await f.call(newerRoute+"otio",project.token),[409])).toContain("The feature's film isn't finished. Export its cut after the join completes.");
    expect((await f.call(route+"edl",project.token)).status).toBe(200);
    await f.work();expect((await f.store.get(newer.jobId))!.status).toBe("done");
    expect(await refused(await f.call(route+"edl",project.token),[409])).toContain("A newer join of the feature is finished. Export that one.");
    const newerEdl=await f.call(newerRoute+"edl",project.token);expect(newerEdl.status).toBe(200);
    expect(readEdl(await newerEdl.text()).events).toEqual(edl.events);
    // A screenplay changed after the join makes it stale.
    expect((await f.call(`/api/projects/${project.projectId}/script`,project.token,"PUT",{text:SCRIPT+"\n\nINT. YARD - NIGHT\n\nMara locks the gate.\n"})).status).toBe(200);
    expect(await refused(await f.call(newerRoute+"otio",project.token),[409])).toContain("The feature changed after this join");
  }finally{await f.close();}
},600000);
