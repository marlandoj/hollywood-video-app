import {expect,test} from "bun:test";
import {VersionStore,type ScriptVersion} from "../src/index";

test("editing a restored noncontiguous screenplay advances its exact latest version and parent",()=>{
  const history:ScriptVersion[]=[{version:1,text:"Original",parentVersion:null,createdAt:"2026-01-01T00:00:00.000Z"},{version:4,text:"Retained revision",parentVersion:1,createdAt:"2026-01-02T00:00:00.000Z"}];
  const store=VersionStore.hydrate(history),revised=store.commit("Linked screenplay"),next=store.commit("Later ordinary edit");
  expect(revised.version).toBe(5);expect(revised.parentVersion).toBe(4);expect(next.version).toBe(6);expect(next.parentVersion).toBe(5);
  expect(store.history().slice(0,2)).toEqual(history);expect(store.get(3)).toBeUndefined();expect(store.get(4)!.text).toBe("Retained revision");
});
test("empty and contiguous screenplay histories preserve ordinary version behavior",()=>{
  const store=new VersionStore(),first=store.commit("First"),second=store.commit("Second");
  expect([first.version,first.parentVersion,second.version,second.parentVersion]).toEqual([1,null,2,1]);
});
test("an exhausted version identity fails without appending an inexact revision",()=>{
  const history:ScriptVersion[]=[{version:Number.MAX_SAFE_INTEGER,text:"Last identity",parentVersion:null,createdAt:"2026-01-01T00:00:00.000Z"}],store=VersionStore.hydrate(history);
  expect(()=>store.commit("Overflow")).toThrow("retained identity");expect(store.history()).toEqual(history);
});
