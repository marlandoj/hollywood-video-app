import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";

// A keep-alive connection that outlives the server's idle timeout is closed by the server; a
// client reusing it then sees ECONNRESET. The API keeps idle connections for two minutes by
// default so tests and browsers that pause between requests (render jobs, long polls) do not race
// the close. This test drives a raw socket so connection reuse is under its control.
async function idleConnection(url:URL,idleFor:number){
  const target=url;let closed=false,response="";
  const socket=await Bun.connect({hostname:target.hostname,port:Number(target.port),socket:{data(_s,chunk){response+=chunk.toString();},close(){closed=true;},error(){closed=true;}}});
  socket.write("GET /health HTTP/1.1\r\nHost: "+target.host+"\r\nConnection: keep-alive\r\n\r\n");
  const deadline=Date.now()+5000;while(!response.includes("\r\n\r\n")&&Date.now()<deadline)await Bun.sleep(10);
  expect(response.startsWith("HTTP/1.1 200")).toBe(true);
  await Bun.sleep(idleFor);
  const open=!closed;socket.end();return open;
}
function paths(){process.env.HV_TOKEN_SECRET??="http-idle-timeout-secret-at-least-thirty-two-characters";const root=mkdtempSync(join(tmpdir(),"hv-idle-timeout-"));return {root,statePath:join(root,"projects.json"),queuePath:join(root,"jobs.json"),costLedgerPath:join(root,"ledger.json"),artifactRoot:join(root,"media")};}

test("idle keep-alive connections survive well past Bun's ten-second default",async()=>{
  const p=paths(),server=createApiServer({port:0,hostname:"127.0.0.1",...p});
  try{expect(await idleConnection(server.url,12_000)).toBe(true);}
  finally{server.stop();rmSync(p.root,{recursive:true,force:true});}
},20_000);

test("an explicit idleTimeout closes idle connections and rejects nonsense",async()=>{
  const p=paths(),server=createApiServer({port:0,hostname:"127.0.0.1",idleTimeout:1,...p});
  try{expect(await idleConnection(server.url,6_500)).toBe(false);}
  finally{server.stop();rmSync(p.root,{recursive:true,force:true});}
  const previous=process.env.HV_HTTP_IDLE_TIMEOUT_SECONDS;process.env.HV_HTTP_IDLE_TIMEOUT_SECONDS="soon";
  const q=paths();
  try{expect(()=>createApiServer({port:0,hostname:"127.0.0.1",...q})).toThrow("HV_HTTP_IDLE_TIMEOUT_SECONDS");}
  finally{if(previous===undefined)delete process.env.HV_HTTP_IDLE_TIMEOUT_SECONDS;else process.env.HV_HTTP_IDLE_TIMEOUT_SECONDS=previous;rmSync(q.root,{recursive:true,force:true});}
},15_000);
