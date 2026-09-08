import {expect,test} from "bun:test";
import {HistoricalValidationCache} from "../src/historical-validation-cache";

test("historical memo validates once, copies both directions and evicts by exact input",()=>{
  let calls=0;const cache=new HistoricalValidationCache((input:{text:string})=>{calls++;return {nested:{text:input.text}};},{entries:2,bytes:512,entryBytes:256});
  const input={text:"first"},first=cache.get(input);first.nested.text="caller changed";input.text="input changed";
  expect(cache.get({text:"first"})).toEqual({nested:{text:"first"}});expect(calls).toBe(1);
  cache.get({text:"second"});cache.get({text:"third"});expect(calls).toBe(3);
  expect(cache.get({text:"first"}).nested.text).toBe("first");expect(calls).toBe(4);
  cache.get({text:"x".repeat(300)});cache.get({text:"x".repeat(300)});expect(calls).toBe(6);
});

test("JSON-equivalent nonportable values cannot bypass validation through a warm memo",()=>{
  let calls=0;const cache=new HistoricalValidationCache((input:unknown)=>{calls++;if(calls>1)throw new Error("ordinary validation ran");return input;});
  cache.get({items:[0]});
  const extra={items:[0]};Object.assign(extra.items,{hidden:"dropped by JSON"});
  const symbol={items:[0]};Object.defineProperty(symbol,Symbol("hidden"),{value:true});
  const undefinedField={items:[0],extra:undefined},negativeZero={items:[-0]},getter={};let reads=0;
  Object.defineProperty(getter,"items",{enumerable:true,get(){reads++;return [0];}});
  for(const value of [extra,symbol,undefinedField,negativeZero,getter])expect(()=>cache.get(value)).toThrow("ordinary validation ran");
  expect(reads).toBe(0);expect(calls).toBe(6);
});

test("failed validation never populates a cache entry and retained byte bounds evict",()=>{
  let calls=0;const cache=new HistoricalValidationCache((input:{text:string})=>{calls++;if(input.text==="bad")throw new Error("invalid seal");return input;},{entries:16,bytes:70,entryBytes:70});
  expect(()=>cache.get({text:"bad"})).toThrow();expect(()=>cache.get({text:"bad"})).toThrow();expect(calls).toBe(2);
  cache.get({text:"one"});cache.get({text:"two"});cache.get({text:"three"});cache.get({text:"one"});expect(calls).toBe(6);
});
