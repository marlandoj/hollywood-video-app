/** Share only an access check that is still running within one operation.
 * Nested media timers and explicit checks may otherwise start the same expensive
 * held validation concurrently. Settlement clears the promise before callers
 * resume; the next check always reads fresh authority. Never retain a result,
 * expiry window, project snapshot or cross-operation cache here. Mutation and
 * provider-dispatch fences must call the underlying access function directly. */
export function currentFilmAccess(access:()=>Promise<void>):()=>Promise<void> {
  let pending:Promise<void>|undefined;
  return ()=>{
    if(!pending){
      const current=Promise.resolve().then(access).finally(()=>{if(pending===current)pending=undefined;});
      pending=current;
    }
    return pending;
  };
}
