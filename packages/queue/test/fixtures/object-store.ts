/**
 * HV-030-34: an S3-compatible object store on loopback, behind the real `PostgresArtifactStore.response`.
 *
 * Staging keeps artifacts in an object store (rustfs) behind `PostgresArtifactStore`, whose
 * `response()` answers a Response whose body is the Bun S3 client's own stream. This serves objects to
 * that same client over HTTP and answers the artifact table's one lookup from a map, so a worker reads
 * its sources exactly as it does on staging. An object can be served changed, short, or stalled
 * part-way, and its record can be removed.
 */
import {S3Client} from "bun";
import {createHash} from "node:crypto";
import {basename} from "node:path";
import {PostgresArtifactStore} from "../../../storage/src/artifacts";
import type {StudioDatabase} from "../../../storage/src/database";

export interface StoredObject {served:Uint8Array<ArrayBuffer>;stall?:boolean}
export const sha256=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");

export function objectStore(cacheRoot:string){
  const objects=new Map<string,StoredObject>(),rows=new Map<string,Record<string,unknown>>(),requests:string[]=[];
  const server=Bun.serve({port:0,hostname:"127.0.0.1",fetch(request){
    const objectKey=decodeURIComponent(new URL(request.url).pathname).replace(/^\/hv\//,"");requests.push(request.method+" "+objectKey);
    const object=objects.get(objectKey);if(!object||request.method!=="GET")return new Response(null,{status:404});
    if(!object.stall)return new Response(object.served,{headers:{"content-type":"application/octet-stream"}});
    // Half the object, then nothing more: the connection stays open and the stream never ends.
    return new Response(new ReadableStream({start(controller){controller.enqueue(object.served.slice(0,object.served.length>>1));}}));
  }});
  const client=new S3Client({endpoint:"http://127.0.0.1:"+server.port,bucket:"hv",accessKeyId:"fixture",secretAccessKey:"fixture-only",region:"us-east-1",virtualHostedStyle:false});
  // The one query `response()` asks: `select * from hv_artifacts where key = $1 and project_id = $2 and job_id = $3`.
  const sql=(_strings:TemplateStringsArray,...values:unknown[])=>{const row=rows.get(values.slice(1,3).join("/")+"|"+values[0]);return Promise.resolve(row?[row]:[]);};
  const database={forProject:async<T>(_projectId:string,work:(tx:typeof sql)=>Promise<T>)=>work(sql)} as unknown as StudioDatabase;
  const artifacts=new PostgresArtifactStore(database,cacheRoot,client);
  return {
    artifacts,requests,objects,rows,
    /** Records `bytes` as `key` of the job, as a published artifact is recorded, and serves them. */
    put(projectId:string,jobId:string,key:string,bytes:Uint8Array<ArrayBuffer>){
      const digest=sha256(bytes),objectKey=`v1/${projectId}/${jobId}/${digest}/${basename(key)}`;
      rows.set(`${projectId}/${jobId}|${key}`,{key,object_key:objectKey,backend:"s3",sha256:digest,bytes:bytes.byteLength,content_type:"application/octet-stream",project_id:projectId,job_id:jobId});
      objects.set(objectKey,{served:bytes});
      return {path:key,bytes:bytes.byteLength,sha256:digest};
    },
    /** The object stored for `key`, to serve it changed, short or stalled. */
    object(projectId:string,jobId:string,key:string):StoredObject{return objects.get(String(rows.get(`${projectId}/${jobId}|${key}`)!.object_key))!;},
    close:()=>server.stop(true),
  };
}
