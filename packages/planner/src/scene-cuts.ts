import {contentHash} from "../../generator/src/capabilities";
import type {ParseResult,Scene,SceneBeat} from "../../parser/src/index";
import {gateOrThrow} from "../../safety/src/index";
import {planShots,type Shot} from "./index";
import type {DirectionSnapshot} from "./direction";
import {coverageSettings,coveragePrompt,type ShotCoverage} from "./coverage";

export type CutBeat = Omit<Extract<SceneBeat,{kind:"dialogue"}>,"startLine"|"endLine"> | {id:string;kind:"action"|"transition";text:string};
export interface CutSource {sceneIndex:number;heading:string;beats:CutBeat[]}
export interface CutShot {id:string;beatIds:string[];afterBeatId:string|null;coverage:ShotCoverage;durationFrames:number|null;notes:string}
export interface SceneCut {schema:"hv-scene-cut/1";source:CutSource;sourceHash:string;shots:CutShot[];notes:string;revision:string}
export interface CutBinding {projectId:string;scriptVersion:number;castingRevision:string;directionRevision:string;maxShots:24|60}
export interface CutProposal {schema:"hv-cut-proposal/1";binding:CutBinding;sceneIndex:number;cut:SceneCut|null;revision:string}
export class SceneCutConflict extends Error {override name="SceneCutConflict";}
const hash=(v:unknown)=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
function exact(v:unknown,keys:string[]):asserts v is Record<string,unknown> {if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).sort().join(",")!==keys.sort().join(","))throw new Error("Use supported scene cut fields.");}
function text(v:unknown,max:number,label:string):string {if(typeof v!=="string"||v.length>max||[...v].some(c=>c.charCodeAt(0)<32&&![9,10,13].includes(c.charCodeAt(0))))throw new Error(label+" is too long or invalid.");return v.trim();}
export function cutSource(scene:Scene):CutSource {
  if(!scene.beats)throw new Error("Reparse this screenplay to obtain ordered coverage beats.");
  return {sceneIndex:scene.index,heading:scene.heading,beats:scene.beats.map(({startLine:_start,endLine:_end,...beat})=>structuredClone(beat))};
}
function validateSource(source:CutSource):void {
  exact(source,["sceneIndex","heading","beats"]);
  if(!Number.isInteger(source.sceneIndex)||source.sceneIndex<0||source.sceneIndex>999||!source.heading||text(source.heading,20000,"Scene heading")!==source.heading||!Array.isArray(source.beats)||source.beats.length>10000)throw new Error("Invalid ordered scene source.");
  for(const [i,beat]of source.beats.entries()){
    exact(beat,beat?.kind==="dialogue"?["id","kind","character","lines"]:["id","kind","text"]);
    if(beat.id!==`beat-${source.sceneIndex+1}-${i+1}`)throw new Error("Scene beat order changed.");
    if(beat.kind==="dialogue"){
      if(!beat.character||text(beat.character,1000,"Speaker")!==beat.character||!Array.isArray(beat.lines)||beat.lines.length>10000||beat.lines.some(line=>text(line,200000,"Dialogue")!==line))throw new Error("Invalid dialogue beat.");
    }else if(!["action","transition"].includes(beat.kind)||!beat.text||text(beat.text,200000,"Action")!==beat.text)throw new Error("Invalid action or transition beat.");
  }
}
export function sceneCut(source:CutSource,shots:CutShot[],notes=""):SceneCut {
  validateSource(source);notes=text(notes,1200,"Scene notes");
  if(!Array.isArray(shots)||shots.length<1||shots.length>60)throw new Error("Keep between 1 and 60 shots in a scene cut.");
  const narrative=source.beats.filter(b=>b.kind!=="transition"),ids=new Set<string>(),delivered:string[]=[];
  const normalized=shots.map(shot=>{
    exact(shot,["id","beatIds","afterBeatId","coverage","durationFrames","notes"]);
    if(typeof shot.id!=="string"||!new RegExp(`^shot-${source.sceneIndex+1}-[1-9][0-9]{4}$`).test(shot.id)||Number(shot.id.split("-")[2])<10001||ids.has(shot.id))throw new Error("Use distinct coverage shot IDs from 10001 to 99999 within this scene.");
    ids.add(shot.id);
    if(!Array.isArray(shot.beatIds)||shot.beatIds.length>10000||shot.beatIds.some(id=>typeof id!=="string"||!narrative.some(b=>b.id===id)))throw new Error("Choose source beats from this scene.");
    const coverage=coverageSettings(shot.coverage);
    if(shot.beatIds.length){if(shot.afterBeatId!==null)throw new Error("A narrative shot must contain its own ordered beats.");delivered.push(...shot.beatIds);}
    else if(!["reaction","cutaway","establishing","master","insert"].includes(coverage.role)||shot.afterBeatId!==(delivered.at(-1)??null))throw new Error("Place a silent alternate view immediately after its referenced beat, or before the opening beat.");
    if(shot.durationFrames!==null&&(!Number.isInteger(shot.durationFrames)||shot.durationFrames<30||shot.durationFrames>900))throw new Error("Choose 30 to 900 frames, or automatic duration.");
    const note=text(shot.notes,1200,"Shot notes");gateOrThrow(note+"\n"+coveragePrompt(coverage));
    return {...shot,coverage,notes:note};
  });
  if(JSON.stringify(delivered)!==JSON.stringify(narrative.map(b=>b.id)))throw new Error("Cover every action and dialogue beat exactly once in screenplay order. Use a silent alternate view for reactions.");
  gateOrThrow(notes);
  const data={source:structuredClone(source),sourceHash:contentHash(source),shots:normalized,notes};return {schema:"hv-scene-cut/1",...data,revision:contentHash(data)};
}
export function validateSceneCut(value:SceneCut):SceneCut {
  exact(value,["schema","source","sourceHash","shots","notes","revision"]);
  const checked=sceneCut(value.source,value.shots,value.notes);
  if(value.schema!==checked.schema||value.sourceHash!==checked.sourceHash||value.revision!==checked.revision||contentHash(value)!==contentHash(checked))throw new Error("The saved scene cut changed.");return checked;
}
export function validateSceneCuts(values:SceneCut[]):SceneCut[] {
  if(!Array.isArray(values)||values.length>60)throw new Error("Keep up to 60 accepted scene cuts.");
  const cuts=values.map(validateSceneCut).sort((a,b)=>a.source.sceneIndex-b.source.sceneIndex);
  if(new Set(cuts.map(c=>c.source.sceneIndex)).size!==cuts.length)throw new Error("Use one accepted cut per scene.");return cuts;
}
export function staleSceneCuts(parsed:ParseResult,direction?:DirectionSnapshot):SceneCut[] {
  return (direction?.sceneCuts??[]).filter(cut=>{const scene=parsed.scenes.find(s=>s.index===cut.source.sceneIndex);return !scene||contentHash(cutSource(scene))!==cut.sourceHash;});
}
/** The only source-plan compiler used by film jobs and source-bound editors. */
export function sourcePlan(parsed:ParseResult,direction?:DirectionSnapshot,baseSeed=7000,maxShots=24,review=false):Shot[] {
  const cuts=validateSceneCuts(direction?.sceneCuts??[]),stale=staleSceneCuts(parsed,direction);
  if(stale.length&&!review)throw new SceneCutConflict("Scene "+(stale[0]!.source.sceneIndex+1)+" changed. Review, replace or remove its accepted coverage before rendering.");
  const active=new Map(cuts.filter(c=>!stale.some(s=>s.revision===c.revision)).map(c=>[c.source.sceneIndex,c]));
  const base=planShots(parsed,baseSeed,maxShots),result:Shot[]=[];
  for(const scene of parsed.scenes){const cut=active.get(scene.index);if(!cut){result.push(...base.filter(s=>s.sceneIndex===scene.index));continue;}
    for(const shot of cut.shots){
      const beats=shot.beatIds.map(id=>cut.source.beats.find(b=>b.id===id)!);
      const dialogue=beats.flatMap(b=>b.kind==="dialogue"?[{character:b.character,lines:structuredClone(b.lines)}]:[]);
      const prior=shot.afterBeatId?cut.source.beats.find(b=>b.id===shot.afterBeatId):null;
      const describe=(b:CutBeat)=>b.kind==="dialogue"?b.character+": "+b.lines.join(" "):b.text;
      const content=beats.length?beats.map(describe).join("\n"):"Silent alternate view"+(prior?" after: "+describe(prior):" before the opening action")+". Do not repeat dialogue or action.";
      const prompt=[scene.heading,content,"Proposed coverage (creative intent):",coveragePrompt(shot.coverage),cut.notes?"Scene direction: "+cut.notes:"",shot.notes?"Shot direction: "+shot.notes:""].filter(Boolean).join("\n");
      if(prompt.length>30000)throw new Error("This coverage shot is too long. Split its beats or shorten the notes.");
      result.push({id:shot.id,sceneIndex:scene.index,prompt,dialogue,durationSec:(shot.durationFrames??60)/30,
        seed:parseInt(contentHash({baseSeed,id:shot.id}).slice(0,8),16)%2147483648,coverageIntent:structuredClone(shot.coverage),cutDurationFrames:shot.durationFrames});
    }
  }
  if(result.length>maxShots&&!review)throw new SceneCutConflict(`This cut needs ${result.length} shots; the selected tier permits ${maxShots}. Edit the coverage or choose a larger tier.`);
  return result;
}
export function proposeSceneCut(scene:Scene,includeReactions=false):SceneCut {
  const source=cutSource(scene),speakers=[...new Set(scene.dialogue.map(d=>d.character))].slice(0,8),shots:CutShot[]=[];
  const add=(beatIds:string[],role:ShotCoverage["role"],subjects:string[],afterBeatId:string|null=null)=>shots.push({id:`shot-${scene.index+1}-${10001+shots.length}`,beatIds,afterBeatId,coverage:coverageSettings({role,subjects}),durationFrames:null,notes:""});
  const narrative=source.beats.filter(b=>b.kind!=="transition");
  // Large scenes keep every beat; adjacent groups stay editable within the model's 60-shot ceiling.
  if(narrative.length+(narrative[0]?.kind!=="action"?1:0)+(includeReactions?narrative.filter(b=>b.kind==="dialogue"&&speakers.length>1).length:0)>60){
    const groups=Math.min(60,narrative.length),size=Math.ceil(narrative.length/groups);
    for(let i=0;i<narrative.length;i+=size){const beats=narrative.slice(i,i+size),voices=[...new Set(beats.flatMap(b=>b.kind==="dialogue"?[b.character]:[]))].slice(0,8);
      add(beats.map(b=>b.id),i===0?"master":voices.length===1?"single":voices.length>1?"two-shot":"insert",voices.length?voices:speakers);}
    return sceneCut(source,shots);
  }
  if(narrative[0]?.kind!=="action")add([],"master",speakers);
  for(const beat of narrative){
    add([beat.id],beat.kind==="dialogue"?"single":shots.length===0?"master":"insert",beat.kind==="dialogue"?[beat.character]:speakers);
    if(includeReactions&&beat.kind==="dialogue"){const listeners=speakers.filter(s=>s!==beat.character);if(listeners.length)add([],"reaction",[listeners[0]!],beat.id);}
  }
  return sceneCut(source,shots);
}
export function cutProposal(binding:CutBinding,sceneIndex:number,cut:SceneCut|null):CutProposal {
  exact(binding,["projectId","scriptVersion","castingRevision","directionRevision","maxShots"]);
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(binding.projectId)||!Number.isSafeInteger(binding.scriptVersion)||binding.scriptVersion<1||![24,60].includes(binding.maxShots)||!hash(binding.castingRevision)||!hash(binding.directionRevision)||!Number.isInteger(sceneIndex)||sceneIndex<0||sceneIndex>999)throw new Error("Invalid coverage proposal context.");
  if(cut){validateSceneCut(cut);if(cut.source.sceneIndex!==sceneIndex)throw new Error("The proposed scene changed.");}
  const data={binding:structuredClone(binding),sceneIndex,cut};return {schema:"hv-cut-proposal/1",...data,revision:contentHash(data)};
}
export function validateCutProposal(value:CutProposal):CutProposal {
  exact(value,["schema","binding","sceneIndex","cut","revision"]);const result=cutProposal(value.binding,value.sceneIndex,value.cut);
  if(value.schema!==result.schema||value.revision!==result.revision)throw new Error("The coverage proposal changed. Review it again before accepting.");return result;
}
