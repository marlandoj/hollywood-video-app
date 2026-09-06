/** Real nginx/mTLS upload smoke against the disposable compose fixture; no inference. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAST_INPUT } from "../test/fixtures/casting";
const origin=new URL(process.argv[2] ?? "");
if(origin.origin!=="http://127.0.0.1:8081")throw new Error("This smoke requires the disposable loopback compose fixture.");
const root=mkdtempSync(join(tmpdir(),"hv-reference-proxy-"));
try {
  const file=join(root,"reference.png"),generated=Bun.spawnSync(["ffmpeg","-y","-v","error","-f","lavfi","-i","color=c=blue:s=1024x1024","-frames:v","1","-threads","1","-pix_fmt","rgb24","-compression_level","0",file]);
  if(generated.exitCode!==0)throw new Error("Reference fixture generation failed.");
  const bytes=readFileSync(file);if(bytes.length<=1024**2 || bytes.length>=10*1024**2)throw new Error("Reference fixture must exceed the default proxy body limit.");
  const json=async(path:string,method:string,body?:unknown,token?:string)=>{
    const result=await fetch(new URL(path,origin),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!result.ok)throw new Error("Reference proxy setup failed: "+result.status);return await result.json();
  };
  const owner=await json("/api/projects","POST") as {projectId:string;token:string},base="/api/projects/"+owner.projectId,id=crypto.randomUUID();
  await json(base+"/script","PUT",{text:"EXT. GARDEN - DAY\n\nSpud waves."},owner.token);
  await json(base+"/cast/"+id,"PUT",{expectedVersion:0,character:CAST_INPUT},owner.token);
  const uploaded=await fetch(new URL(base+"/cast/"+id+"/references",origin),{method:"POST",headers:{authorization:"Bearer "+owner.token,"content-type":"image/png","x-hv-cast-version":"1","x-hv-reference-attested":"true"},body:new Uint8Array(bytes)});
  if(uploaded.status!==201)throw new Error("Reference proxy upload failed: "+uploaded.status+" "+await uploaded.text());
  const saved=await uploaded.json() as {asset:{id:string;bytes:number}};
  const image=await fetch(new URL(base+"/references/"+saved.asset.id,origin),{headers:{authorization:"Bearer "+owner.token}});
  if(!image.ok || (await image.arrayBuffer()).byteLength!==saved.asset.bytes || image.headers.get("cache-control")!=="private, no-store")throw new Error("Reference proxy read failed.");
  console.log(JSON.stringify({check:"reference-proxy",uploadBytes:bytes.length,storedBytes:saved.asset.bytes,privateRead:true,inferenceRequests:0}));
} finally {rmSync(root,{recursive:true,force:true});}
