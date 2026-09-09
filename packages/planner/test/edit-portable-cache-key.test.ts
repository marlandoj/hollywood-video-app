import {expect,test} from "bun:test";
import {types} from "node:util";
import {editValidationKey as old} from "../src/edit-validation-key";
import {contentHash} from "../../generator/src/capabilities";
import {editPortableCacheKey as opaque} from "../src/edit-portable-cache-key";
type Result={kind:"null"|"key"|"throw";value?:string;trace:string[]};
function result(fn:typeof old,create:(trace:string[])=>unknown,max:unknown):Result{const trace:string[]=[];
  try{const value=fn(create(trace),max as number);return {kind:value===null?"null":"key",value:value??undefined,trace};}
  catch(error){return {kind:"throw",value:error instanceof Error?error.name+":"+error.message:String(error),trace};}}
function parity(create:(trace:string[])=>unknown,max:unknown=1024*1024,fallback=false){const a=result(old,create,max),b=result(opaque,create,max);
  expect(b.kind).toBe(a.kind);expect(b.trace).toEqual(a.trace);if(a.kind==="throw"||fallback)expect(b.value).toBe(a.value);return [a,b];}
test("opaque preserves accepted/refused shape and byte/depth boundaries",()=>{
  const shared={x:1},positive=[null,true,false,0,1,1e21,1e-12,"é😀\u0000\ud800",{},Object.assign(Object.create(null),{x:1}),[],{x:undefined},[shared,shared],{b:2,a:1,"10":3,"2":4},{"\ud800":undefined,"\ud801":undefined}];
  for(const value of positive)for(const max of [0,1,2,3,4,8,16,32,1024*1024])parity(()=>value,max);
  const negative=[undefined,NaN,Infinity,-Infinity,-0,1n,()=>{},Symbol(),new Date(),new Map(),[undefined],new Array(2),Object.assign([],{extra:1}),Object.create({x:1})];
  for(const value of negative)parity(()=>value);
  parity(()=>{const x:unknown[]=[];x.push(x);return x;});
  parity(trace=>Object.defineProperty({},"x",{enumerable:true,get(){trace.push("getter");return 1;}}));
  parity(()=>Object.defineProperty({},"x",{value:1,enumerable:false}));parity(()=>({[Symbol("x")]:1}));
  for(const n of [199,200,201])for(const leaf of [{u:undefined},{u:null}])parity(()=>{let x:unknown=leaf;for(let i=0;i<n;i++)x={x};return x;});
  for(const value of [{x:"\n\"\\\ud800é😀"},{"😀":undefined},{x:[1,2,3]}]){const wire=Buffer.byteLength(JSON.stringify(value));for(const limit of [wire-1,wire,wire+1])parity(()=>value,limit);}
});
test("opaque preserves Proxy traps, revoked errors and inherited hook fallback",()=>{
  expect(typeof types.isProxy).toBe("function");let reads=0;const p=new Proxy({}, {get(){reads++;return undefined;}});expect(types.isProxy(p)).toBe(true);expect(reads).toBe(0);
  parity(trace=>new Proxy({x:1,u:undefined},{getPrototypeOf(target){trace.push("prototype");return Reflect.getPrototypeOf(target);},ownKeys(target){trace.push("keys");return Reflect.ownKeys(target);},getOwnPropertyDescriptor(target,key){trace.push("descriptor:"+String(key));return Reflect.getOwnPropertyDescriptor(target,key);},get(target,key,receiver){trace.push("get:"+String(key));return Reflect.get(target,key,receiver);}}),1024,true);
  parity(()=>{const x=Proxy.revocable({},{});x.revoke();return x.proxy;},1024,true);
  for(const owner of [Object.prototype,Array.prototype]){const previous=Object.getOwnPropertyDescriptor(owner,"toJSON");let trace:string[]=[];
    try{Object.defineProperty(owner,"toJSON",{configurable:true,get(){trace.push("toJSON");return undefined;}});
      const create=()=>({x:[1,{u:undefined}]});trace=[];const a=old(create(),1024),oldTrace=[...trace];trace=[];const b=opaque(create(),1024),newTrace=[...trace];expect(b).toBe(a);expect(newTrace).toEqual(oldTrace);
    }finally{if(previous)Object.defineProperty(owner,"toJSON",previous);else Reflect.deleteProperty(owner,"toJSON");}}
  const previous=Object.getOwnPropertyDescriptor(Array.prototype,"map")!;let calls=0;
  try{Object.defineProperty(Array.prototype,"map",{...previous,value:function(this:unknown[],...args:unknown[]){calls++;return Reflect.apply(previous.value,this,args);}});
    calls=0;const a=old({x:[1,2]},1024),oldCalls=calls;calls=0;const b=opaque({x:[1,2]},1024),newCalls=calls;expect(b).toBe(a);expect(newCalls).toBe(oldCalls);
  }finally{Object.defineProperty(Array.prototype,"map",previous);}
});
test("coercible budget retains legacy side effects and cannot create a false omission hit",()=>{
  const previous=Object.getOwnPropertyDescriptor(Object.prototype,"toJSON");
  try{const run=(fn:typeof old,x:number)=>{let calls=0;const budget={valueOf(){calls++;Object.defineProperty(Object.prototype,"toJSON",{configurable:true,value(){return {};}});return 1024;}};
      Reflect.deleteProperty(Object.prototype,"toJSON");const value=fn({x},budget as unknown as number);Reflect.deleteProperty(Object.prototype,"toJSON");return {value,calls};};
    expect(run(opaque,1)).toEqual(run(old,1));expect(run(opaque,2)).toEqual(run(old,2));expect(run(opaque,1).value).not.toBe(run(opaque,2).value);
  }finally{if(previous)Object.defineProperty(Object.prototype,"toJSON",previous);else Reflect.deleteProperty(Object.prototype,"toJSON");}
  for(const limit of [null,"1024",true,NaN,Infinity,-1])parity(()=>({x:undefined}),limit,typeof limit!=="number");
  expect(result(opaque,()=>({x:undefined}),undefined)).toEqual(result(old,()=>({x:undefined}),undefined));
});
test("opaque keys distinguish all tested omission positions and differing full content",()=>{
  const values=[{}, {x:undefined},{x:"undefined"},{x:null},{a:{u:undefined},b:{}},{a:{},b:{u:undefined}},{a:[{},{}],u:undefined},{a:[{u:undefined},{}]},{a:[{},{u:undefined}]},{"\ud800":undefined},{"\ud801":undefined},{"\u0000:1":undefined},{"":undefined}];
  expect(new Set(values.map(x=>opaque(x,1024))).size).toBe(values.length);
  let seed=12345;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  const tree=(depth:number):unknown=>{const pick=random()%(depth?7:5);if(pick<5)return [null,Boolean(random()%2),random()%100,String(random()%100),undefined][pick];if(pick===5)return [tree(depth-1)??null,tree(depth-1)??null];return {a:tree(depth-1),b:tree(depth-1),[String(random()%20)]:tree(depth-1)};};
  const seen=new Map<string,string>();for(let i=0;i<2000;i++){const value=tree(4);parity(()=>value);const key=opaque(value,1024*1024);if(key){const canonical=contentHash(value),previous=seen.get(key);if(previous!==undefined)expect(canonical).toBe(previous);seen.set(key,canonical);}}
  const shared={u:undefined};expect(opaque({a:shared,b:shared},1024)).toBe(opaque({a:{u:undefined},b:{u:undefined}},1024));
});
test("opaque identity permits reordered misses without changing canonical revisions or retaining mutable input",()=>{
  const input={first:{optional:undefined,value:1},second:[2,3]},before=contentHash(input),key=opaque(input,1024),same=structuredClone(input);
  const reordered={second:[2,3],first:{value:1,optional:undefined}};
  expect(key).not.toBeNull();expect(opaque(same,1024)).toBe(key);expect(opaque(reordered,1024)).not.toBeNull();
  expect(contentHash(reordered)).toBe(before);expect(old(input,1024)).toBe(before);expect(old(reordered,1024)).toBe(before);
  input.first.value=4;expect(opaque(input,1024)).not.toBe(key);expect(opaque(same,1024)).toBe(key);
  expect(contentHash(same)).toBe(before);
});
test("exact original 2500000-node ceiling and optional-undefined node count remain intact",()=>{
  const child=new Array(2498).fill(null),value:unknown[]=new Array(1000).fill(child);value.push(new Array(997).fill(null),null);
  // root1 + 1000*(array1+2498null) + (array1+997null) + null1 = 2,500,000.
  const accepted=parity(()=>value,32*1024**2);expect(accepted[0].kind).toBe("key");
  value[value.length-1]={u:undefined};const refused=parity(()=>value,32*1024**2);expect(refused[0].kind).toBe("null");
},90000);
