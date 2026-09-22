import {contentHash} from "../../generator/src/capabilities";
import type {ParseResult} from "../../parser/src/index";
import {charactersForScene,type CastCharacter,type CastingSnapshot} from "./casting";
import type {DirectionSnapshot,ShotDirection} from "./direction";
import type {Shot} from "./index";

/** The look a scene is expected to hold from shot to shot. Every one of these is a saved declaration. */
export const CONTINUITY_LOOK_FIELDS=["timeOfDay","keyLight","fillLight","backLight","motivatedSources"] as const;
export type ContinuityLookField=typeof CONTINUITY_LOOK_FIELDS[number];
const LOOK_LABELS:Record<ContinuityLookField,string>={timeOfDay:"time of day",keyLight:"key light",fillLight:"fill light",backLight:"back light",motivatedSources:"motivated sources"};
/**
 * Only a day-against-night opposition is reported. A heading's "LATER", "CONTINUOUS" or "MAGIC HOUR"
 * and a direction of "dusk" are not contradictions of anything, and guessing at them would turn a
 * check a creator can trust into one they learn to dismiss.
 */
const TIME_FAMILIES={day:["day","daylight","morning","afternoon","midday","noon"],night:["night","nighttime","midnight"]} as const;
const norm=(value:string)=>value.trim().replace(/\s+/g," ").toLocaleLowerCase("en-US");
export function continuityTimeFamily(value:string):"day"|"night"|null{
  const text=norm(value);if(!text)return null;
  const families=(Object.keys(TIME_FAMILIES) as ("day"|"night")[]).filter(family=>TIME_FAMILIES[family].some(word=>new RegExp("(^|[^a-z])"+word+"([^a-z]|$)").test(text)));
  return families.length===1?families[0]!:null;
}
/**
 * A Fountain heading states its own time after a separator: "INT. LIGHTHOUSE - NIGHT". A heading can
 * carry more than one trailing segment ("- DAY - CONTINUOUS"), so every segment after the location is
 * read and only an unambiguous single family counts.
 */
export function continuityHeadingTime(heading:string):"day"|"night"|null{
  const segments=heading.split(/\s+[-–—]{1,2}\s+/).slice(1);if(!segments.length)return null;
  const families=[...new Set(segments.map(continuityTimeFamily).filter((family):family is "day"|"night"=>family!==null))];
  return families.length===1?families[0]!:null;
}
export interface ContinuityCharacterState {characterId:string;name:string;wardrobe:string;wardrobeScope:"scene"|"default"|"unstated";preserve:string;references:number}
export interface ContinuityPacket {
  shotId:string;sceneIndex:number;sceneNumber:number;heading:string;headingTime:"day"|"night"|null;
  characters:ContinuityCharacterState[];look:Record<ContinuityLookField,string>;
  /** FULL-SCOPE P6's last approved frame, as the shot actually declares it. */
  handoff:{at:number;sha256:string}|null;revision:string;
}
export interface ContinuityFinding {code:string;severity:"warning"|"unknown"|"note";shotIds:string[];message:string}
export interface ContinuityScene {sceneIndex:number;sceneNumber:number;heading:string;shotIds:string[];packets:ContinuityPacket[];findings:ContinuityFinding[];lookComparisons:number;wardrobeComparisons:number;handoffComparisons:number}
export interface ContinuityReport {
  schema:"hv-continuity/1";rulesVersion:1;castingRevision:string;directionRevision:string;sourcePlanHash:string;staleShotIds:string[];
  scenes:ContinuityScene[];totals:{warnings:number;unknowns:number;notes:number;lookComparisons:number;wardrobeComparisons:number;handoffComparisons:number};revision:string;
}
function wardrobeState(character:CastCharacter,sceneNumber:number):{description:string;scope:ContinuityCharacterState["wardrobeScope"]}{
  const own=character.wardrobe.find(entry=>entry.sceneNumber===sceneNumber),fallback=character.wardrobe.find(entry=>entry.sceneNumber===null),entry=own??fallback;
  return {description:entry?.description??"",scope:own?"scene":fallback?"default":"unstated"};
}
export function continuityPacket(shot:Shot,heading:string,characters:CastCharacter[],settings:ShotDirection|undefined):ContinuityPacket{
  const sceneNumber=shot.sceneIndex+1,anchor=settings?.frameAnchors?.frames[0];
  const data={shotId:shot.id,sceneIndex:shot.sceneIndex,sceneNumber,heading,headingTime:continuityHeadingTime(heading),
    characters:characters.map(character=>{const wardrobe=wardrobeState(character,sceneNumber);
      return {characterId:character.id,name:character.name,wardrobe:wardrobe.description,wardrobeScope:wardrobe.scope,preserve:character.prohibitedChanges,references:(character.references??[]).length};}),
    look:Object.fromEntries(CONTINUITY_LOOK_FIELDS.map(field=>[field,settings?.[field]??""])) as Record<ContinuityLookField,string>,
    handoff:anchor?{at:anchor.at,sha256:anchor.asset.sha256}:null};
  return {...data,revision:contentHash(data)};
}
/**
 * Declared continuity only: the screenplay, the cast and the direction, compared against each other.
 * No picture is read and no similarity is measured, so a report with no warnings is a statement about
 * the declarations and never about the film. The comparison counters say how much could be checked.
 */
export function continuityReport(shots:Shot[],casting:CastingSnapshot,direction:DirectionSnapshot,parsed:ParseResult):ContinuityReport{
  const sources=shots.map(shot=>({id:shot.id,sceneIndex:shot.sceneIndex,prompt:shot.sourcePrompt??shot.prompt,dialogue:shot.dialogue}));
  const hashes=new Map(sources.map(source=>[source.id,contentHash(source)]));
  const stale=direction.entries.filter(entry=>hashes.get(entry.source.id)!==entry.sourceHash),staleIds=new Set(stale.map(entry=>entry.source.id));
  const settings=new Map(direction.entries.filter(entry=>!staleIds.has(entry.source.id)).map(entry=>[entry.source.id,entry.settings]));
  for(const shot of shots)if(!settings.has(shot.id)&&shot.direction&&!staleIds.has(shot.id))settings.set(shot.id,shot.direction);
  const groups=new Map<number,Shot[]>();for(const shot of shots){if(!groups.has(shot.sceneIndex))groups.set(shot.sceneIndex,[]);groups.get(shot.sceneIndex)!.push(shot);}
  // A saved direction whose shot has gone still has to be reported, and its scene may have gone with it.
  for(const entry of stale)if(!groups.has(entry.source.sceneIndex))groups.set(entry.source.sceneIndex,[]);
  const scenes:ContinuityScene[]=[];
  for(const [sceneIndex,sceneShots]of groups){
    const scene=parsed.scenes.find(value=>value.index===sceneIndex),heading=scene?.heading??"",sceneNumber=sceneIndex+1;
    const characters=scene?charactersForScene(casting,sceneIndex,parsed):[];
    const findings:ContinuityFinding[]=[],add=(code:string,severity:ContinuityFinding["severity"],shotIds:string[],message:string)=>findings.push({code,severity,shotIds,message});
    const packets=sceneShots.map(shot=>continuityPacket(shot,heading,staleIds.has(shot.id)?[]:characters,settings.get(shot.id)));
    let lookComparisons=0,wardrobeComparisons=0,handoffComparisons=0;
    for(const entry of stale.filter(value=>value.source.sceneIndex===sceneIndex))
      add("source-stale","unknown",[entry.source.id],"Saved direction for this shot has a changed or missing source, so its continuity is not compared. Review or remove it before rendering.");
    const live=packets.filter(packet=>!staleIds.has(packet.shotId));
    // One finding per look field: the first shot that states it, and every later shot that disagrees.
    for(const field of CONTINUITY_LOOK_FIELDS){
      const declared=live.filter(packet=>norm(packet.look[field]));if(declared.length<2)continue;
      const first=declared[0]!;lookComparisons+=declared.length-1;
      const conflicting=declared.slice(1).filter(packet=>norm(packet.look[field])!==norm(first.look[field]));
      if(conflicting.length)add("look-changed","warning",[first.shotId,...conflicting.map(packet=>packet.shotId)],
        "This scene declares more than one "+LOOK_LABELS[field]+": “"+first.look[field].trim()+"” and “"+conflicting.map(packet=>packet.look[field].trim()).join("”, “")+"”. Hold one across the scene, or say in the continuity note why it changes.");
    }
    const headingTime=continuityHeadingTime(heading);
    if(headingTime){
      const timed=live.filter(packet=>continuityTimeFamily(packet.look.timeOfDay));lookComparisons+=timed.length;
      const opposed=timed.filter(packet=>continuityTimeFamily(packet.look.timeOfDay)!==headingTime);
      if(opposed.length)add("time-contradicts-heading","warning",opposed.map(packet=>packet.shotId),
        "The scene heading reads "+headingTime+" and these shots are directed “"+[...new Set(opposed.map(packet=>packet.look.timeOfDay.trim()))].join("”, “")+"”. Correct the heading or the direction before rendering.");
    }
    // A comparison is a wardrobe state this scene actually holds; an unstated one is the unknown below.
    const unstated=characters.filter(character=>wardrobeState(character,sceneNumber).scope==="unstated");
    if(sceneShots.length)wardrobeComparisons+=characters.length-unstated.length;
    if(unstated.length&&sceneShots.length)add("wardrobe-unstated","unknown",sceneShots.map(shot=>shot.id),
      "No wardrobe is stated for "+unstated.map(character=>character.name).join(", ")+" in this scene, and no default is set, so nothing is held constant across its shots.");
    const unanchored=characters.filter(character=>!(character.references??[]).length);
    if(unanchored.length&&sceneShots.length)add("identity-unanchored","unknown",sceneShots.map(shot=>shot.id),
      "No reference image is retained for "+unanchored.map(character=>character.name).join(", ")+", so their consistency across shots rests on the written description alone.");
    handoffComparisons+=Math.max(0,live.length-1);
    const unhanded=live.slice(1).filter(packet=>!packet.handoff);
    if(unhanded.length)add("handoff-absent","note",unhanded.map(packet=>packet.shotId),
      "These shots do not start from a frame anchor, so each is generated without the frame before it. Carry the approved last frame forward where the pool supports it.");
    const priority={warning:0,unknown:1,note:2};findings.sort((a,b)=>priority[a.severity]-priority[b.severity]);
    scenes.push({sceneIndex,sceneNumber,heading,shotIds:sceneShots.map(shot=>shot.id),packets,findings,lookComparisons,wardrobeComparisons,handoffComparisons});
  }
  scenes.sort((a,b)=>a.sceneIndex-b.sceneIndex);const findings=scenes.flatMap(scene=>scene.findings);
  const sum=(field:"lookComparisons"|"wardrobeComparisons"|"handoffComparisons")=>scenes.reduce((total,scene)=>total+scene[field],0);
  const data={schema:"hv-continuity/1" as const,rulesVersion:1 as const,castingRevision:casting.revision,directionRevision:direction.revision,sourcePlanHash:contentHash(sources),
    staleShotIds:[...staleIds],scenes,
    totals:{warnings:findings.filter(finding=>finding.severity==="warning").length,unknowns:findings.filter(finding=>finding.severity==="unknown").length,
      notes:findings.filter(finding=>finding.severity==="note").length,lookComparisons:sum("lookComparisons"),wardrobeComparisons:sum("wardrobeComparisons"),handoffComparisons:sum("handoffComparisons")}};
  return {...data,revision:contentHash(data)};
}
