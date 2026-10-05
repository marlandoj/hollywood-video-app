import {createHash} from "node:crypto";
import {renameSync,rmSync} from "node:fs";
import type {PostgresArtifactStore} from "../../storage/src/artifacts";
import type {RenderFile} from "../../planner/src/shot-reuse";
import {bounded as boundedWait} from "../../storage/src/bounded";

/** HV-030-34: how long a stored artifact's stream may send nothing before its copy gives up. */
export const STORED_ARTIFACT_STALL_MS=120_000;

export interface StoredArtifactCopy {
  projectId:string;jobId:string;key:string;
  /** Where the verified bytes land. They are written beside it first and renamed into place only once checked. */
  target:string;
  /** What the source is, for the failure message: "Sequence 2's film". */
  name:string;
  /** The size and sha256 the source's own job recorded, when it records them. Otherwise the store's checksummed record is the expectation. */
  recorded?:Pick<RenderFile,"bytes"|"sha256">;
  signal:AbortSignal;deadline:number;now:()=>number;
  /** How long the stream may send nothing (default `STORED_ARTIFACT_STALL_MS`). */
  stallMs?:number;
}

/**
 * Waits for `work`, but no longer than the job's signal, its deadline or the stall bound allow.
 * A stream that stops sending fails the job instead of holding its lease until the timeout.
 */
function bounded<T>(work:Promise<T>,copy:StoredArtifactCopy):Promise<T>{
  const stall=copy.stallMs??STORED_ARTIFACT_STALL_MS;
  return boundedWait(work,{signal:copy.signal,deadline:copy.deadline,now:copy.now,stallMs:stall,
    late:()=>new Error(copy.name+" was still downloading from the object store when the job ran out of time."),
    stalled:()=>new Error("The object store sent nothing of "+copy.name+" for "+stall/1000+" s."),
    aborted:()=>new Error(copy.name+"'s download was stopped.")});
}

/**
 * HV-030-34: copies one artifact out of the object store to `target`, streamed chunk by chunk into a
 * writer, as shot reuse and the final's dialogue do. Every byte is counted and hashed against the
 * source's recorded size and sha256 before it is renamed into place. A missing, changed, short or long
 * source throws, and so does a stream that stalls, the job's abort and its deadline: it never hangs.
 *
 * `Bun.write(path, response)` is not used: on Bun 1.4.0 it never settles for a Response whose body
 * is a stream, which the object store's `response()` always is.
 */
export async function copyStoredArtifact(artifacts:Pick<PostgresArtifactStore,"response">,copy:StoredArtifactCopy):Promise<Pick<RenderFile,"bytes"|"sha256">>{
  copy.signal.throwIfAborted();
  const response=await bounded(artifacts.response(copy.projectId,copy.jobId,copy.key,new Request("http://worker.invalid/",{signal:copy.signal})),copy);
  if(!response||response.status!==200||!response.body)throw new Error(copy.name+" is missing from the object store.");
  const reader=response.body.getReader(),etag=/^"([0-9a-f]{64})"$/.exec(response.headers.get("etag")??""),length=Number(response.headers.get("content-length"));
  const stored=etag&&Number.isSafeInteger(length)&&length>=0?{sha256:etag[1]!,bytes:length}:null;
  if(!stored||(copy.recorded&&(copy.recorded.sha256!==stored.sha256||copy.recorded.bytes!==stored.bytes))){
    void reader.cancel().catch(()=>{});throw new Error(copy.name+" in the object store differs from its record.");
  }
  const expected=copy.recorded??stored,temporary=copy.target+"."+crypto.randomUUID()+".download",writer=Bun.file(temporary).writer(),hash=createHash("sha256");let bytes=0;
  try{
    for(;;){
      const {done,value}=await bounded(reader.read(),copy);if(done)break;
      bytes+=value.byteLength;if(bytes>expected.bytes)throw new Error(copy.name+" is longer in the object store than its record.");
      hash.update(value);writer.write(value);await writer.flush();
    }
    await writer.end();
    if(bytes!==expected.bytes)throw new Error(copy.name+" ended after "+bytes+" of its "+expected.bytes+" bytes.");
    if(hash.digest("hex")!==expected.sha256)throw new Error(copy.name+" failed its checksum: the object store's bytes differ from its record.");
    renameSync(temporary,copy.target);return {...expected};
  }catch(error){
    void reader.cancel(error).catch(()=>{});await writer.end();rmSync(temporary,{force:true});throw error;
  }
}
