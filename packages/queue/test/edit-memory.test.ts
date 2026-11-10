import {expect,test} from "bun:test";
import {EDIT_MEMORY_DEFAULT_MIB,editMemoryGuard,editMemoryLimitBytes,hostMemoryAttributes} from "../src/edit-access";
import {EditConflict,EditResourceLimit} from "../../planner/src/edit-errors";

// HV-025-14: the editorial worker's memory cap, its reading of the worker, and the host figures each phase records.
test("the cap defaults, reads whole MiB and refuses anything else by name",()=>{
  expect(editMemoryLimitBytes({})).toBe(EDIT_MEMORY_DEFAULT_MIB*2**20);
  expect(editMemoryLimitBytes({HV_EDIT_MAX_RSS_MB:""})).toBe(EDIT_MEMORY_DEFAULT_MIB*2**20);
  expect(editMemoryLimitBytes({HV_EDIT_MAX_RSS_MB:"2048"})).toBe(2048*2**20);
  for(const bad of ["0","255","1.5","-1","2GB"," 2048","08"])expect(()=>editMemoryLimitBytes({HV_EDIT_MAX_RSS_MB:bad})).toThrow("HV_EDIT_MAX_RSS_MB must be a whole number of MiB, at least 256");
});

test("the guard records the peak and throws the caller's error once the worker is over the cap",()=>{
  let rss=100*2**20;const guard=editMemoryGuard(256*2**20,message=>{throw new EditResourceLimit(message);},()=>rss);
  guard.check();rss=200*2**20;guard.check();rss=150*2**20;guard.check();expect(guard.peak()).toBe(200*2**20);
  rss=300*2**20;let thrown:unknown;try{guard.check();}catch(error){thrown=error;}
  expect(thrown).toBeInstanceOf(EditResourceLimit);expect(thrown).toBeInstanceOf(EditConflict);
  expect((thrown as Error).message).toBe("The editorial render used 300 MiB, over its 256 MiB limit (HV_EDIT_MAX_RSS_MB).");
  expect(guard.peak()).toBe(300*2**20);
  expect(editMemoryGuard(EDIT_MEMORY_DEFAULT_MIB*2**20,message=>{throw new Error(message);}).peak()).toBe(0);
});

test("host memory comes from /proc/meminfo in bytes, and is empty where there is none",()=>{
  expect(hostMemoryAttributes(()=>"MemTotal:       32000000 kB\nMemAvailable:   1000 kB\nCached:         2048 kB\nDirty:             4 kB\nSwapFree:          0 kB\n")).toEqual({"hv.host.mem_available_bytes":1000*1024,"hv.host.mem_cached_bytes":2048*1024,"hv.host.mem_dirty_bytes":4096,"hv.host.swap_free_bytes":0});
  expect(hostMemoryAttributes(()=>undefined)).toEqual({});
});
