import {expect,test} from "bun:test";
import {currentFilmAccess} from "../src/current-film-access";

test("simultaneous checks share only in-flight work and the next check observes revoked authority",async()=>{
  let calls=0,allowed=true,release!:()=>void;
  const hold=new Promise<void>(resolve=>{release=resolve;}),access=currentFilmAccess(async()=>{
    calls++;if(calls===1)await hold;if(!allowed)throw new Error("revoked");
  });
  const first=access(),second=access();expect(second).toBe(first);await Promise.resolve();expect(calls).toBe(1);
  release();await Promise.all([first,second]);allowed=false;
  await expect(access()).rejects.toThrow("revoked");expect(calls).toBe(2);
  allowed=true;await access();expect(calls).toBe(3);
});

test("a failed overlapping check rejects all callers and cannot poison a later operation",async()=>{
  let calls=0,reject!:(reason:Error)=>void;
  const hold=new Promise<void>((_resolve,no)=>{reject=no;}),access=currentFilmAccess(async()=>{if(++calls===1)await hold;});
  const first=access(),second=access(),settled=Promise.allSettled([first,second]);reject(new Error("lease changed"));
  const result=await settled;expect(result.every(value=>value.status==="rejected")).toBe(true);expect(calls).toBe(1);
  await access();expect(calls).toBe(2);
  const independent=currentFilmAccess(async()=>{calls++;});await Promise.all([access(),independent()]);expect(calls).toBe(4);
});

test("synchronous access errors clear the pending check",async()=>{
  let calls=0;const access=currentFilmAccess(()=>{calls++;throw new Error("unavailable");});
  await expect(access()).rejects.toThrow("unavailable");await expect(access()).rejects.toThrow("unavailable");expect(calls).toBe(2);
});

test("a direct mutation fence observes new authority while an earlier media check remains in flight",async()=>{
  let allowed=true,calls=0,release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
  const fresh=async()=>{const snapshot=allowed;if(++calls===1)await hold;if(!snapshot)throw new Error("revoked before publication");};
  const media=currentFilmAccess(fresh),older=media();await Promise.resolve();allowed=false;
  await expect(fresh()).rejects.toThrow("revoked before publication");expect(calls).toBe(2);
  release();await older;
});
