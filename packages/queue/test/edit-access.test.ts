import {expect,test} from "bun:test";
import {throttledEditAccess} from "../src/edit-access";

// HV-025-05: an editorial worker verifies every retained graphic frame, and each file used to run the
// full lease and permission check. The check now runs at most once per interval, and is forced before
// admission, checkpoint and completion.
function fixture(){
  let clock=0,cheap=0,checks=0,fail:Error|undefined;
  const access=throttledEditAccess(()=>{cheap++;},async()=>{checks++;await Bun.sleep(0);if(fail)throw fail;},1000,()=>clock);
  return {access,tick:(ms:number)=>{clock+=ms;},fail:(error?:Error)=>{fail=error;},counts:()=>({cheap,checks})};
}

test("verifying many frames within a second runs the lease and permission check once",async()=>{
  const f=fixture();for(let frame=0;frame<300;frame++)await f.access();
  expect(f.counts().checks).toBe(1);expect(f.counts().cheap).toBe(600);
  f.tick(999);await f.access();expect(f.counts().checks).toBe(1);
  f.tick(1);await f.access();expect(f.counts().checks).toBe(2);
});

test("a forced check always runs, even inside the interval",async()=>{
  const f=fixture();await f.access();await f.access(true);await f.access(true);expect(f.counts().checks).toBe(3);
});

test("a failed check is not remembered as passed",async()=>{
  const f=fixture(),denied=new Error("This graphic or its project permission is no longer available.");
  f.fail(denied);await expect(f.access()).rejects.toBe(denied);await expect(f.access()).rejects.toBe(denied);expect(f.counts().checks).toBe(2);
  f.fail();await f.access();f.fail(denied);await f.access();await expect(f.access(true)).rejects.toBe(denied);
});

test("concurrent callers share one in-flight check",async()=>{
  const f=fixture();await Promise.all(Array.from({length:20},()=>f.access()));expect(f.counts().checks).toBe(1);
});

test("abort and deadline checks still run on every call",async()=>{
  let aborted=false;const access=throttledEditAccess(()=>{if(aborted)throw new Error("aborted");},async()=>{},1000,()=>0);
  await access();aborted=true;await expect(access()).rejects.toThrow("aborted");
});
