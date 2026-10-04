/**
 * HV-022-21 — an ElevenLabs take holds its own line on the PostgreSQL ledger, and everything that
 * reads a take's hold reads that figure.
 *
 * Every take used to reserve the policy's whole 10,000-character ceiling ($0.555556 on the
 * operator's plan), so the $25 voice line (G14) had room for 44 takes and a feature has 150-250
 * lines. Admission, the dispatch journal, the film limit, the vendor's line and the snapshot
 * validator now all use the take's own hold. Nothing here raises a limit: an over-the-line take is
 * refused as before, and a take billed above its hold is settled as any overrun is.
 */
import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {StudioDatabase} from "../src/database";
import {PostgresJobStore} from "../src/jobs";
import {PostgresAudioLedger,type AudioInvoice} from "../src/audio-ledger";
import {exportStateSnapshot} from "../src/snapshots";
import {createApiServer,type ApiServer} from "../../api/src/server";
import {audioPolicy,audioTakeHoldUsd,type AudioPolicy} from "../../planner/src/audio-jobs";
import {elevenLabsTakeHoldUsd} from "../../generator/src/elevenlabs-policy-catalogue";
import {ElevenLabsAudioProvider} from "../../generator/src/elevenlabs-audio";
import {contentHash} from "../../generator/src/capabilities";
import {DEFAULT_VOICE_VENDOR_CAP_USD} from "../../operator/src/voice-vendor-budget";
import {DEFAULT_FILM_SPEND_CAP_USD} from "../../operator/src/film-budget";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {ELEVENLABS_POLICY} from "../../../test/fixtures/elevenlabs-audio";

const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_WORKER_DATABASE_URL),pgtest=enabled?test:test.skip;
// The operator's plan ($5 for 90,000 characters) on the fixture's synthetic voice and evidence.
const {schema:_s,model:_m,permissionRevision:_p,priceRevision:_r,revision:_v,...input}=ELEVENLABS_POLICY;
const POLICY:AudioPolicy=audioPolicy({...input,heldUsd:elevenLabsTakeHoldUsd(5,90_000)});
const lookup=(id:string)=>id===POLICY.voiceId?POLICY:undefined;
const FORTY="I kept every light on for you all night.";
const TYPICAL="Then tell me why the boat was gone before the tide turned, and why nobody in this town will say one word about it to me.";
const oldSecret=process.env.HV_TOKEN_SECRET,ids:string[]=[];
let admin:StudioDatabase,worker:StudioDatabase,server:ApiServer,scaled:ApiServer,root:string;
// HV-030-28: a film's limit follows its format. `scaled` is the same studio with both limits in cents.
const LIMIT_KEYS=["HV_FILM_SPEND_CAP_USD","HV_FEATURE_FILM_SPEND_CAP_USD"],savedLimits=Object.fromEntries(LIMIT_KEYS.map(key=>[key,process.env[key]]));

beforeAll(async()=>{if(!enabled)return;
  process.env.HV_TOKEN_SECRET="elevenlabs-holds-pg-fixture-secret-at-least-thirty-two-characters";root=mkdtempSync(join(tmpdir(),"hv-eleven-holds-"));
  admin=new StudioDatabase(process.env.HV_PG_ADMIN_URL!);await admin.migrate();worker=new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  const studio=(name:string)=>createApiServer({port:0,hostname:"127.0.0.1",storage:"postgres",databaseUrl:process.env.HV_API_DATABASE_URL,artifactRoot:join(root,name),audioPolicies:()=>[POLICY],rateLimit:{api:{limit:10000,windowMs:60000}}});
  try{
    for(const key of LIMIT_KEYS)delete process.env[key];
    server=studio("api");
    Object.assign(process.env,{HV_FILM_SPEND_CAP_USD:"0.02",HV_FEATURE_FILM_SPEND_CAP_USD:"0.05"});
    scaled=studio("scaled");
  }finally{for(const [key,value] of Object.entries(savedLimits)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
},30000);
afterAll(async()=>{if(!enabled)return;await server?.stop(true);await scaled?.stop(true);
  for(const id of ids){
    await admin.sql`delete from hv_reservations where project_id=${id} or job_id in (select id from hv_jobs where project_id=${id})`;
    for(const table of ["hv_cost_events","hv_provider_attempts","hv_outbox","hv_operator_reviews","hv_artifacts","hv_jobs","hv_reviews"])await admin.sql.unsafe("delete from "+table+" where project_id=$1",[id]);
    await admin.sql`delete from hv_projects where id=${id}`;
  }
  await worker?.close();await admin?.close();rmSync(root,{recursive:true,force:true});
  if(oldSecret===undefined)delete process.env.HV_TOKEN_SECRET;else process.env.HV_TOKEN_SECRET=oldSecret;
},30000);

const call=(path:string,method="GET",body?:unknown,token?:string,on=server)=>fetch(new URL(path,on.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
/**
 * A project whose one line is `text`, cast and attested, and its first take through the studio's
 * route. `format` is what the crew's plan step would have stored on the project (HV-030-28); `again`
 * asks for another take of the same line under a new key.
 */
async function owner(text:string,{on=server,format}:{on?:ApiServer;format?:"reel"|"short"|"feature"}={}){
  const owner=await(await call("/api/projects","POST",undefined,undefined,on)).json() as any;ids.push(owner.projectId);const base="/api/projects/"+owner.projectId,actorId=crypto.randomUUID();
  await call(base+"/script","PUT",{text:"INT. HARBOUR - NIGHT\n\nMarla waits.\n\nMARLA\n"+text},owner.token,on);await call(base+"/rights","POST",{attested:true},owner.token,on);
  expect((await call(base+"/cast/"+actorId,"PUT",{character:{...CAST_INPUT,name:"Marla",aliases:[]},expectedVersion:0},owner.token,on)).status).toBe(200);
  if(format)await admin.sql`update hv_projects set body=body||${{format}}::jsonb where id=${owner.projectId}`;
  const quote=await(await call(base+"/audio-takes","GET",undefined,owner.token,on)).json() as any;expect(quote.enabled).toBe(true);
  const body={idempotencyKey:"take",generationApproved:true,sceneIndex:0,lineIndex:0,sourceHash:quote.lines[0].source.hash,characterId:actorId,voiceId:POLICY.voiceId,policyRevision:POLICY.revision,
    controls:{speed:1,stability:.5,similarity:.75,exaggeration:0}};
  const admitted=await call(base+"/audio-takes","POST",body,owner.token,on);expect(admitted.status).toBe(202);
  const answer=await admitted.json() as any,job=(await new PostgresJobStore(worker).get(answer.jobId))!;
  const again=async(key:string)=>(await call(base+"/audio-takes","POST",{...body,idempotencyKey:key},owner.token,on)).status;
  const refusal=async(key:string)=>{const response=await call(base+"/audio-takes","POST",{...body,idempotencyKey:key},owner.token,on);return {status:response.status,error:(await response.json() as any).error as string};};
  const spend=async()=>await(await call(base+"/spend","GET",undefined,owner.token,on)).json() as {spentUsd:number;heldUsd:number;capUsd:number};
  return {...owner,base,answer,job,again,refusal,spend};
}
const filmHeld=async(projectId:string)=>Number((await admin.sql`select coalesce(sum(remaining_usd),0) as held from hv_reservations where project_id=${projectId}`)[0].held);
const line=()=>new PostgresAudioLedger(worker).voiceVendorSpend("elevenlabs");
const invoice=(attemptId:string,usd:number):AudioInvoice=>{
  const data={schema:"hv-audio-invoice-allocation/1" as const,documentSha256:contentHash({overrun:attemptId}),accountRevision:POLICY.accountRevision,totalUsd:usd,allocations:[{attemptId,usd}],at:new Date().toISOString()};
  return {...data,revision:contentHash(data)};
};

// First in this file: it claims the oldest queued take, which must be its own.
pgtest("a take billed above its hold is settled as an overrun: recorded in full, its job cancelled, its hold released",async()=>{
  const o=await owner(FORTY),ledger=new PostgresAudioLedger(worker),operator=new PostgresAudioLedger(admin),store=new PostgresJobStore(worker);
  const job=(await store.claimNext(Date.now(),{},{workerId:"overrun"}))!;expect(job.id).toBe(o.job.id);
  // A dispatch whose answer never arrives: the journal holds the line's own figure, as admission did.
  const provider=new ElevenLabsAudioProvider({apiKey:"fixture-not-a-real-key",fetchImpl:(async()=>new Response("{}",{status:500})) as unknown as typeof fetch});
  await expect(provider.synthesize(job.audioTake!.line,ledger.journal(job,"overrun",lookup))).rejects.toThrow();
  const attempt=(await ledger.audioAttempt(job.id))!;
  expect({status:attempt.status,estimated:attempt.estimatedUsd,reservation:attempt.audio.reservation.heldUsd}).toEqual({status:"unknown",estimated:0.002223,reservation:0.002223});
  const before=await line();
  // The invoice allocates $0.01 to a take that held $0.002223.
  await operator.settleAudioInvoice(invoice(attempt.id,0.01));
  const settled=(await ledger.audioAttempt(job.id))!,after=(await store.get(job.id))!;
  expect(settled.actualUsd).toBe(0.01);
  // Recorded at what was billed, never clamped to what was held.
  expect(Number((await admin.sql`select total_usd from hv_cost_events where attempt_id=${attempt.id}`)[0].total_usd)).toBe(0.01);
  expect({status:after.status,reason:after.cancelReason,cost:after.costUsd}).toEqual({status:"cancelled",reason:"The audio invoice allocation exceeded its job cap.",cost:0.01});
  expect(await admin.sql`select job_id from hv_reservations where job_id=${job.id}`).toHaveLength(0);
  const now=await line();
  // The vendor's line carries the full bill and drops the hold it replaced.
  expect(Number((now.spentUsd-before.spentUsd).toFixed(6))).toBe(0.01);
  expect(Number((before.heldUsd-now.heldUsd).toFixed(6))).toBe(0.002223);
  // The snapshot validator checks an attempt's hold against its take's own, so the settled take exports.
  const snapshot=await exportStateSnapshot(admin,o.projectId);
  expect(snapshot.ledger.audioAttempts?.map(a=>a.estimatedUsd)).toEqual([0.002223]);
  expect(snapshot.ledger.events.map(e=>e.total_cost_usd)).toEqual([0.01]);
},60000);

pgtest("the studio's take route holds a 40-character line at 40 characters, and a longer line more",async()=>{
  const short=await owner(FORTY);
  expect(short.job.audioTake!.line.spokenText).toBe(FORTY);
  // $0.555556 per 10,000 characters: 2,222.224 micro-dollars, held as 2,223.
  expect(short.answer.heldUsd).toBe(0.002223);
  expect({cap:short.job.costCapUsd,reserved:short.job.budgetReservedUsd,take:short.job.audioTake!.heldUsd}).toEqual({cap:0.002223,reserved:0.002223,take:0.002223});
  const row=(await admin.sql`select remaining_usd,body->>'provider' as provider from hv_reservations where job_id=${short.job.id}`)[0];
  expect({held:row.remaining_usd,provider:row.provider}).toEqual({held:"0.002223",provider:"elevenlabs"});
  // The film's own limit counts the same hold.
  expect(await filmHeld(short.projectId)).toBe(0.002223);
  const long=await owner(FORTY.repeat(10));
  expect(long.answer.heldUsd).toBe(0.022223);
  expect(long.answer.heldUsd).toBeGreaterThan(short.answer.heldUsd);
  expect(long.answer.heldUsd).toBeLessThan(POLICY.heldUsd);
  // The owner's take view reports the take's own hold, not the policy's ceiling.
  const view=await(await call("/api/jobs/"+short.job.id,"GET",undefined,short.token)).json() as any;
  expect(view.audioBilling).toEqual({state:"reserved",actualUsd:null,heldUsd:0.002223});
},60000);

pgtest("200 typical lines fit the $25 voice line and the film's own limit; the next take past either is refused",async()=>{
  const o=await owner(TYPICAL),ledger=new PostgresAudioLedger(worker),hold=audioTakeHoldUsd(o.job.audioTake!);
  expect(TYPICAL.length).toBe(120);
  expect(hold).toBe(0.006667);
  // $25 of room on the vendor's line, whatever other takes this database already carries.
  const start=await line(),cap=Number((start.spentUsd+start.heldUsd+DEFAULT_VOICE_VENDOR_CAP_USD).toFixed(6));
  const take=(label:string)=>({...o.job,id:crypto.randomUUID(),idempotencyKey:o.projectId+":"+label});
  for(let index=0;index<199;index++)
    await ledger.admitAudio(o.projectId,take("line-"+index),lookup,500,Date.now(),DEFAULT_FILM_SPEND_CAP_USD,cap);
  const committed=await line(),used=Number((committed.spentUsd+committed.heldUsd-start.spentUsd-start.heldUsd).toFixed(6));
  // 199 here and the route's own: 200 takes, $1.33 of the line's $25 and of the film's $40.
  expect(used).toBe(Number((199*hold).toFixed(6)));
  expect(await filmHeld(o.projectId)).toBe(Number((200*hold).toFixed(6)));
  expect(await filmHeld(o.projectId)).toBeLessThan(2);
  // One take past the line's ceiling is still refused, and holds nothing.
  const reserved=await ledger.reservedUsd(),total=Number((committed.spentUsd+committed.heldUsd).toFixed(6)),refused=take("over-the-line");
  await expect(ledger.admitAudio(o.projectId,refused,lookup,500,Date.now(),undefined,Number((total+hold-0.000001).toFixed(6)))).rejects.toThrow("voice line has reached its limit");
  // And one take past the film's own limit.
  const film=await filmHeld(o.projectId);
  await expect(ledger.admitAudio(o.projectId,refused,lookup,500,Date.now(),Number((film+hold-0.000001).toFixed(6)),cap)).rejects.toThrow("spending limit");
  expect(await ledger.reservedUsd()).toBe(reserved);expect(await new PostgresJobStore(worker).get(refused.id)).toBeUndefined();
  // At exactly the line's room the same take is admitted: the ceiling is unchanged, not tightened.
  expect((await ledger.admitAudio(o.projectId,refused,lookup,500,Date.now(),undefined,Number((total+hold).toFixed(6)))).id).toBe(refused.id);
},120000);

pgtest("each take's line-sized hold counts against its own film's limit: $150 for a feature, $40 for a short",async()=>{
  // As shipped. A feature and a short each take 200 typical lines through the route, $1.33 of either
  // limit. At the ceiling hold ($0.555556) a short was refused its 72nd take and a feature its 270th.
  const feature=await owner(TYPICAL,{format:"feature"}),short=await owner(TYPICAL,{format:"short"});
  for(const film of [feature,short])for(let index=1;index<200;index++)expect(await film.again("line-"+index)).toBe(202);
  expect(await feature.spend()).toEqual({spentUsd:0,heldUsd:1.3334,capUsd:150});
  expect(await short.spend()).toEqual({spentUsd:0,heldUsd:1.3334,capUsd:40});
  expect([Math.floor(40/POLICY.heldUsd)+1,Math.floor(150/POLICY.heldUsd)+1]).toEqual([72,270]);
  // Scaled to cents, each film is refused at its own limit by the takes' own holds ($0.006667 each):
  // a short at $0.02 holds two and is refused the third; a feature at $0.05 holds seven, not the eighth.
  const scaledShort=await owner(TYPICAL,{on:scaled,format:"short"}),scaledFeature=await owner(TYPICAL,{on:scaled,format:"feature"});
  expect(await scaledShort.again("second")).toBe(202);
  const third=await scaledShort.refusal("third");
  expect(third.status).toBe(429);expect(third.error).toContain("spending limit of $0.02");
  for(let index=2;index<=7;index++)expect(await scaledFeature.again("take-"+index)).toBe(202);
  const eighth=await scaledFeature.refusal("take-8");
  expect(eighth.status).toBe(429);expect(eighth.error).toContain("spending limit of $0.05");
  expect(await scaledShort.spend()).toEqual({spentUsd:0,heldUsd:0.013334,capUsd:0.02});
  expect(await scaledFeature.spend()).toEqual({spentUsd:0,heldUsd:0.046669,capUsd:0.05});
},180000);
