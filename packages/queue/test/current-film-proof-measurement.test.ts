import {afterEach,expect,spyOn,test} from "bun:test";
import {createHash} from "node:crypto";
import {appendFileSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {measureLocalCurrentFilmProofFile} from "../src/current-film-proof";

const roots:string[]=[],prefix=join(resolve(tmpdir()),"hv-proof-measurement-");
afterEach(()=>{for(const root of roots.splice(0)){
  if(!resolve(root).startsWith(prefix)||dirname(resolve(root))!==resolve(tmpdir()))throw new Error("Unexpected measurement fixture cleanup path.");
  rmSync(root,{recursive:true,force:true});
}});
function fixture(bytes=2*1024**2+17){
  const root=mkdtempSync(prefix);roots.push(root);const key="project/original/media.bin",path=join(root,key),body=Buffer.alloc(bytes,7);
  // Nonuniform boundaries make a repeated block or misplaced tail observable.
  for(let offset=0;offset<body.length;offset+=65537)body[offset]=offset%251;
  mkdirSync(dirname(path),{recursive:true});writeFileSync(path,body);
  return {root,key,path,body,file:{path:key,bytes,sha256:createHash("sha256").update(body).digest("hex")}};
}

test("local proof measurement checks access per bounded MiB, retains the exact tail and measures current bytes",async()=>{
  const f=fixture(),identity=lstatSync(f.path).ino;let checks=0;
  const measured=await measureLocalCurrentFilmProofFile(f.root,f.key,async()=>{checks++;},new AbortController().signal,f.file);
  expect(measured).toEqual(f.file);expect(checks).toBe(4);expect(lstatSync(f.path).ino).toBe(identity);
  expect(readFileSync(f.path).equals(f.body)).toBe(true);
  const changed=Buffer.from(f.body);changed[1024**2+9]=changed[1024**2+9]!^1;writeFileSync(f.path,changed);
  const second=await measureLocalCurrentFilmProofFile(f.root,f.key,async()=>{},new AbortController().signal,f.file);
  expect(second.bytes).toBe(f.file.bytes);expect(second.sha256).toBe(createHash("sha256").update(changed).digest("hex"));
  expect(second.sha256).not.toBe(measured.sha256);
});

test("revocation between bounded local proof reads stops measurement and preserves the source",async()=>{
  const f=fixture();let checks=0;
  await expect(measureLocalCurrentFilmProofFile(f.root,f.key,async()=>{
    if(++checks===3)throw new Error("current source permission revoked");
  },new AbortController().signal,f.file)).rejects.toThrow("permission revoked");
  expect(checks).toBe(3);expect(readFileSync(f.path).equals(f.body)).toBe(true);
});

test("local proof measurement rejects a same-size pathname replacement after opening the original inode",async()=>{
  const f=fixture(17),moved=f.path+".old";let checks=0;
  await expect(measureLocalCurrentFilmProofFile(f.root,f.key,async()=>{
    if(++checks===2){renameSync(f.path,moved);writeFileSync(f.path,f.body);}
  },new AbortController().signal,f.file)).rejects.toThrow("recorded identity");
  expect(lstatSync(f.path).ino).not.toBe(lstatSync(moved).ino);
  expect(readFileSync(f.path).equals(f.body)).toBe(true);expect(readFileSync(moved).equals(f.body)).toBe(true);
});

test("local proof measurement rejects growth beyond its original opened size",async()=>{
  const f=fixture(17);let checks=0;
  await expect(measureLocalCurrentFilmProofFile(f.root,f.key,async()=>{
    if(++checks===2)appendFileSync(f.path,Buffer.from([8]));
  },new AbortController().signal,f.file)).rejects.toThrow("recorded identity");
  expect(lstatSync(f.path).size).toBe(18);
});

test("local proof measurement rejects linked parents and wrong recorded sizes before reading bytes",async()=>{
  const f=fixture(17);let checks=0;
  await expect(measureLocalCurrentFilmProofFile(f.root,f.key,async()=>{checks++;},new AbortController().signal,{...f.file,bytes:18})).rejects.toThrow("recorded size");
  expect(checks).toBe(1);
  const redirected=join(f.root,"project","redirected");symlinkSync(dirname(f.path),redirected,"junction");
  await expect(measureLocalCurrentFilmProofFile(f.root,"project/redirected/media.bin",async()=>{},new AbortController().signal)).rejects.toThrow("linked paths");
  expect(readFileSync(f.path).equals(f.body)).toBe(true);
});

test("local proof measurement observes abort before the next bounded read",async()=>{
  const f=fixture(),controller=new AbortController();let checks=0;
  await expect(measureLocalCurrentFilmProofFile(f.root,f.key,async()=>{
    if(++checks===3)controller.abort(new Error("stop reading proof"));
  },controller.signal,f.file)).rejects.toThrow();
  expect(checks).toBe(3);expect(readFileSync(f.path).equals(f.body)).toBe(true);
});

test("local proof size preflight refuses oversized unmeasured roles before opening or reading them",async()=>{
  const f=fixture(17),original=fs.lstatSync;let opens=0;
  // Real small regular file; only its reported size crosses the boundary. This
  // qualifies early refusal, not a large file allocation or media verification.
  const size=spyOn(fs,"lstatSync").mockImplementation(((path:fs.PathLike,options?:unknown)=>{
    const value=Reflect.apply(original,fs,[path,options]);if(String(path)===f.path)Object.defineProperty(value,"size",{value:8*1024**3+1});return value;
  }) as typeof fs.lstatSync),opened=spyOn(fsPromises,"open").mockImplementation(async()=>{opens++;throw new Error("must not open oversized unmeasured media");});
  try{
    for(const expected of [undefined,{...f.file,bytes:8*1024**3+1}])
      await expect(measureLocalCurrentFilmProofFile(f.root,f.key,async()=>{},new AbortController().signal,expected)).rejects.toThrow("bounded size");
    expect(opens).toBe(0);
  }finally{opened.mockRestore();size.mockRestore();}
  expect(readFileSync(f.path).equals(f.body)).toBe(true);
});

test("only an explicit exact measured current-film MP4 reaches the larger local measurement boundary",async()=>{
  const f=fixture(17),key="project/original/output.mp4",path=join(f.root,key);renameSync(f.path,path);
  const original=fs.lstatSync;let reported=8*1024**3+1,opens=0;
  const picture={...f.file,path:key,bytes:reported};
  const size=spyOn(fs,"lstatSync").mockImplementation(((name:fs.PathLike,options?:unknown)=>{
    const value=Reflect.apply(original,fs,[name,options]);if(String(name)===path)Object.defineProperty(value,"size",{value:reported});return value;
  }) as typeof fs.lstatSync),opened=spyOn(fsPromises,"open").mockImplementation(async()=>{opens++;throw new Error("reached exact measured picture open boundary");});
  try{
    await expect(measureLocalCurrentFilmProofFile(f.root,key,async()=>{},new AbortController().signal,picture)).rejects.toThrow("bounded size");expect(opens).toBe(0);
    await expect(measureLocalCurrentFilmProofFile(f.root,key,async()=>{},new AbortController().signal,picture,picture)).rejects.toThrow("picture open boundary");expect(opens).toBe(1);
    for(const claimed of [{...picture,sha256:"f".repeat(64)},{...picture,path:f.key},{...picture,bytes:128*1024**3+1}])
      await expect(measureLocalCurrentFilmProofFile(f.root,key,async()=>{},new AbortController().signal,picture,claimed)).rejects.toThrow("exact measured");
    reported=128*1024**3+1;const tooLarge={...picture,bytes:reported};
    await expect(measureLocalCurrentFilmProofFile(f.root,key,async()=>{},new AbortController().signal,tooLarge,tooLarge)).rejects.toThrow("exact measured");expect(opens).toBe(1);
  }finally{opened.mockRestore();size.mockRestore();}
  expect(readFileSync(path).equals(f.body)).toBe(true);
});
