import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readStateSnapshot,stateSnapshotSchema,validateSnapshot,writeStateSnapshot,type StateSnapshot} from "../src/snapshots";

const empty=():StateSnapshot=>({schema:"hv-state/1",projects:{version:1,projects:[],reviewLinks:[],takenDown:[],takedownLog:[]},jobs:[],ledger:{events:[],reservations:[]},reviews:[]});
test("schema fourteen selects every nested mixed-runtime marker before retained V2 sources",()=>{
  for(const marker of [{currentFilmOrigins:undefined},{currentFilmOrigins:null},...[
    "hv-current-film-job/3","hv-current-film-checkpoint/3","hv-current-film-output/3","hv-current-film-clock/3","hv-current-film-preview-review/3",
    "hv-current-film-origins/1","hv-current-film-adoption/1","hv-current-film-assembly-inputs/3","hv-current-film-reuse-review/1"].map(schema=>({schema}))]){
    const state=empty();Object.assign(state.projects,{abandoned:{original:{schema:"hv-edit-source/3"},branch:[marker]}});
    expect(stateSnapshotSchema(state.projects,state.jobs)).toBe("hv-state/14");
    for(let version=1;version<14;version++)expect(()=>validateSnapshot({...state,schema:("hv-state/"+version) as StateSnapshot["schema"]})).toThrow("schema 14");
    // Promoting the version never grants an orphan marker owning-job authority.
    expect(()=>validateSnapshot({...state,schema:"hv-state/14"})).toThrow();
  }
});

test("schema detection rejects accessors before evaluating untrusted marker payloads",()=>{
  const state=empty();let reads=0;Object.defineProperty(state.projects,"untrusted",{enumerable:true,get(){reads++;return {currentFilmOrigins:{}};}});
  expect(()=>stateSnapshotSchema(state.projects,state.jobs)).toThrow("accessors");expect(reads).toBe(0);
  expect(()=>validateSnapshot(state)).toThrow("accessors");expect(reads).toBe(0);
});

test("legacy empty state stays byte-identical while explicit schema fourteen manifests round trip",()=>{
  const legacy=empty(),bytes=JSON.stringify(legacy);expect(stateSnapshotSchema(legacy.projects,legacy.jobs)).toBe("hv-state/1");
  expect(validateSnapshot(legacy)).toBe(legacy);expect(JSON.stringify(legacy)).toBe(bytes);
  const root=mkdtempSync(join(tmpdir(),"hv-mixed-schema-"));
  try{
    for(const schema of ["hv-state/1","hv-state/12","hv-state/13","hv-state/14"] as const){
      const state={...empty(),schema},directory=join(root,schema.replace("/","-"));writeStateSnapshot(directory,state);
      expect(JSON.parse(readFileSync(join(directory,"snapshot.json"),"utf8")).schema).toBe(schema);expect(readStateSnapshot(directory)).toEqual(state);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
