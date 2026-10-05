/**
 * HV-030-38: an S3-compatible object store on loopback that speaks enough of the protocol for Bun's
 * own S3 client to upload to it: HEAD, GET, single PUT, and the multipart calls (create, upload part,
 * complete). A call can be told to hang, answering nothing while the connection stays open, and a
 * read back can stall after half its bytes: the shapes a stuck transfer takes.
 */
import {S3Client} from "bun";

export interface StandInFaults {
  /** Part numbers whose upload never answers, for this many attempts in all (`Infinity` for always). */
  hangPart?:{number:number;times:number};
  /** The existence check never answers. */
  hangHead?:boolean;
  /** A read of a stored object sends half of it, then nothing. */
  stallRead?:boolean;
}

export function s3StandIn(faults:StandInFaults={}){
  const objects=new Map<string,Uint8Array<ArrayBuffer>>(),uploads=new Map<string,Map<number,Uint8Array<ArrayBuffer>>>(),calls:string[]=[];let hungParts=0;
  const server=Bun.serve({port:0,hostname:"127.0.0.1",idleTimeout:0,async fetch(request){
    const url=new URL(request.url),key=decodeURIComponent(url.pathname).replace(/^\/hv\//,""),query=url.searchParams;
    const call=request.method==="POST"&&query.has("uploads")?"create":request.method==="PUT"&&query.has("partNumber")?"part "+query.get("partNumber"):request.method==="POST"&&query.has("uploadId")?"complete":request.method.toLowerCase();
    calls.push(call);
    if(request.method==="HEAD"){if(faults.hangHead)return new Promise<Response>(()=>{});const object=objects.get(key);return new Response(null,object?{headers:{"content-length":String(object.byteLength)}}:{status:404});}
    if(request.method==="GET"){const object=objects.get(key);if(!object)return new Response("<Error><Code>NoSuchKey</Code></Error>",{status:404});
      if(!faults.stallRead)return new Response(object);
      return new Response(new ReadableStream({start(controller){controller.enqueue(object.slice(0,object.byteLength>>1));}}));}
    if(call==="create"){const id=crypto.randomUUID();uploads.set(id,new Map());
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>hv</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);}
    if(call.startsWith("part ")){const number=Number(query.get("partNumber")),body=new Uint8Array(await request.arrayBuffer());
      if(faults.hangPart?.number===number&&hungParts<faults.hangPart.times){hungParts++;return new Promise<Response>(()=>{});}
      uploads.get(query.get("uploadId")!)!.set(number,body);return new Response(null,{headers:{etag:`"part-${number}"`}});}
    if(call==="complete"){const parts=uploads.get(query.get("uploadId")!)!,ordered=[...parts.keys()].sort((a,b)=>a-b).map(number=>parts.get(number)!);
      const whole=new Uint8Array(ordered.reduce((sum,part)=>sum+part.byteLength,0));let offset=0;for(const part of ordered){whole.set(part,offset);offset+=part.byteLength;}
      objects.set(key,whole);return new Response(`<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>hv</Bucket><Key>${key}</Key><ETag>"whole"</ETag></CompleteMultipartUploadResult>`);}
    if(request.method==="PUT"){objects.set(key,new Uint8Array(await request.arrayBuffer()));return new Response(null,{headers:{etag:'"single"'}});}
    if(request.method==="DELETE")return new Response(null,{status:204});
    return new Response(null,{status:400});
  }});
  const client=new S3Client({endpoint:"http://127.0.0.1:"+server.port,bucket:"hv",accessKeyId:"fixture",secretAccessKey:"fixture-only",region:"us-east-1",virtualHostedStyle:false});
  return {client,objects,calls,close:()=>server.stop(true)};
}
