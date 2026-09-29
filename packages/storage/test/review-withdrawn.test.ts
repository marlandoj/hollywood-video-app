/**
 * HV-029-11 — the PostgreSQL project service answers whether a review link still grants the media it
 * handed out. See packages/api/test/review-revoke-media.test.ts for the route that asks.
 */
import {afterAll,beforeAll,expect,test} from "bun:test";
import {StudioDatabase} from "../src/database";
import {PostgresProjectService} from "../src/projects";
import {reviewDigest} from "../../api/src/tokens";

const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL),pgtest=enabled?test:test.skip;
const created:string[]=[];
let admin:StudioDatabase,api:StudioDatabase;
beforeAll(async()=>{if(!enabled)return;admin=new StudioDatabase(process.env.HV_PG_ADMIN_URL!);await admin.migrate();api=new StudioDatabase(process.env.HV_API_DATABASE_URL!);});
afterAll(async()=>{if(!enabled)return;
  for(const id of created){await admin.sql`delete from hv_reviews where project_id=${id}`;await admin.sql`delete from hv_projects where id=${id}`;}
  await Promise.all([admin.close(),api.close()]);
});

pgtest("a revoked or unknown review link is withdrawn; a live one, and one of another project, are told apart",async()=>{
  process.env.HV_TOKEN_SECRET??="review-withdrawn-secret-that-is-at-least-thirty-two-characters";
  const service=new PostgresProjectService(api);
  const project=await service.createAnonymousProject(),other=await service.createAnonymousProject();created.push(project.projectId,other.projectId);
  const revoked=(await service.createReviewLink(project.token,"read"))!,live=(await service.createReviewLink(project.token,"read"))!,elsewhere=(await service.createReviewLink(other.token,"read"))!;
  expect(await service.revokeReviewLink(project.token,revoked.token)).toBe(true);
  expect(await service.reviewLinkWithdrawn(project.projectId,reviewDigest(revoked.token))).toBe(true);
  expect(await service.reviewLinkWithdrawn(project.projectId,reviewDigest(live.token))).toBe(false);
  expect(await service.reviewLinkWithdrawn(project.projectId,reviewDigest("never-issued"))).toBe(true);
  // A link of another project does not vouch for this project's media.
  expect(await service.reviewLinkWithdrawn(project.projectId,reviewDigest(elsewhere.token))).toBe(true);
  expect(await service.reviewLinkWithdrawn(other.projectId,reviewDigest(elsewhere.token))).toBe(false);
});
