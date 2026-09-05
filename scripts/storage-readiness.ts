import { StudioDatabase } from "../packages/storage/src/database";
import { objectClient } from "../packages/storage/src/artifacts";
const database=new StudioDatabase(process.env.HV_API_DATABASE_URL ?? "");
try {
  await database.sql`select * from public.hv_queue_counts()`;
  await database.sql`select purged_at from hv_projects where false`;
  await database.sql`select object_key from hv_artifacts where false`;
  const cap=Number((await database.sql`select monthly_cap_usd from hv_budget_accounts where id='operator'`)[0]?.monthly_cap_usd);
  if (!Number.isFinite(cap)||cap<=0) throw new Error("operator budget is not initialized");
  await objectClient().list({maxKeys:1});
  console.log(JSON.stringify({ready:true,databaseRole:"hv_api",privateObjectsAuthenticated:true}));
} finally {await database.close();}
