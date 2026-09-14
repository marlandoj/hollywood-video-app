import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";

// The server's socket idle bound closes a keep-alive connection that sits unused; a client
// reusing that pooled socket races the close and sees ECONNRESET. Bun's 10 s default stays the
// default because slow metadata routes lean on it as a transport deadline; the bound is an
// operator setting, and test fixtures open a fresh connection per request instead of raising it.
// This test drives a raw socket so connection reuse is under its control. Bun sweeps idle
// sockets on a coarse timer, so waits leave several seconds of slack.
async function idleConnection(url:URL,idleFor:number){
  let closed=false,response="";
  const socket=await Bun.connect({hostname:url.hostname,port:Number(url.port),socket:{data(_s,chunk){response+=chunk.toString();},close(){closed=true;},error(){closed=true;}}});
  socket.write("GET /health HTTP/1.1\r\nHost: "+url.host+"\r\nConnection: keep-alive\r\n\r\n");
  const deadline=Date.now()+5000;while(!response.includes("\r\n\r\n")&&Date.now()<deadline)await Bun.sleep(10);
  expect(response.startsWith("HTTP/1.1 200")).toBe(true);
  await Bun.sleep(idleFor);
  const open=!closed;socket.end();return open;
}
function paths(){process.env.HV_TOKEN_SECRET??="http-idle-timeout-secret-at-least-thirty-two-characters";const root=mkdtempSync(join(tmpdir(),"hv-idle-timeout-"));return {root,statePath:join(root,"projects.json"),queuePath:join(root,"jobs.json"),costLedgerPath:join(root,"ledger.json"),artifactRoot:join(root,"media")};}

test("an explicit idleTimeout closes idle connections; a longer one keeps them",async()=>{
  const short=paths(),long=paths(),a=createApiServer({port:0,hostname:"127.0.0.1",idleTimeout:1,...short}),b=createApiServer({port:0,hostname:"127.0.0.1",idleTimeout:30,...long});
  try{const [closedShort,openLong]=await Promise.all([idleConnection(a.url,6_500),idleConnection(b.url,6_500)]);expect(closedShort).toBe(false);expect(openLong).toBe(true);}
  finally{a.stop();b.stop();rmSync(short.root,{recursive:true,force:true});rmSync(long.root,{recursive:true,force:true});}
},15_000);

test("the default bound is Bun's ten seconds and a nonsense setting is rejected",async()=>{
  const p=paths(),server=createApiServer({port:0,hostname:"127.0.0.1",...p});
  try{expect(await idleConnection(server.url,15_500)).toBe(false);}
  finally{server.stop();rmSync(p.root,{recursive:true,force:true});}
  const previous=process.env.HV_HTTP_IDLE_TIMEOUT_SECONDS;process.env.HV_HTTP_IDLE_TIMEOUT_SECONDS="soon";
  const q=paths();
  try{expect(()=>createApiServer({port:0,hostname:"127.0.0.1",...q})).toThrow("HV_HTTP_IDLE_TIMEOUT_SECONDS");}
  finally{if(previous===undefined)delete process.env.HV_HTTP_IDLE_TIMEOUT_SECONDS;else process.env.HV_HTTP_IDLE_TIMEOUT_SECONDS=previous;rmSync(q.root,{recursive:true,force:true});}
},25_000);
