import {expect,test} from "bun:test";
import {emptyCurrentScreenplayLibrary,validateCurrentScreenplayLibrary} from "../src/current-screenplay-library";
import {contentHash} from "../../generator/src/capabilities";

test("historical validation cache checks owner types and descriptors before hashing, and never trusts a revision alone",()=>{
  const original=emptyCurrentScreenplayLibrary("cache-owner"),checked=validateCurrentScreenplayLibrary(original);expect(checked).toEqual(original);
  let reads=0;const owner={get project(){reads++;return "cache-owner";}} as unknown as string;
  expect(()=>validateCurrentScreenplayLibrary(original,owner)).toThrow();expect(reads).toBe(0);
  const accessor=structuredClone(original);Object.defineProperty(accessor,"origin",{enumerable:true,get(){reads++;return null;}});
  expect(()=>validateCurrentScreenplayLibrary(accessor)).toThrow();expect(reads).toBe(0);
  checked.headRevision="a".repeat(64);expect(validateCurrentScreenplayLibrary(original)).toEqual(original);
  const changed=structuredClone(checked),{revision:_revision,...data}=changed;changed.revision=contentHash(data);
  expect(()=>validateCurrentScreenplayLibrary(changed)).toThrow();expect(()=>validateCurrentScreenplayLibrary(original,"foreign-owner")).toThrow();
});
