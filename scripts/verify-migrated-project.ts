import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createApiServer } from "../packages/api/src/server";
import { verifyToken } from "../packages/api/src/tokens";
const {values} = parseArgs({args:process.argv.slice(2),options:{help:{type:"boolean"},"project-url-file":{type:"string"},cache:{type:"string"}},strict:true});
if (values.help) {console.log("Verify an existing project capability after migration: --project-url-file PRIVATE_FILE --cache DIRECTORY. Uses PostgreSQL and S3 configuration from the environment.");process.exit(0);}
if (!values["project-url-file"] || !values.cache) throw new Error("specify --project-url-file and --cache");
const saved = readFileSync(values["project-url-file"],"utf8").trim();
const token = decodeURIComponent(new URL(saved).hash.slice(4));
const capability = verifyToken(token);
if (!capability || capability.kind !== "project") throw new Error("the original project capability is unavailable");
const server = createApiServer({port:0,hostname:"127.0.0.1",tls:null,storage:"postgres",artifactStorage:"s3",
  databaseUrl:process.env.HV_API_DATABASE_URL,artifactRoot:values.cache});
try {
  const response = await fetch(new URL("/api/projects/"+capability.projectId,server.url),{headers:{authorization:"Bearer "+token}});
  if (response.status !== 200) throw new Error("original project capability failed after migration");
  const project = await response.json() as {jobs: {id:string;stage:string;status:string;output:{mp4Url:string;captionsUrl:string;hlsUrl:string}}[]};
  const job = project.jobs.find(job=>job.stage==="animatic"&&job.status==="done");
  if (!job) throw new Error("the original rich animatic is missing");
  const video = await fetch(new URL(job.output.mp4Url,server.url),{headers:{range:"bytes=0-31"}});
  const bytes = (await video.arrayBuffer()).byteLength;
  const captions = await fetch(new URL(job.output.captionsUrl,server.url));
  const captionText = await captions.text();
  const hls = await fetch(new URL(job.output.hlsUrl,server.url));
  const hlsText = await hls.text();
  const report = {originalProjectCapabilityAccepted:true,videoStatus:video.status,rangeBytes:bytes,
    captionsValid:captions.status===200&&captionText.startsWith("WEBVTT"),hlsValid:hls.status===200&&hlsText.startsWith("#EXTM3U")};
  if (video.status!==206||bytes!==32||!report.captionsValid||!report.hlsValid) throw new Error("migrated media did not pass delivery checks");
  console.log(JSON.stringify(report));
} finally { await server.stop(true); }
