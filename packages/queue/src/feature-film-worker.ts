import {existsSync,mkdirSync,mkdtempSync,readdirSync,realpathSync,rmSync,statSync} from "node:fs";
import {join,resolve,sep} from "node:path";
import type {Job,DurableJobStore} from "./index";
import type {WorkerContext} from "./worker";
import type {PostgresJobStore} from "../../storage/src/jobs";
import {contentHash} from "../../generator/src/capabilities";
import {sha256Stream} from "../../assembler/src/c2pa";
import {assembleFeatureFilm} from "../../assembler/src/feature-film";
import {assertOutputPermission} from "../../planner/src/dialogue-selection";
import {FEATURE_FILM_OUTPUT_SCHEMA,assertFeatureFilmSourcesAvailable,validateFeatureFilmJob,validateFeatureFilmOutput,type FeatureFilmOutput} from "../../planner/src/feature-film";
import type {RenderFile} from "../../planner/src/shot-reuse";

const inside=(root:string,path:string)=>{const full=resolve(root,path);if(!full.startsWith(root+sep))throw new Error("A feature's film source escaped the artifact root.");return full;};

/**
 * HV-030-30: join a feature's sequence films into its one film (`assembleFeatureFilm`), then record and
 * publish it like any other export. Before the join, and again before it completes, every sequence
 * film and graphic must still be the one admitted, and on the JSON store every film's cast must still
 * permit it (the PostgreSQL store checks that in its completion transaction). The join costs nothing
 * and is made again from the films if the worker loses its lease.
 */
export async function processFeatureFilmJob(job:Job,store:DurableJobStore|PostgresJobStore,artifactRoot:string,context:WorkerContext,workerId:string,leaseMs:number,signal:AbortSignal,now:()=>number,deadline:number):Promise<Job>{
  validateFeatureFilmJob(job);const plan=job.featureFilm!;
  if(plan.storage!==(context.artifacts?"s3":"local"))throw new Error("The artifact storage changed after the feature's film was admitted.");
  const sourceIds=[...plan.films.map(film=>film.job.id),...[plan.title,plan.credits].flatMap(value=>value?[value.jobId]:[])];
  const access=async()=>{
    signal.throwIfAborted();if(now()>deadline)throw new Error(`job exceeded its ${Math.round(job.timeoutMs/1000)}s timeout`);
    await store.heartbeat(job.id,workerId,now(),leaseMs);
    const current=new Map<string,Job|undefined>();for(const id of sourceIds)current.set(id,await store.get(id)??undefined);
    assertFeatureFilmSourcesAvailable(plan,id=>current.get(id),now());
    if(context.projects){const project=await context.projects.peekProject(job.projectId);for(const film of plan.films)assertOutputPermission(film.job,project,now());}
  };
  await access();
  mkdirSync(artifactRoot,{recursive:true});
  const root=realpathSync(artifactRoot),jobRoot=resolve(root,job.projectId,job.id);mkdirSync(jobRoot,{recursive:true});
  if(realpathSync(jobRoot)!==jobRoot||!jobRoot.startsWith(root+sep))throw new Error("The feature's film escaped its job.");
  const outDir=join(jobRoot,"feature-"+crypto.randomUUID()),scratch=context.artifacts?mkdtempSync(join(root,".feature-film-")):null;let done=false;
  try{
    // The films and graphics are read where they are kept: on this host's disk, or fetched from the object store.
    const fetch=async(owner:string,key:string,name:string)=>{
      if(!context.artifacts)return inside(root,key);
      const response=await context.artifacts.response(job.projectId,owner,key,new Request("http://worker.invalid/"));
      if(!response?.ok)throw new Error("A feature's film source is missing from the object store.");
      const path=join(scratch!,name);await Bun.write(path,response);return path;
    };
    const films=[];for(const film of plan.films){const output=film.job.output!;
      films.push({path:await fetch(film.job.id,output.mp4Path,`film-${film.number}.mp4`),captionsPath:await fetch(film.job.id,output.captionsPath,`film-${film.number}.vtt`)});}
    const title=plan.title?{path:await fetch(plan.title.jobId,plan.title.masterPath,"title.mkv"),frames:plan.title.frames}:null;
    const credits=plan.credits?{path:await fetch(plan.credits.jobId,plan.credits.masterPath,"credits.mkv"),frames:plan.credits.frames}:null;
    await access();
    const result=await assembleFeatureFilm({films,title,credits,width:plan.width,height:plan.height,crossfadeFrames:plan.crossfadeFrames,outDir,projectId:job.projectId,
      assembledAt:new Date(now()).toISOString(),signal,record:{planRevision:plan.revision,join:{schema:"hv-feature-join/1",planRevision:plan.planRevision,scriptVersion:plan.scriptVersion,sequences:plan.sequences},
        title:plan.title&&{jobId:plan.title.jobId,outputRevision:plan.title.outputRevision},credits:plan.credits&&{jobId:plan.credits.jobId,outputRevision:plan.credits.outputRevision}}});
    await access();
    const files:RenderFile[]=[],absolute:string[]=[];
    const visit=async(directory:string):Promise<void>=>{for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name);
      if(entry.isDirectory())await visit(path);else if(entry.isFile()){absolute.push(path);files.push({path:path.slice(root.length+1).split(sep).join("/"),bytes:statSync(path).size,sha256:await sha256Stream(path,signal)});}
      else throw new Error("A feature's film holds an unexpected artifact.");}};
    await visit(outDir);files.sort((a,b)=>a.path.localeCompare(b.path));
    const relative=(path:string)=>path.slice(root.length+1).split(sep).join("/");
    const data={schema:FEATURE_FILM_OUTPUT_SCHEMA as typeof FEATURE_FILM_OUTPUT_SCHEMA,planRevision:plan.revision,sha256:result.sha256,durationSec:Number(result.durationSec.toFixed(3)),credentials:result.credentials,files};
    const featureFilm:FeatureFilmOutput={...data,revision:contentHash(data)};
    const output:NonNullable<Job["output"]>={mp4Path:relative(result.mp4Path),hlsPlaylistPath:relative(result.hlsPlaylistPath),captionsPath:relative(result.vttPath),manifestPath:relative(result.manifestPath),
      ...(result.c2paPath?{c2paPath:relative(result.c2paPath)}:{}),featureFilm};
    validateFeatureFilmOutput(job,output);
    if(context.artifacts)await context.artifacts.publishExport(job,workerId,absolute,signal);
    await access();
    const completed=await store.complete(job.id,workerId,output,now());done=true;return completed;
  }finally{
    if(scratch&&existsSync(scratch))rmSync(scratch,{recursive:true,force:true});
    if(!done&&existsSync(outDir)&&outDir.startsWith(jobRoot+sep))rmSync(outDir,{recursive:true,force:true});
  }
}
