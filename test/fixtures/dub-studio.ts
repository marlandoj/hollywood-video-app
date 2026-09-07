import {mkdtempSync,mkdirSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {createApiServer} from "../../packages/api/src/server";
import {ProjectService} from "../../packages/api/src/index";
import {DurableJobStore} from "../../packages/queue/src/index";
import {processNextJob} from "../../packages/queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../packages/operator/src/index";
import {currentCasting} from "../../packages/planner/src/casting";
import {lineSources} from "../../packages/planner/src/performances";
import {parseFountain} from "../../packages/parser/src/index";
import {audioTakePlan} from "../../packages/planner/src/audio-jobs";
import {createAudioDelivery} from "../../packages/generator/src/audio-delivery";
import {prepareAudioMedia} from "../../packages/generator/src/audio-media";
import type {AudioLanguage} from "../../packages/generator/src/audio-languages";
import {CAST_INPUT} from "./casting";
import {AUDIO_PCM} from "./audio";
import {DUB_POLICY,localizedLine} from "./localized-audio";
export const DUB_SCRIPT="INT. GARDEN - DAY\n\nSpud waves.\n\nSPUD\nWelcome to the garden.\n\nSpud opens the gate.\n\nSPUD\nCome inside, friend.";
export async function dubStudio(root=mkdtempSync(join(tmpdir(),"hv-dub-studio-"))){
  const policyPath=join(root,"policies.json"),config={HV_TOKEN_SECRET:"dub-studio-fixture-secret-at-least-thirty-two-characters",HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_AUDIO_POLICY_FILE:policyPath},previous=Object.fromEntries(Object.keys(config).map(k=>[k,process.env[k]]));Object.assign(process.env,config);writeFileSync(policyPath,JSON.stringify({schema:"hv-audio-policies/1",policies:[DUB_POLICY]}));
  const paths={statePath:join(root,"projects.json"),queuePath:join(root,"jobs.json"),costLedgerPath:join(root,"ledger.json"),artifactRoot:join(root,"media")},server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:10000,windowMs:60000}}});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId,id=crypto.randomUUID();
  for(const [path,method,body]of [["/script","PUT",{text:DUB_SCRIPT}],["/rights","POST",{attested:true}],["/cast/"+id,"PUT",{expectedVersion:0,character:CAST_INPUT}],["/jobs","POST",{idempotencyKey:"source"}]] as const){const r=await call(base+path,method,body,owner.token);if(!r.ok)throw new Error(await r.text());}
  const projects=new ProjectService(paths.statePath),store=new DurableJobStore(paths.queuePath),ledger=new CostLedger(paths.costLedgerPath),reviews=new OperatorReviewQueue(join(root,"reviews.json")),worker=()=>processNextJob(store,paths.artifactRoot,{projects,ledger,reviewQueue:reviews});
  const film=await worker();if(film?.status!=="done")throw new Error("Dub fixture source failed: "+film?.failureReason);
  const casting=currentCasting(owner.projectId,projects.snapshot().projects[0]!.castingHistory),sources=lineSources(parseFountain(DUB_SCRIPT).scenes[0]!.dialogue);
  async function seed(index:number,language:AudioLanguage,text:string){const line=localizedLine(sources[index]!,language,text),job=store.enqueue({id:crypto.randomUUID(),projectId:owner.projectId,idempotencyKey:owner.projectId+":"+crypto.randomUUID(),tier:"free",stage:"audio-take",scriptVersion:1,scriptText:DUB_SCRIPT,casting,rightsAttestedAt:film!.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:0,costCapUsd:.25,budgetReservedUsd:.25,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60000,audioTake:audioTakePlan(0,id,line,DUB_POLICY,"local")});
    store.claimNext(Date.now(),{},{workerId:"dub-fixture"});const delivered=createAudioDelivery(line,crypto.randomUUID(),AUDIO_PCM,[{text,startSec:0,endSec:.9}],[]),scratch=mkdtempSync(join(root,".audio-")),output=prepareAudioMedia(job,scratch,delivered.report,delivered.wav),directory=join(paths.artifactRoot,dirname(output.wavPath));mkdirSync(dirname(directory),{recursive:true});renameSync(scratch,directory);store.checkpointAudio(job.id,"dub-fixture",output);return store.completeAudio(job.id,"dub-fixture",output);}
  const spanish=[await seed(0,"es","Bienvenida al jardín."),await seed(1,"es","Entra, amigo.")],arabic=await seed(0,"ar","أهلاً بك في الحديقة.");
  const quote=(jobId=film.id)=>call(base+"/dialogue/"+jobId,"GET",undefined,owner.token).then(r=>r.json() as Promise<any>);
  const requestBody=(q:any,language="es")=>({idempotencyKey:crypto.randomUUID(),generationApproved:true,sourceRevision:q.sourceRevision,sourceFilesRevision:q.sourceFilesRevision,baselineRevision:q.baselineRevision,engineVersion:q.engineVersion,conversionEngineVersion:q.conversionEngineVersion,dub:{language,reviewed:true},edits:q.lines.map((l:any)=>{const take=l.auditions.find((a:any)=>a.language===language);return {shotId:l.shotId,index:l.index,sourceHash:l.sourceHash,auditionJobId:take?.jobId,auditionRevision:take?.revision};})});
  return {root,paths,server,call,owner,base,id,projects,store,ledger,reviews,worker,film,spanish,arabic,seed,quote,requestBody,async close(remove=true){await server.stop(true);if(remove)rmSync(root,{recursive:true,force:true});for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}};
}
