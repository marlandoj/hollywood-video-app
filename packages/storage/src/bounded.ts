/**
 * HV-030-34, HV-030-38: one wait on the object store, bounded.
 *
 * Bun's S3 client can leave a promise that never settles: a streamed Response through `Bun.write`
 * (HV-030-34), and a streamed Response through `S3File.write` once the upload is multipart (HV-030-38).
 * Nothing is in flight when that happens, so no socket timeout fires. Every such wait goes through
 * here: it settles with `work`, or fails at the job's abort, at its deadline when one is known, or when
 * `work` makes no progress for `stallMs`.
 */
export interface WaitBounds {
  signal?:AbortSignal;stallMs:number;
  /** The job's deadline, read with `now`, when the caller knows it. */
  deadline?:number;now?:()=>number;
  /** The error for a wait that outlasts `stallMs`. */
  stalled:()=>Error;
  /** The error for a wait that outlasts the deadline. */
  late?:()=>Error;
  /** The error for an abort whose signal carries no reason. */
  aborted?:()=>Error;
}

export function bounded<T>(work:Promise<T>|T,bounds:WaitBounds):Promise<T>{
  return new Promise<T>((resolve,reject)=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const done=()=>{clearTimeout(timer);bounds.signal?.removeEventListener("abort",aborted);};
    const aborted=()=>{done();reject(bounds.signal!.reason??bounds.aborted?.()??new Error("The object store transfer was stopped."));};
    if(bounds.signal?.aborted)return aborted();
    const left=bounds.deadline===undefined?Infinity:bounds.deadline-(bounds.now??Date.now)(),late=bounds.late??(()=>new Error("The job ran out of time waiting on the object store."));
    if(left<=0){reject(late());return;}
    timer=setTimeout(()=>{done();reject(left<=bounds.stallMs?late():bounds.stalled());},Math.min(left,bounds.stallMs));
    bounds.signal?.addEventListener("abort",aborted,{once:true});
    Promise.resolve(work).then(value=>{done();resolve(value);},error=>{done();reject(error);});
  });
}
