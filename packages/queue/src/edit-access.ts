/**
 * HV-025-05: an editorial worker's lease-and-permission check, run at most once per interval.
 *
 * Media verification calls `access()` before every retained file it hashes, and a picture edit with
 * graphics retains every graphic frame, so one job made thousands of calls. Each call renewed the lease
 * and re-validated the whole editorial plan and every source binding, which made the job quadratic in
 * graphic frames. `editWorkspaceGuard` already checks the workspace at most once per second; this
 * does the same for the lease and permission check.
 *
 * - `cheap` (abort and deadline) still runs on every call.
 * - `check` (heartbeat and permission) runs when the interval has passed, or when `force` is set.
 *   The worker forces it before admission, checkpoint and completion.
 * - A failed check is not remembered as passed: the next call runs it again.
 * - Concurrent callers share one in-flight check instead of starting another.
 */
export function throttledEditAccess(cheap:()=>void,check:()=>Promise<void>,intervalMs=1000,clock:()=>number=()=>performance.now()):(force?:boolean)=>Promise<void>{
  let last=-Infinity,pending:Promise<void>|undefined;
  const run=():Promise<void>=>pending??=(async()=>{try{const started=clock();await check();last=started;}finally{pending=undefined;}})();
  return async(force=false)=>{
    cheap();const at=clock();
    if(force){if(pending)await pending.catch(()=>{});await run();}
    else if(pending||at<last||at-last>=intervalMs)await run();
    cheap();
  };
}
