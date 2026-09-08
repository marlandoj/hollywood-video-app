/** Cancel an observational wait without treating an in-flight write as cancelled.
 * Invoke mutations directly and retain their settlement in the service operation. */
export async function livingScriptRead<T>(read:()=>Promise<T>|T,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();let abort=()=>{};
  try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return read();}),new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();})]);}
  finally{signal.removeEventListener("abort",abort);}
}
