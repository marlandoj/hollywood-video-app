import {expect,test} from "bun:test";
import {contentHash as hash} from "../../generator/src/capabilities";
import {emptyEditLibrary} from "../../planner/src/edit-library";
import {snapshotUsesCurrentFilmMixedSources,validateCurrentScreenplayRecovery} from "../src/current-screenplay-snapshots";
import {stateSnapshotSchema,validateSnapshot,type StateSnapshot} from "../src/snapshots";

function fixture():StateSnapshot {
  const at="2026-01-01T00:00:00.000Z";
  return {schema:"hv-state/16",projects:{version:1,projects:[{id:"state16",createdAt:at,deleteAfter:"2026-01-02T00:00:00.000Z",
    operatorExtensions:[],rightsAttestedAt:null,animaticApprovals:[],versions:[]}],reviewLinks:[],takenDown:[],takedownLog:[]},
    jobs:[],ledger:{events:[],reservations:[]},reviews:[]};
}

test("sticky empty library2 selects schema16 while absent and legacy defaults keep their old schema",()=>{
  const value=fixture(),project=value.projects.projects[0]!;
  expect(stateSnapshotSchema(value.projects,value.jobs)).toBe("hv-state/1");
  project.editLibrary=emptyEditLibrary();expect(stateSnapshotSchema(value.projects,value.jobs)).toBe("hv-state/4");
  const body={schema:"hv-edit-library/2" as const,version:1,sources:[],sequences:[]};project.editLibrary={...body,revision:hash(body)};
  const before=JSON.stringify(value);
  expect(snapshotUsesCurrentFilmMixedSources(value.projects,value.jobs)).toBe(true);
  expect(stateSnapshotSchema(value.projects,value.jobs)).toBe("hv-state/16");expect(validateSnapshot(value)).toBe(value);
  expect(JSON.stringify(value)).toBe(before);
  for(let version=1;version<=15;version++)expect(()=>validateSnapshot({...value,schema:`hv-state/${version}` as StateSnapshot["schema"]})).toThrow("schema 16");
});

test("abandoned receipt4 and library2 markers require16 but have no ownership",()=>{
  for(const schema of ["hv-edit-source/4","hv-edit-library/2"]){
    const value=fixture();Object.assign(value.projects.projects[0]!,{abandoned:{schema}});
    expect(stateSnapshotSchema(value.projects,value.jobs)).toBe("hv-state/16");
    expect(()=>validateSnapshot({...value,schema:"hv-state/15"})).toThrow("schema 16");
    expect(()=>validateSnapshot(value)).toThrow("unowned");
  }
});

test("schema16 detection and ownership refuse hidden/accessor markers without invoking getters",()=>{
  let reads=0;const value=fixture();Object.defineProperty(value.projects.projects[0],"abandoned",{enumerable:true,get(){reads++;return {schema:"hv-edit-source/4"};}});
  expect(()=>snapshotUsesCurrentFilmMixedSources(value.projects,value.jobs)).toThrow("accessors");
  expect(()=>validateCurrentScreenplayRecovery(value.projects,value.jobs)).toThrow("accessors");expect(reads).toBe(0);
  const hidden=fixture();Object.defineProperty(hidden.projects.projects[0],"abandoned",{value:{schema:"hv-edit-library/2"},enumerable:false});
  expect(()=>snapshotUsesCurrentFilmMixedSources(hidden.projects,hidden.jobs)).toThrow("hidden");
});
