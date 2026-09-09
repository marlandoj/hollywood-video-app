// Registered by an existing genuine two-source suite; no additional native setup.
import {expect,spyOn,test} from "bun:test";
import * as fs from "node:fs";
import {join,resolve,sep} from "node:path";
import {ProjectService,type PersistedState} from "../src/index";
import {contentHash as hash} from "../../generator/src/capabilities";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {emptyEditLibrary,type EditLibrary} from "../../planner/src/edit-library";
import type {EditSourceReceipt} from "../../planner/src/edit-sources";

interface PublicationFixture {
  root:string;token:string;projectId:string;state:PersistedState;
  // Exact inspected originals from the same actual fixture; distinct job IDs.
  sources:readonly [EditSourceReceipt,EditSourceReceipt];
}
type Operation="create"|"admit"|"change";
function withoutEditorial(input:PersistedState):PersistedState {
  const state=structuredClone(input);for(const project of state.projects)delete project.editLibrary;return state;
}
function prepare(fixture:PublicationFixture,operation:Operation){
  const root=fs.realpathSync(fixture.root),directory=fs.mkdtempSync(join(root,".editorial-publication-")),path=join(directory,"projects.json");
  const cleanup=()=>{
    const actual=resolve(directory);
    if(!actual.startsWith(root+sep+".editorial-publication-")||fs.lstatSync(actual).isSymbolicLink())throw new Error("Unsafe editorial publication fixture cleanup.");
    fs.rmSync(actual,{recursive:true,force:true});
  };
  try{
    const initial=structuredClone(fixture.state),project=initial.projects.find(value=>value.id===fixture.projectId);
    if(!project||project.editLibrary?.version||fixture.sources.some(source=>source.job.projectId!==project.id)||fixture.sources[0].job.id===fixture.sources[1].job.id)throw new Error("Supply an unchanged genuine project with an empty editorial library and two distinct inspected originals.");
    fs.writeFileSync(path,JSON.stringify(initial,null,2));const service=new ProjectService(path),now=Date.now(),first=fixture.sources[0],second=fixture.sources[1];
    const create=()=>service.createEditSequence(fixture.token,[first],"publication-sequence","Original retained sequence",first.facts.id,320,180,0,now,[bindOriginalEditSource(first)]);
    if(operation!=="create"&&!create())throw new Error("The fixture project is unavailable.");
    const previous=structuredClone(service.snapshot()),library=previous.projects.find(value=>value.id===project.id)!.editLibrary??emptyEditLibrary(),sequence=library.sequences[0];
    const publish=():EditLibrary|null=>operation==="create"?create():operation==="admit"
      ?service.admitEditSource(fixture.token,sequence!.id,bindOriginalEditSource(second),library.version,sequence!.history.revision,now)
      :service.changeEditSequence(fixture.token,sequence!.id,{kind:"rename",label:"Renamed retained sequence"},library.version,sequence!.history.revision,now);
    return {path,service,previous,library,publish,cleanup};
  }catch(error){cleanup();throw error;}
}

/** Call once at module definition time. getFixture() runs only inside the test,
 * after the host's existing authentic source setup has completed. */
export function registerEditorialPublicationTests(getFixture:()=>PublicationFixture):void {
  for(const operation of ["create","admit","change"] as const)test("editorial "+operation+" keeps live and disk state unchanged on failed rename, then retries with exactly one publication",()=>{
    const fixture=getFixture(),inputRevision=hash(fixture.sources),scenario=prepare(fixture,operation);
    const {path,service,previous,library,publish}=scenario,bytes=fs.readFileSync(path,"utf8"),rename=fs.renameSync;
    try{
      let attempts=0;
      const fault=spyOn(fs,"renameSync").mockImplementation((from,to)=>{
        if(String(to)===path){attempts++;throw new Error("Injected editorial publication rename failure");}
        return rename(from,to);
      });
      try{
        expect(()=>publish()).toThrow("Injected editorial publication rename failure");expect(attempts).toBe(1);
        // snapshot() does not reload. Check this before any authorize/reload can
        // conceal the old implementation's mutation-before-rename defect.
        expect(service.snapshot()).toEqual(previous);expect(fs.readFileSync(path,"utf8")).toBe(bytes);
        expect(hash(fixture.sources)).toBe(inputRevision);
      }finally{fault.mockRestore();}
      const publications:PersistedState[]=[];
      const commit=spyOn(fs,"renameSync").mockImplementation((from,to)=>{
        if(String(to)===path){
          expect(service.snapshot()).toEqual(previous);
          expect(fs.readFileSync(path,"utf8")).toBe(bytes);
          publications.push(JSON.parse(fs.readFileSync(from,"utf8")) as PersistedState);
        }
        return rename(from,to);
      });
      let result:EditLibrary|null=null;
      try{result=publish();}finally{commit.mockRestore();}
      expect(publications).toHaveLength(1);expect(result).not.toBeNull();
      const saved=publications[0]!,savedLibrary=saved.projects.find(value=>value.id===fixture.projectId)!.editLibrary!;
      expect(savedLibrary).toEqual(result!);expect(savedLibrary.version).toBe(library.version+1);
      expect(service.snapshot()).toEqual(saved);expect(JSON.parse(fs.readFileSync(path,"utf8"))).toEqual(saved);
      expect(new ProjectService(path).snapshot()).toEqual(saved);
      expect(withoutEditorial(saved)).toEqual(withoutEditorial(previous));expect(hash(fixture.sources)).toBe(inputRevision);
      if(operation==="admit"){
        expect(savedLibrary.sources.map(source=>source.revision)).toEqual(fixture.sources.map(source=>source.revision));
        expect(savedLibrary.sequences[0]!.history.events).toHaveLength(library.sequences[0]!.history.events.length+1);
      }else if(operation==="change")expect(savedLibrary.sequences[0]!.history).toEqual(library.sequences[0]!.history);
      result!.sequences[0]!.label="Caller mutation after publication";
      expect(service.snapshot()).toEqual(saved);expect(new ProjectService(path).snapshot()).toEqual(saved);
    }finally{scenario.cleanup();}
  },30000);
}
