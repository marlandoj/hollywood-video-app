import {expect,spyOn,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {createApiServer} from "../src/server";
import {EditApi} from "../src/edit-api";

// A separate process uses raw node:net HTTP sockets. Bun.fetch in the server process can
// mask the default idle timeout; browser and independent socket clients expose it.
const SOCKET_CLIENT=String.raw`
import {connect} from 'node:net';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const input=JSON.parse(readFileSync(0,'utf8'));
const results=await Promise.all(input.cases.map(item=>new Promise(resolve=>{
  const start=performance.now(),chunks=[];let size=0,finished=false,error=null;
  const socket=connect({host:'127.0.0.1',port:input.port});
  const done=()=>{if(finished)return;finished=true;const bytes=Buffer.concat(chunks),split=bytes.indexOf('\r\n\r\n'),header=split<0?'':bytes.subarray(0,split).toString('ascii'),encoded=split<0?Buffer.alloc(0):bytes.subarray(split+4),status=Number(header.match(/^HTTP\/1\.1 ([0-9]{3})/)?.[1]??0),length=Number(header.match(/\r\ncontent-length: ([0-9]+)/i)?.[1]??-1),chunked=/\r\ntransfer-encoding: [^\r\n]*chunked/i.test(header),declaredDigest=header.match(/\r\nx-hv-preview-sha256: ([a-f0-9]{64})/i)?.[1];let body=encoded,complete=!chunked;
    if(chunked){const decoded=[];let at=0;for(;;){const line=encoded.indexOf('\r\n',at);if(line<0)break;const size=parseInt(encoded.subarray(at,line).toString('ascii'),16);if(!Number.isSafeInteger(size)||size<0||line+2+size+2>encoded.length)break;if(size===0){complete=true;break;}decoded.push(encoded.subarray(line+2,line+2+size));at=line+2+size+2;}body=Buffer.concat(decoded);}
    resolve({name:item.name,elapsedMs:performance.now()-start,status,length,chunked,complete,declaredDigest,bytes:body.length,sha256:createHash('sha256').update(body).digest('hex'),error});};
  socket.setTimeout(28000,()=>{error='client deadline';socket.destroy();});
  socket.on('connect',()=>{const method=item.method??'GET',body=method==='POST'?'{}':'';socket.write(method+' '+item.path+' HTTP/1.1\r\nHost: 127.0.0.1:'+input.port+'\r\nAuthorization: Bearer '+input.token+'\r\nConnection: close\r\n'+(body?'Content-Type: application/json\r\nContent-Length: '+body.length+'\r\n':'')+'\r\n'+body);});
  socket.on('data',bytes=>{size+=bytes.length;if(size>1024*1024){error='packet capacity';socket.destroy();return;}chunks.push(bytes);});
  socket.on('error',failure=>{error=failure.code??failure.message;});socket.on('end',done);socket.on('close',done);
})));
console.log(JSON.stringify(results));
`;
interface SocketResult {name:string;elapsedMs:number;status:number;length:number;chunked:boolean;complete:boolean;declaredDigest:string;bytes:number;sha256:string;error:string|null}
function cleanup(root:string,base:string){if(realpathSync(root)!==root||!root.startsWith(base+sep+"hv-preview-idle-"))throw new Error("Unsafe preview idle fixture cleanup.");rmSync(root,{recursive:true,force:true});}

test("independent HTTP clients receive delayed preview/original packets while metadata and non-GET routes retain their idle bound",async()=>{
  const base=realpathSync(tmpdir()),root=realpathSync(mkdtempSync(join(base,"hv-preview-idle-"))),previous=process.env.HV_TOKEN_SECRET;
  process.env.HV_TOKEN_SECRET="preview-idle-fixture-secret-at-least-thirty-two-characters";
  const packet=new Uint8Array(128*1024).fill(23),sha256=createHash("sha256").update(packet).digest("hex"),calls:string[]=[];
  const handle=spyOn(EditApi.prototype,"handle").mockImplementation(async(_parts,request)=>{
    calls.push(new URL(request.url).pathname);let at=0,first=true;
    // Authentication, method classification, rate limits and socket policy use the real API.
    // This bounded producer isolates the transport deadline from media-render performance.
    const body=new ReadableStream<Uint8Array>({async pull(controller){if(first){first=false;await Bun.sleep(15000);}if(request.signal.aborted)return;const end=Math.min(at+65536,packet.length);controller.enqueue(packet.slice(at,end));at=end;if(at===packet.length)controller.close();}},{highWaterMark:0});
    return new Response(body,{headers:{"content-type":"application/vnd.hollywood-video.preview","content-length":String(packet.length),"x-hv-preview-sha256":sha256}});
  });
  const rule={limit:1000,windowMs:60000},server=createApiServer({port:0,hostname:"127.0.0.1",tls:null,storage:"json",artifactStorage:"local",statePath:join(root,"projects.json"),queuePath:join(root,"jobs.json"),costLedgerPath:join(root,"costs.json"),artifactRoot:join(root,"media"),rateLimit:{api:rule,artifacts:rule,compositeFrames:rule}});
  let cancelChild:(()=>void)|undefined;
  try{
    const response=await fetch(new URL("/api/projects",server.url),{method:"POST"});expect(response.status).toBe(201);const owner=await response.json() as {projectId:string;token:string},prefix="/api/projects/"+owner.projectId+"/editorial",living=prefix+"/screenplay/proposals/proposal/recut-preview/review/preview/session";
    const packets=[
      {name:"sequence picture",path:prefix+"/sequences/cut/preview/session/picture/original/0"},
      {name:"version audio",path:prefix+"/versions/job/preview/session/audio/0"},
      {name:"proposal picture",path:prefix+"/assemblies/proposals/cut/preview/session/picture/timeline-picture/0"},
      {name:"accepted audio",path:prefix+"/assemblies/accepted/cut/preview/session/audio/0"},
      {name:"recut picture",path:living+"/picture/timeline-picture/0"},
      {name:"recut audio",path:living+"/audio/0"},
      {name:"original frame",path:prefix+"/sequences/cut/sources/source/frames/0"},
    ],metadata=[
      {name:"session metadata",path:living},
      {name:"lookalike packet",path:living+"/audio/0/extra"},
      {name:"packet POST",path:living+"/audio/0",method:"POST"},
    ],cases=[...packets,...metadata,{name:"preflight",path:living+"/audio/0",method:"OPTIONS"}];
    const child=Bun.spawn([process.execPath,"--eval",SOCKET_CLIENT],{stdin:Buffer.from(JSON.stringify({port:server.port,token:owner.token,cases})),stdout:"pipe",stderr:"pipe"});cancelChild=()=>child.kill();
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code).toBe(0);expect(stderr).toBe("");const results=JSON.parse(stdout) as SocketResult[];expect(results).toHaveLength(cases.length);
    for(const item of packets){const actual=results.find(result=>result.name===item.name)!;expect(actual.status).toBe(200);expect(actual.error).toBeNull();expect(actual.elapsedMs).toBeGreaterThanOrEqual(15000);expect(actual.bytes).toBe(packet.length);expect(actual.complete).toBe(true);expect(actual.length===packet.length||actual.chunked).toBe(true);expect(actual.declaredDigest).toBe(sha256);expect(actual.sha256).toBe(sha256);}
    for(const item of metadata){const actual=results.find(result=>result.name===item.name)!;expect(actual.bytes).toBeLessThan(packet.length);expect(actual.sha256).not.toBe(sha256);expect(actual.elapsedMs).toBeLessThan(15000);}
    const preflight=results.find(result=>result.name==="preflight")!;expect(preflight.status).toBe(204);expect(preflight.elapsedMs).toBeLessThan(3000);expect(calls).toHaveLength(packets.length+metadata.length);
  }finally{cancelChild?.();await server.stop(true);handle.mockRestore();if(previous===undefined)delete process.env.HV_TOKEN_SECRET;else process.env.HV_TOKEN_SECRET=previous;cleanup(root,base);}
},45000);
