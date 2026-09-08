import type {PersistedState} from "../../api/src/index";
import type {Job} from "../../queue/src/index";
import {validateProjectCurrentScreenplay} from "../../planner/src/current-screenplay-library";

function walk(input:unknown,visit:(value:object,key:string,valueAtKey:unknown)=>void):void {
  const active=new Set<object>();let nodes=0,bytes=0;
  const step=(value:unknown,depth:number):void=>{
    if(++nodes>5000000||depth>220)throw new Error("Current screenplay recovery exceeds its traversal capacity.");
    if(!value||typeof value!=="object")return;
    if(active.has(value))throw new Error("Current screenplay recovery cannot contain cycles.");active.add(value);
    for(const key of Reflect.ownKeys(value)){
      const field=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!Object.hasOwn(field,"value"))throw new Error("Current screenplay recovery cannot contain hidden keys or accessors.");
      bytes+=Buffer.byteLength(key,"utf8");if(typeof field.value==="string")bytes+=Buffer.byteLength(field.value,"utf8");
      if(bytes>512*1024**2)throw new Error("Current screenplay recovery exceeds its byte capacity.");
      visit(value,key,field.value);step(field.value,depth+1);
    }active.delete(value);
  };step(input,0);
}
function marker(key:string,value:unknown):boolean {
  return ["currentScreenplay","currentFilm","currentFilmReview"].includes(key)&&value!==undefined
    ||key==="schema"&&typeof value==="string"&&(value.startsWith("hv-current-screenplay-")||value.startsWith("hv-current-film-"));
}
/** Includes abandoned branches and retained originals; a nested marker cannot downgrade. */
export function snapshotUsesCurrentScreenplay(projects:PersistedState,jobs:Job[]):boolean {
  let found=false;walk({projects,jobs},(_object,key,value)=>{if(marker(key,value))found=true;});return found;
}
export function validateCurrentScreenplayRecovery(projects:PersistedState,jobs:Job[]):void {
  const libraries=new Set<object>(),projectOwners=new Set<object>();
  for(const project of projects.projects)if(project.currentScreenplay!==undefined){
    validateProjectCurrentScreenplay(project.currentScreenplay,{projectId:project.id,versions:project.versions});projectOwners.add(project);
    walk(project.currentScreenplay,(object,key,value)=>{if(key==="schema"&&marker(key,value))libraries.add(object);});
  }
  walk({projects,jobs},(object,key,value)=>{
    if(!marker(key,value))return;
    if(key==="currentScreenplay"&&projectOwners.has(object))return;
    if(key==="schema"&&libraries.has(object)&&typeof value==="string"&&value.startsWith("hv-current-screenplay-"))return;
    // Job/output adapters must be implemented explicitly before these can be restored.
    throw new Error("Current screenplay recovery contains an unowned or unsupported runtime marker.");
  });
}
