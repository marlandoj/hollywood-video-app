import {expect,test} from "bun:test";
import {createConnection,type Socket} from "node:net";
import {PreviewResponses} from "../src/preview-response";
const sha="a".repeat(64),access=async()=>{};
async function until(check:()=>boolean,timeout=3000){const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw new Error("Preview response test did not reach its expected state.");await Bun.sleep(5);}}
test("preview response capacity includes unread bodies, copies bounded chunks and releases on cancellation or source loss",async()=>{
  const pool=new PreviewResponses(1),source=new AbortController();try{const lease=pool.open(new Request("http://fixture/")),bytes=new Uint8Array(128*1024).fill(7),response=lease.response(bytes,sha,access,source.signal);expect(pool.active).toBe(1);expect(()=>pool.open(new Request("http://fixture/"))).toThrow("busy");const reader=response.body!.getReader(),first=await reader.read();expect(first.value!.length).toBe(64*1024);bytes[0]=9;expect(first.value![0]).toBe(7);expect(pool.active).toBe(1);source.abort(new Error("source expired"));await expect(reader.read()).rejects.toThrow("source expired");expect(pool.active).toBe(0);
    const next=pool.open(new Request("http://fixture/")),other=next.response(new Uint8Array(128),sha,access);await other.body!.cancel();expect(pool.active).toBe(0);
  }finally{pool.close();}
});
test("preview delivery deadline and close release a stalled request and deny byte production after permission loss",async()=>{
  const pool=new PreviewResponses(2,100);try{const lease=pool.open(new Request("http://fixture/")),response=lease.response(new Uint8Array(128),sha,async()=>{throw new Error("permission withdrawn");});await expect(response.arrayBuffer()).rejects.toThrow("withdrawn");expect(pool.active).toBe(0);
    const held=pool.open(new Request("http://fixture/")),reader=held.response(new Uint8Array(128),sha,()=>new Promise<void>(()=>{})).body!.getReader(),read=reader.read();void read.catch(()=>{});await expect(read).rejects.toThrow("timed out");expect(pool.active).toBe(0);
    const last=pool.open(new Request("http://fixture/")),body=last.response(new Uint8Array(128),sha,access);pool.close();await expect(body.arrayBuffer()).rejects.toThrow("stopped");expect(()=>pool.open(new Request("http://fixture/"))).toThrow("stopped");
  }finally{pool.close();}
});
test("a paused network client retains its response slot until disconnect rather than queuing the entire page without backpressure",async()=>{
  const pool=new PreviewResponses(1,10000),packet=new Uint8Array(16*1024**2),server=Bun.serve({port:0,hostname:"127.0.0.1",fetch(request){try{const lease=pool.open(request);return lease.response(packet,sha,access);}catch{return new Response("busy",{status:429});}}});let socket:Socket|undefined;
  try{socket=createConnection({host:"127.0.0.1",port:server.port!});await new Promise<void>((resolve,reject)=>{socket!.once("connect",resolve);socket!.once("error",reject);});socket.pause();socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");await until(()=>pool.active===1);await Bun.sleep(100);expect(pool.active).toBe(1);expect((await fetch(server.url)).status).toBe(429);socket.destroy();await until(()=>pool.active===0);
  }finally{socket?.destroy();pool.close();await server.stop(true);}
});
