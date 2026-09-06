import {afterAll,beforeAll,expect,test} from "bun:test";
import {StudioDatabase} from "../src/database";
import {PostgresProjectService} from "../src/projects";
import {ProjectService,type PersistedProject} from "../../api/src/index";
import {mintActorToken} from "../../api/src/actor-token";
import {copiedActorReferences} from "../../planner/src/actor-library";
import {CAST_INPUT,CAST_SCRIPT} from "../../../test/fixtures/casting";
import type {ReferenceAsset} from "../../planner/src/references";
const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL),pgtest=enabled?test:test.skip;
let admin:StudioDatabase,database:StudioDatabase,projects:PostgresProjectService;
const ids:string[]=[],options={name:"IMPORTED",aliases:[],attested:true};
beforeAll(async()=>{
  if(!enabled)return;process.env.HV_TOKEN_SECRET="actor-library-postgres-secret-at-least-thirty-two-characters";
  admin=new StudioDatabase(process.env.HV_PG_ADMIN_URL!);await admin.migrate();database=new StudioDatabase(process.env.HV_API_DATABASE_URL!);projects=new PostgresProjectService(database);
});
afterAll(async()=>{if(!enabled)return;for(const id of ids){await admin.sql`delete from hv_reviews where project_id=${id}`;await admin.sql`delete from hv_projects where id=${id}`;}await Promise.all([admin.close(),database.close()]);});
async function owner(cast=false){
  const value=await projects.createAnonymousProject();ids.push(value.projectId);await projects.editScript(value.token,CAST_SCRIPT);const characterId=crypto.randomUUID();
  if(cast){await projects.saveCharacter(value.token,characterId,CAST_INPUT,0);
    const asset:ReferenceAsset={schema:"hv-reference/1",id:crypto.randomUUID(),projectId:value.projectId,sha256:"a".repeat(64),originalSha256:"b".repeat(64),bytes:100,width:512,height:512,contentType:"image/png",createdAt:new Date().toISOString(),attestedAt:new Date().toISOString()};
    await projects.addCharacterReference(value.token,characterId,asset,1);
  }return {...value,characterId};
}
async function share(value:Awaited<ReturnType<typeof owner>>){const result=(await projects.shareCharacter(value.token,value.characterId,2,true))!;return {share:result,token:mintActorToken(result)};}

pgtest("actor imports use scoped hv_api access and commit one cast plus reference catalog under competing saves",async()=>{
  const role=(await database.sql`select current_user as name,rolbypassrls from pg_roles where rolname=current_user`)[0];expect(role.name).toBe("hv_api");expect(role.rolbypassrls).toBe(false);
  const source=await owner(true),target=await owner(),other=await owner(),grant=await share(source);
  const reviewer=(await projects.createReviewLink(target.token,"read"))!;
  expect(await projects.sharedActor(grant.token)).toEqual(grant.share);expect(await projects.authorize(grant.token)).toBeNull();
  expect(await projects.importSharedActor(reviewer.token,grant.token,[],0,options)).toBeNull();
  const before=(await projects.authorize(source.token))!;
  const results=await Promise.allSettled([1,2].map(()=>projects.importSharedActor(target.token,grant.token,copiedActorReferences(grant.share,target.projectId),0,options)));
  expect(results.filter(value=>value.status==="fulfilled")).toHaveLength(1);expect(results.filter(value=>value.status==="rejected")).toHaveLength(1);
  const saved=(await projects.authorize(target.token))!;expect(saved.castingHistory).toHaveLength(1);expect(saved.referenceAssets).toHaveLength(1);
  expect(saved.castingHistory[0]!.characters[0]!.references).toEqual(saved.referenceAssets);expect(saved.castingHistory[0]!.characters[0]!.permission.status).toBe("pending");
  expect((await projects.authorize(source.token))!.referenceAssets).toEqual(before.referenceAssets);expect((await projects.authorize(other.token))!.referenceAssets).toHaveLength(0);
  expect(await projects.peekReviewLink(reviewer.token)).toBeTruthy();
  await database.forProject(other.projectId,async tx=>expect(await tx`select id from hv_projects where id=${target.projectId}`).toHaveLength(0));
});

pgtest("opposing actor imports lock their two project rows in one stable order",async()=>{
  const a=await owner(true),b=await owner(true),ga=await share(a),gb=await share(b);
  const results=await Promise.all([
    projects.importSharedActor(a.token,gb.token,copiedActorReferences(gb.share,a.projectId),2,options),
    projects.importSharedActor(b.token,ga.token,copiedActorReferences(ga.share,b.projectId),2,options)
  ]);
  for(const result of results){expect(result!.version).toBe(3);expect(result!.characters).toHaveLength(2);}
},10_000);

pgtest("an import waiting on a source row sees committed revocation before changing its destination",async()=>{
  const source=await owner(true),target=await owner(),grant=await share(source);let release!:()=>void,locked!:()=>void;
  const barrier=new Promise<void>(resolve=>{locked=resolve;}),proceed=new Promise<void>(resolve=>{release=resolve;});
  const transaction=admin.sql.begin(async tx=>{
    const row=(await tx`select body from hv_projects where id=${source.projectId} for update`)[0];locked();await proceed;
    const state={version:1 as const,projects:[row.body as PersistedProject],reviewLinks:[],takenDown:[],takedownLog:[]},service=ProjectService.fromState(state);
    service.revokeActorShare(source.token,source.characterId,grant.share.id);
    await tx`update hv_projects set body=${service.snapshot().projects[0]!}::jsonb where id=${source.projectId}`;
  });
  await barrier;
  const pending=projects.importSharedActor(target.token,grant.token,copiedActorReferences(grant.share,target.projectId),0,options);
  // Bun's rejects matcher waits before returning to this function. Capture the
  // result now and assert only after releasing the fixture's source-row lock.
  const outcome=pending.then(value=>({value,error:null}),error=>({value:null,error}));
  try{
    // Observe the actual blocked query; a sleep alone would not establish the race.
    let waiting=false;for(let i=0;i<100;i++){
      waiting=Number((await admin.sql`select count(*) as n from pg_stat_activity where usename='hv_api' and datname=current_database() and wait_event_type='Lock'`)[0].n)>0;
      if(waiting)break;await Bun.sleep(10);
    }expect(waiting).toBe(true);
  }finally{release();await transaction;}
  const result=await outcome;expect(result.value).toBeNull();expect(result.error).toBeInstanceOf(Error);expect(result.error.message).toContain("unavailable");
  expect((await projects.authorize(target.token))!.castingHistory).toHaveLength(0);expect((await projects.authorize(target.token))!.referenceAssets).toHaveLength(0);
});
