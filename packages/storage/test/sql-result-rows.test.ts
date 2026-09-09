import {expect,test} from "bun:test";
import {editValidationKey} from "../../planner/src/edit-validation-key";
import {StudioDatabase} from "../src/database";
import {sqlResultRows} from "../src/sql-result-rows";
import {SQLResultFixture} from "./sql-result.fixture";

const message="Invalid bounded SQL result rows";

test("SQL result subclasses normalize only dense rows into a plain container",()=>{
  const first={id:"first",body:{version:1}},second={id:"second",body:{version:2}},input=new SQLResultFixture([first,second]);
  expect(Array.isArray(input)).toBe(true);expect(Object.getPrototypeOf(input)).not.toBe(Array.prototype);
  const result=sqlResultRows(input,2,message);
  expect(Object.getPrototypeOf(result)).toBe(Array.prototype);expect(result).toEqual([first,second]);expect(result[0]).toBe(first);
  expect(Reflect.ownKeys(result)).toEqual(["0","1","length"]);expect(Object.getOwnPropertyDescriptor(input,"command")!.value).toBe("SELECT");
  result.pop();expect(input.length).toBe(2);expect(sqlResultRows([],0,message)).toEqual([]);
});

test("SQL normalization invokes no subclass iterator, map, toJSON or transport getters",()=>{
  let reads=0;class Transport extends Array<unknown>{}
  const input=new Transport();input.push({key:"owned"});
  const read=()=>{reads++;throw new Error("Transport behavior must not run");};
  for(const key of [Symbol.iterator,"map","toJSON","constructor"] as const)Object.defineProperty(Transport.prototype,key,{get:read});
  for(const key of ["command","count","lastInsertRowid","affectedRows"] as const)Object.defineProperty(input,key,{get:read});
  expect(sqlResultRows(input,1,message)).toEqual([{key:"owned"}]);expect(reads).toBe(0);
});

test("SQL normalization refuses holes, indexed accessors and hidden rows before any value read",()=>{
  let reads=0;const getter:unknown[]=[];getter.length=1;Object.defineProperty(getter,"0",{enumerable:true,get(){reads++;return {};}});
  const hidden:unknown[]=[];Object.defineProperty(hidden,"0",{value:{},enumerable:false});
  const sparse:unknown[]=[];sparse.length=1;
  for(const value of [getter,hidden,sparse,{0:{},length:1}])expect(()=>sqlResultRows(value,1,message)).toThrow(message);
  expect(reads).toBe(0);
});

test("SQL row capacity is checked before reading any entry and is never truncated",()=>{
  let reads=0;const oversized:unknown[]=[];oversized.length=100001;Object.defineProperty(oversized,"0",{enumerable:true,get(){reads++;return {};}});
  expect(()=>sqlResultRows(oversized,100000,message)).toThrow(message);expect(reads).toBe(0);
  expect(()=>sqlResultRows([{},{}],1,message)).toThrow(message);
  for(const limit of [-1,1.5,NaN,Infinity])expect(()=>sqlResultRows([],limit,message)).toThrow(message);
});

test("SQL result proxies and revoked proxies refuse without invoking traps",()=>{
  let reads=0;const trap=()=>{reads++;throw new Error("Proxy trap must not run");};
  const proxy=new Proxy([{}],{get:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap,ownKeys:trap});
  expect(()=>sqlResultRows(proxy,1,message)).toThrow(message);expect(reads).toBe(0);
  const revoked=Proxy.revocable([{}],{});revoked.revoke();expect(()=>sqlResultRows(revoked.proxy,1,message)).toThrow(message);
});

test("normalizing transport does not approve hostile domain row bodies",()=>{
  let reads=0;const row={};Object.defineProperty(row,"body",{enumerable:true,get(){reads++;return {};}});
  const rows=sqlResultRows(new SQLResultFixture([row]),1,message);
  expect(editValidationKey(rows,1024)).toBeNull();expect(reads).toBe(0);
  const plain=sqlResultRows(new SQLResultFixture([{body:{version:1}}]),1,message);
  expect(editValidationKey(plain,1024)).not.toBeNull();
});

const postgres=Boolean(process.env.HV_PG_ADMIN_URL);
(postgres?test:test.skip)("actual Bun PostgreSQL result retains dense rows after transport normalization",async()=>{
  const database=new StudioDatabase(process.env.HV_PG_ADMIN_URL!,1,{connectionTimeout:5});
  try{
    const result=await database.sql`select 1 as ordinal, '{"revision":"actual-query"}'::jsonb as body union all select 2, '{"revision":"second-query"}'::jsonb order by ordinal`;
    expect(Array.isArray(result)).toBe(true);expect(Object.getPrototypeOf(result)).not.toBe(Array.prototype);
    const rows=sqlResultRows(result,2,message);
    expect(Object.getPrototypeOf(rows)).toBe(Array.prototype);expect(rows).toEqual([{ordinal:1,body:{revision:"actual-query"}},{ordinal:2,body:{revision:"second-query"}}]);
    expect(editValidationKey(rows,1024)).not.toBeNull();expect(Object.hasOwn(rows,"command")).toBe(false);
  }finally{await database.close();}
},30000);
