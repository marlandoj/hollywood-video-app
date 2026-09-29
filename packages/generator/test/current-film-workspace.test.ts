import {afterEach,expect,spyOn,test} from "bun:test";
import {lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {currentFilmWorkspaceGuard} from "../src/current-film-workspace";
import {EDIT_STORAGE_LIMITS} from "../../planner/src/edit-resources";

const roots:string[]=[];
function fixture(){const root=mkdtempSync(join(tmpdir(),"hv-mixed-workspace-"));roots.push(root);return {root,owner:join(root,"project","job")};}
afterEach(()=>{for(const root of roots.splice(0)){
  const path=realpathSync(root);if(!path.startsWith(realpathSync(tmpdir())+sep)||lstatSync(root).isSymbolicLink())throw new Error("Unsafe workspace fixture cleanup.");
  rmSync(path,{recursive:true,force:true});
}});

test("whole-job checks include generated attempts, delivery and crash remnants at the final boundary",()=>{
  const {root,owner}=fixture(),guard=currentFilmWorkspaceGuard(root,"project","job",{bytes:12,files:4});guard.check(true);
  for(const name of ["clips","hls",".mixed-copy/attempt-old"])mkdirSync(join(owner,name),{recursive:true});
  writeFileSync(join(owner,"clips","shot-a1.mp4"),"clip");writeFileSync(join(owner,"hls","segment-000.ts"),"hls!");writeFileSync(join(owner,".mixed-copy/attempt-old","partial.copy"),"part");
  const sibling=join(root,"project","other-job");mkdirSync(sibling);writeFileSync(join(sibling,"unrelated.bin"),Buffer.alloc(100));
  const clock=spyOn(Date,"now").mockReturnValue(10000);
  try{guard.check();expect(()=>guard.check(true)).not.toThrow();writeFileSync(join(owner,"extra.bin"),"x");
    expect(()=>guard.check(true)).toThrow("workspace capacity");expect(readFileSync(join(owner,".mixed-copy/attempt-old","partial.copy"),"utf8")).toBe("part");
  }finally{clock.mockRestore();}
});

test("workspace file count includes empty generated and stale files",()=>{
  const {root,owner}=fixture();mkdirSync(owner,{recursive:true});const guard=currentFilmWorkspaceGuard(root,"project","job",{bytes:100,files:2});
  writeFileSync(join(owner,"first"),"");writeFileSync(join(owner,"second"),"");expect(()=>guard.check(true)).not.toThrow();
  writeFileSync(join(owner,"third"),"");expect(()=>guard.check(true)).toThrow("workspace capacity");
});

test("empty abandoned directories count toward bounded traversal work",()=>{
  const {root,owner}=fixture();mkdirSync(owner,{recursive:true});const guard=currentFilmWorkspaceGuard(root,"project","job",{bytes:100,files:2});
  for(let i=0;i<8;i++)mkdirSync(join(owner,`abandoned-${i}`));expect(()=>guard.check(true)).not.toThrow();
  mkdirSync(join(owner,"one-more"));expect(()=>guard.check(true)).toThrow("directory-entry bound");
});

test("linked owner components fail even when the link stays within the artifact root",()=>{
  const {root}=fixture(),other=join(root,"other");mkdirSync(join(other,"job"),{recursive:true});
  symlinkSync(other,join(root,"project"),process.platform==="win32"?"junction":"dir");
  expect(()=>currentFilmWorkspaceGuard(root,"project","job").check()).toThrow("ownership");
});

test("internal tighter budgets cannot enlarge existing limits or read hidden policy getters",()=>{
  const {root}=fixture();
  for(const limits of [{bytes:EDIT_STORAGE_LIMITS.workspaceBytes+1,files:1},{bytes:1,files:EDIT_STORAGE_LIMITS.files*3+1},{bytes:0,files:1},{bytes:1,files:0}])
    expect(()=>currentFilmWorkspaceGuard(root,"project","job",limits)).toThrow("bounded");
  let reads=0;const limits={bytes:1,files:1};Object.defineProperty(limits,"bytes",{enumerable:true,get(){reads++;return 1;}});
  expect(()=>currentFilmWorkspaceGuard(root,"project","job",limits)).toThrow("bounded");expect(reads).toBe(0);
});

test("pending exact copies include existing job bytes and bypass throttling without persisting a reservation",()=>{
  const {root,owner}=fixture();mkdirSync(owner,{recursive:true});writeFileSync(join(owner,"existing"),"12345678");
  const guard=currentFilmWorkspaceGuard(root,"project","job",{bytes:12,files:3}),clock=spyOn(Date,"now").mockReturnValue(10000);
  try{
    guard.check();expect(()=>guard.check(false,{bytes:4,files:2})).not.toThrow();
    expect(()=>guard.check(false,{bytes:5,files:1})).toThrow("workspace capacity");
    expect(()=>guard.check(false,{bytes:1,files:3})).toThrow("workspace capacity");
    expect(()=>guard.check(true)).not.toThrow();
    let reads=0;const hostile={bytes:1,files:1};Object.defineProperty(hostile,"bytes",{enumerable:true,get(){reads++;return 1;}});
    expect(()=>guard.check(false,hostile)).toThrow("bounded");expect(reads).toBe(0);
    expect(readFileSync(join(owner,"existing"),"utf8")).toBe("12345678");
  }finally{clock.mockRestore();}
});
