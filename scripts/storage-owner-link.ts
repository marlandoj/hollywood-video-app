import { parseArgs } from "node:util";
import { closeSync, existsSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { StudioDatabase } from "../packages/storage/src/database";
import { mintProjectToken, tokenSecret } from "../packages/api/src/tokens";
const {values} = parseArgs({args:process.argv.slice(2),options:{help:{type:"boolean"},project:{type:"string"},origin:{type:"string"},output:{type:"string"}},strict:true});
if (values.help) {console.log("Issue a 72-hour owner link after an archive restore: --project ID --origin HTTPS_ORIGIN --output NEW_PRIVATE_FILE. Uses the destination HV_PG_ADMIN_URL and HV_TOKEN_SECRET; the link is never printed.");process.exit(0);}
if (!values.project || !values.origin || !values.output) throw new Error("specify project, origin and private output file; use --help");
const url = new URL(values.origin);
if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1","localhost","[::1]"].includes(url.hostname)))) throw new Error("owner link requires an HTTPS origin or loopback development origin");
if (existsSync(values.output)) throw new Error("owner link output already exists");
tokenSecret();
const database = new StudioDatabase(process.env.HV_PG_ADMIN_URL ?? "");
try {
  if ((await database.sql`select current_user as role`)[0].role !== "hv_admin") throw new Error("owner link issuance requires the migration role");
  const project = (await database.sql`select id from hv_projects where id = ${values.project} and taken_down_at is null and delete_after > now()`)[0];
  if (!project) throw new Error("project is unavailable or expired");
  url.hash = "/p/" + encodeURIComponent(mintProjectToken(project.id));
  const descriptor = openSync(values.output,"wx",0o600);
  try {writeFileSync(descriptor,url.href+"\n");fsyncSync(descriptor);} finally {closeSync(descriptor);}
  console.log(JSON.stringify({created:true,projectId:project.id,expiresInHours:72}));
} finally {await database.close();}
