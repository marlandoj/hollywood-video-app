import {readFileSync} from "node:fs";
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

/** HV-025-14: the setting that caps one editorial worker's resident memory, in MiB. */
export const EDIT_MEMORY_SETTING="HV_EDIT_MAX_RSS_MB";
/**
 * Default cap: well above the 150-500 MiB a picture edit measures and estimates, and well below a
 * share of the 31 GB staging VM that three workers, Postgres and RustFS have to split.
 */
export const EDIT_MEMORY_DEFAULT_MIB=4096;
/** Largest cap accepted, in MiB (about 9.5 TiB): seven digits, far past any host, and its bytes stay a safe integer. */
export const EDIT_MEMORY_MAX_MIB=9_999_999;
/**
 * The cap in bytes. Unset is the default. Anything else, an empty value included, must be a whole number
 * of MiB from 256 to EDIT_MEMORY_MAX_MIB, or it is refused by name: an empty value is usually a
 * substitution that went wrong, and it should not quietly become the default.
 */
export function editMemoryLimitBytes(env:Record<string,string|undefined>=process.env):number{
  const raw=env[EDIT_MEMORY_SETTING];if(raw===undefined)return EDIT_MEMORY_DEFAULT_MIB*2**20;
  if(!/^[1-9][0-9]{0,6}$/.test(raw)||Number(raw)<256)throw new Error(`${EDIT_MEMORY_SETTING} must be a whole number of MiB from 256 to ${EDIT_MEMORY_MAX_MIB} (it is "${raw}").`);
  return Number(raw)*2**20;
}
/**
 * The worker's own resident memory, checked on every access call beside the deadline. It records the
 * peak it saw, for the phase spans. It cannot see ffmpeg children or the page cache; the host's
 * cgroup and WSL limits are what bound those.
 */
export function editMemoryGuard(limitBytes:number,fail:(message:string)=>never,rss:()=>number=()=>process.memoryUsage.rss()):{check:()=>void;peak:()=>number}{
  let peak=0;
  return {check(){const now=rss();if(now>peak)peak=now;if(now>limitBytes)fail(`The editorial render used ${Math.round(now/2**20)} MiB, over its ${Math.round(limitBytes/2**20)} MiB limit (${EDIT_MEMORY_SETTING}).`);},peak:()=>peak};
}
/** Page cache, dirty pages and free swap from /proc/meminfo, in bytes; empty where there is none. */
export function hostMemoryAttributes(read:()=>string|undefined=()=>{try{return readFileSync("/proc/meminfo","utf8");}catch{return undefined;}}):Record<string,number>{
  const text=read();if(!text)return {};const out:Record<string,number>={},names:Record<string,string>={Cached:"hv.host.mem_cached_bytes",Dirty:"hv.host.mem_dirty_bytes",MemAvailable:"hv.host.mem_available_bytes",SwapFree:"hv.host.swap_free_bytes"};
  for(const line of text.split("\n")){const match=/^(\w+):\s+(\d+) kB$/.exec(line.trim());if(match&&names[match[1]!])out[names[match[1]!]!]=Number(match[2])*1024;}
  return out;
}
