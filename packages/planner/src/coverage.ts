import {contentHash} from "../../generator/src/capabilities";
import type {DirectionSnapshot} from "./direction";
import type {Shot} from "./index";

export const COVERAGE_CHOICES={role:["unspecified","master","single","over-shoulder","two-shot","insert","reaction","establishing","cutaway"],cameraSide:["unspecified","a","b","on-axis"],gazeDirection:["unspecified","left","right","center"]} as const;
export interface ShotCoverage {role:typeof COVERAGE_CHOICES.role[number];subjects:string[];axis:string;cameraSide:typeof COVERAGE_CHOICES.cameraSide[number];gazeSubject:string;gazeTarget:string;gazeDirection:typeof COVERAGE_CHOICES.gazeDirection[number];reestablish:boolean;continuityNote:string}
export const DEFAULT_COVERAGE:ShotCoverage={role:"unspecified",subjects:[],axis:"",cameraSide:"unspecified",gazeSubject:"",gazeTarget:"",gazeDirection:"unspecified",reestablish:false,continuityNote:""};
const key=(value:string)=>value.trim().replace(/\s+/g," ").toLocaleUpperCase("en-US");
function text(value:unknown,max:number,label:string):string {if(typeof value!=="string"||value.length>max||[...value].some(char=>char.charCodeAt(0)<32&&![9,10,13].includes(char.charCodeAt(0))))throw new Error(label+" must be text of at most "+max+" characters.");return value.trim();}
export function coverageSettings(input:unknown):ShotCoverage {
  if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(name=>!Object.hasOwn(DEFAULT_COVERAGE,name)))throw new Error("Use supported coverage fields.");
  const value={...DEFAULT_COVERAGE,...input} as ShotCoverage;
  for(const [name,choices]of Object.entries(COVERAGE_CHOICES))if(!(choices as readonly unknown[]).includes(value[name as keyof ShotCoverage]))throw new Error("Choose a valid coverage "+name+".");
  for(const name of ["axis","gazeSubject","gazeTarget"] as const)value[name]=text(value[name],80,name);
  value.continuityNote=text(value.continuityNote,400,"Continuity note");
  if(!Array.isArray(value.subjects)||value.subjects.length>8)throw new Error("List up to eight subjects in this shot.");
  value.subjects=value.subjects.map(subject=>text(subject,80,"Subject"));
  if(value.subjects.some(subject=>!subject)||new Set(value.subjects.map(key)).size!==value.subjects.length)throw new Error("Use nonempty, distinct shot subjects.");
  if(typeof value.reestablish!=="boolean"||value.reestablish&&(!value.axis||!value.continuityNote))throw new Error("Name the axis and explain how this shot reestablishes it or deliberately crosses it.");
  if(value.cameraSide!=="unspecified"&&!value.axis)throw new Error("Name the axis before choosing a camera side.");
  if(value.gazeDirection!=="unspecified"&&(!value.gazeSubject||!value.gazeTarget))throw new Error("Name the looking subject and target before choosing an eyeline.");
  if(value.gazeSubject&&value.gazeTarget&&key(value.gazeSubject)===key(value.gazeTarget))throw new Error("The looking subject and target must differ.");
  if(value.gazeSubject&&!value.subjects.some(subject=>key(subject)===key(value.gazeSubject)))throw new Error("Include the looking subject in the shot subject list.");
  return value;
}
export function coveragePrompt(value:ShotCoverage):string {
  return [value.role!=="unspecified"?"Coverage role: "+value.role.replaceAll("-"," "):"",value.subjects.length?"Shot subjects: "+value.subjects.join(", "):"",
    value.axis?"Continuity axis: "+value.axis:"",value.cameraSide!=="unspecified"?"Declared camera side: "+value.cameraSide:"",
    value.gazeSubject&&value.gazeTarget?"Eyeline: "+value.gazeSubject+" looks toward "+value.gazeTarget+(value.gazeDirection!=="unspecified"?", screen "+value.gazeDirection:""):"",
    value.reestablish?"Intentional axis change or reestablishment: "+value.continuityNote:value.continuityNote?"Continuity note: "+value.continuityNote:""].filter(Boolean).join("\n");
}
export interface CoverageFinding {code:string;severity:"warning"|"unknown"|"note";shotIds:string[];message:string}
export interface CoverageScene {sceneIndex:number;shotIds:string[];speakers:string[];inventory:Record<ShotCoverage["role"],string[]>;findings:CoverageFinding[];axisComparisons:number;eyelineComparisons:number}
export interface CoverageReport {schema:"hv-coverage/1";rulesVersion:1;directionRevision:string;sourcePlanHash:string;staleShotIds:string[];scenes:CoverageScene[];totals:{warnings:number;unknowns:number;notes:number;axisComparisons:number;eyelineComparisons:number}}
/** Checks declared planning metadata only. No image analysis or inferred camera geometry. */
export function coverageReport(shots:Shot[],snapshot:DirectionSnapshot):CoverageReport {
  const sources=shots.map(shot=>({id:shot.id,sceneIndex:shot.sceneIndex,prompt:shot.sourcePrompt??shot.prompt,dialogue:shot.dialogue}));
  const hashes=new Map(sources.map(source=>[source.id,contentHash(source)]));
  const stale=snapshot.entries.filter(entry=>hashes.get(entry.source.id)!==entry.sourceHash),staleIds=new Set(stale.map(entry=>entry.source.id));
  const settings=new Map(snapshot.entries.filter(entry=>!staleIds.has(entry.source.id)&&entry.settings.coverage).map(entry=>[entry.source.id,entry.settings.coverage!]));
  const groups=new Map<number,Shot[]>();for(const shot of shots){if(!groups.has(shot.sceneIndex))groups.set(shot.sceneIndex,[]);groups.get(shot.sceneIndex)!.push(shot);}
  // Keep removed-shot findings attached to their original scene, even if that scene vanished.
  for(const entry of stale)if(!groups.has(entry.source.sceneIndex))groups.set(entry.source.sceneIndex,[]);
  const scenes:CoverageScene[]=[];
  for(const [sceneIndex,sceneShots]of groups){
    const inventory=Object.fromEntries(COVERAGE_CHOICES.role.map(role=>[role,[]])) as unknown as CoverageScene["inventory"],findings:CoverageFinding[]=[];
    const add=(code:string,severity:CoverageFinding["severity"],ids:string[],message:string)=>findings.push({code,severity,shotIds:ids,message});
    const speakers=[...new Map(sceneShots.flatMap(shot=>shot.dialogue.map(d=>[key(d.character),d.character] as const))).values()];
    for(const shot of sceneShots)inventory[settings.get(shot.id)?.role??"unspecified"].push(shot.id);
    for(const entry of stale.filter(value=>value.source.sceneIndex===sceneIndex))add("source-stale","unknown",[entry.source.id],"Saved coverage has a changed or missing source. Review or remove this shot direction before rendering.");
    if(inventory.unspecified.length)add("coverage-unknown","unknown",inventory.unspecified,"Coverage roles are unclassified. Assign roles to assess the declared shot plan.");
    if(sceneShots.length&&!inventory.master.length)add("master-missing",inventory.unspecified.length?"unknown":"warning",sceneShots.map(shot=>shot.id),"No master shot is declared. Consider a master covering the scene action, or retain an intentional alternative.");
    for(const speaker of speakers){const covered=sceneShots.some(shot=>{const c=settings.get(shot.id);return c&&["single","over-shoulder"].includes(c.role)&&c.subjects.some(subject=>key(subject)===key(speaker));});
      if(!covered)add("speaker-coverage-missing",inventory.unspecified.length?"unknown":"warning",sceneShots.filter(shot=>shot.dialogue.some(d=>key(d.character)===key(speaker))).map(shot=>shot.id),"No single or over-shoulder coverage is declared for "+speaker+". Review whether this scene needs it.");}
    if(speakers.length>1&&!inventory.reaction.length&&!inventory.cutaway.length)add("edit-options","note",sceneShots.map(shot=>shot.id),"No reaction or cutaway is declared. Consider an alternate view for dialogue edit points; not every scene needs one.");
    let axisComparisons=0,eyelineComparisons=0;
    const axes=new Map<string,{id:string;side:"a"|"b"}>(),gazes=new Map<string,{id:string;value:ShotCoverage}>();
    const unknownAxes:string[]=[],unknownGazes:string[]=[];
    for(const shot of sceneShots){const c=settings.get(shot.id);if(!c)continue;
      if(!c.axis||c.cameraSide==="unspecified")unknownAxes.push(shot.id);
      if(c.subjects.length&&(!["left","right"].includes(c.gazeDirection)||!c.axis||!["a","b"].includes(c.cameraSide)))unknownGazes.push(shot.id);
      const axis=key(c.axis);
      if(c.reestablish){axes.delete(axis);for(const [id,gaze]of gazes)if(key(gaze.value.axis)===axis)gazes.delete(id);add("axis-intent","note",[shot.id],"Declared axis change/reestablishment: "+c.continuityNote+" Verify it in the preview.");}
      if(axis&&(c.cameraSide==="a"||c.cameraSide==="b")){const previous=axes.get(axis);if(previous){axisComparisons++;if(previous.side!==c.cameraSide)add("axis-crossing","warning",[previous.id,shot.id],"Camera sides differ across the declared axis “"+c.axis+"”. Review the 180-degree transition or explain an intentional reestablishment.");}axes.set(axis,{id:shot.id,side:c.cameraSide});}
      if(axis&&["a","b"].includes(c.cameraSide)&&["left","right"].includes(c.gazeDirection)&&c.gazeSubject&&c.gazeTarget){
        const reciprocal=gazes.get(JSON.stringify([axis,c.cameraSide,key(c.gazeTarget),key(c.gazeSubject)]));
        if(reciprocal){eyelineComparisons++;if(reciprocal.value.gazeDirection===c.gazeDirection)add("eyeline-conflict","warning",[reciprocal.id,shot.id],"Reciprocal eyelines both look screen "+c.gazeDirection+" on the same declared camera side. Review their screen positions and looking directions.");}
        gazes.set(JSON.stringify([axis,c.cameraSide,key(c.gazeSubject),key(c.gazeTarget)]),{id:shot.id,value:c});
      }
    }
    if(unknownAxes.length)add("axis-unknown","unknown",unknownAxes,"Axis or camera side is unspecified. These shots cannot establish a checked 180-degree relationship.");
    if(unknownGazes.length)add("eyeline-unknown","unknown",unknownGazes,"These eyelines are incomplete or centered/on-axis. Reciprocal horizontal looks require subject, target, left/right direction, axis and camera side A/B.");
    const priority={warning:0,unknown:1,note:2};findings.sort((a,b)=>priority[a.severity]-priority[b.severity]);
    scenes.push({sceneIndex,shotIds:sceneShots.map(shot=>shot.id),speakers,inventory,findings,axisComparisons,eyelineComparisons});
  }
  scenes.sort((a,b)=>a.sceneIndex-b.sceneIndex);const findings=scenes.flatMap(scene=>scene.findings);
  return {schema:"hv-coverage/1",rulesVersion:1,directionRevision:snapshot.revision,sourcePlanHash:contentHash(sources),staleShotIds:[...staleIds],scenes,
    totals:{warnings:findings.filter(f=>f.severity==="warning").length,unknowns:findings.filter(f=>f.severity==="unknown").length,notes:findings.filter(f=>f.severity==="note").length,
      axisComparisons:scenes.reduce((sum,s)=>sum+s.axisComparisons,0),eyelineComparisons:scenes.reduce((sum,s)=>sum+s.eyelineComparisons,0)}};
}
