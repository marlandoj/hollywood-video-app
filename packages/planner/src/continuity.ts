import {contentHash} from "../../generator/src/capabilities";
import type {ParseResult} from "../../parser/src/index";
import {charactersForScene,type CastCharacter,type CastingSnapshot} from "./casting";
import {renderReferences} from "./reference-lock";
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
/**
 * HV-021-08: "INT. HALL - CONTINUOUS" picks up in the same moment the scene before it left off. Only a
 * segment that is exactly CONTINUOUS counts. "LATER" and "MOMENTS LATER" are a jump in story time,
 * however small, and a character may have changed or the light gone in it; reading them as
 * continuous would report contradictions the screenplay never made.
 */
export function continuityHeadingContinuous(heading:string):boolean{
  return heading.split(/\s+[-–—]{1,2}\s+/).slice(1).some(segment=>/^continuous[.!]?$/.test(norm(segment)));
}
/**
 * `references` is what the render will actually be conditioned on, not what the character retains.
 * HV-017-09 gave a character a locked look — a chosen subset of its retained images — and this count
 * read the whole set, so a character locked to two of its four images was reported as anchored by
 * four. A continuity report claiming more anchoring than the render uses is the one thing it must
 * not do.
 */
export interface ContinuityCharacterState {characterId:string;name:string;wardrobe:string;wardrobeScope:"scene"|"default"|"unstated";preserve:string;references:number;referencesLocked:boolean}
/**
 * One shot's declared continuity. The characters are **not** here: they are the scene's, identical
 * for every shot in it, and repeating them per shot made `GET /direction` carry 1.7 MB of duplicate
 * cast text on a 60-shot film — 99% of the response — for a report whose findings are a few hundred
 * bytes. They are on {@link ContinuityScene} instead.
 */
export interface ContinuityPacket {
  shotId:string;sceneIndex:number;sceneNumber:number;heading:string;headingTime:"day"|"night"|null;
  look:Record<ContinuityLookField,string>;
  /** FULL-SCOPE P6's last approved frame, as the shot actually declares it. */
  handoff:{at:number;sha256:string}|null;revision:string;
}
export interface ContinuityFinding {code:string;severity:"warning"|"unknown"|"note";shotIds:string[];message:string}
/**
 * `shotIds` is every shot in the scene; `packets` are the ones whose continuity was compared. A shot
 * whose saved direction has a changed source gets no packet — it is named in `staleShotIds` and by
 * its own `source-stale` finding, and comparing it would be comparing direction to a shot that no
 * longer says what it said.
 */
/**
 * `continuousComparisons` (HV-021-08) counts what a CONTINUOUS scene could actually be checked against
 * the scene it continues: one for the time of day when both declare one, and one per character in
 * both scenes whose wardrobe both state. Zero is the absence of declarations, not continuity.
 */
export interface ContinuityScene {sceneIndex:number;sceneNumber:number;heading:string;shotIds:string[];characters:ContinuityCharacterState[];packets:ContinuityPacket[];findings:ContinuityFinding[];lookComparisons:number;wardrobeComparisons:number;handoffComparisons:number;continuousComparisons:number}
export interface ContinuityReport {
  schema:"hv-continuity/1";rulesVersion:1;castingRevision:string;directionRevision:string;sourcePlanHash:string;staleShotIds:string[];
  scenes:ContinuityScene[];totals:{warnings:number;unknowns:number;notes:number;lookComparisons:number;wardrobeComparisons:number;handoffComparisons:number;continuousComparisons:number};revision:string;
}
type TimeFamily="day"|"night";
/**
 * The time a scene declares, for comparing it with a neighbour. The heading is the scene's own
 * statement of its time, so where it has one, that is the scene's time: a shot directed against it is
 * already `time-contradicts-heading`, and comparing that shot with the next scene too would report one
 * defect twice. Without one, the scene's time is whatever its compared shots are directed, which may
 * be both families, and may be nothing at all -- in which case there is nothing to compare.
 */
interface DeclaredTime {heading:string;headingTime:TimeFamily|null;shots:{shotId:string;value:string;family:TimeFamily}[]}
function declaredTime(heading:string,looks:{shotId:string;timeOfDay:string}[]):DeclaredTime{
  return {heading,headingTime:continuityHeadingTime(heading),shots:looks.flatMap(look=>{const family=continuityTimeFamily(look.timeOfDay);return family?[{shotId:look.shotId,value:look.timeOfDay.trim(),family}]:[];})};
}
const timeFamilies=(time:DeclaredTime):TimeFamily[]=>time.headingTime?[time.headingTime]:[...new Set(time.shots.map(shot=>shot.family))];
const describeTime=(time:DeclaredTime,shots=time.shots)=>time.headingTime?"headed “"+time.heading.trim()+"”":"directed “"+[...new Set(shots.map(shot=>shot.value))].join("”, “")+"”";
const describeWardrobe=(state:{description:string;scope:ContinuityCharacterState["wardrobeScope"]})=>"“"+state.description.trim()+"”"+(state.scope==="default"?" (the project default)":"");
function wardrobeState(character:CastCharacter,sceneNumber:number):{description:string;scope:ContinuityCharacterState["wardrobeScope"]}{
  const own=character.wardrobe.find(entry=>entry.sceneNumber===sceneNumber),fallback=character.wardrobe.find(entry=>entry.sceneNumber===null),entry=own??fallback;
  return {description:entry?.description??"",scope:own?"scene":fallback?"default":"unstated"};
}
/** The scene's cast state, stated once: every shot in a scene is compared against the same one. */
export function continuityCharacters(characters:CastCharacter[],sceneNumber:number):ContinuityCharacterState[]{
  return characters.map(character=>{const wardrobe=wardrobeState(character,sceneNumber),rendered=renderReferences(character);
    return {characterId:character.id,name:character.name,wardrobe:wardrobe.description,wardrobeScope:wardrobe.scope,
      preserve:character.prohibitedChanges,references:rendered.length,referencesLocked:Boolean(character.referenceLock)};});
}
export function continuityPacket(shot:Shot,heading:string,settings:ShotDirection|undefined):ContinuityPacket{
  const anchor=settings?.frameAnchors?.frames[0];
  const data={shotId:shot.id,sceneIndex:shot.sceneIndex,sceneNumber:shot.sceneIndex+1,heading,headingTime:continuityHeadingTime(heading),
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
    // A stale shot gets no packet: its saved direction refers to a shot that has changed, so there is
    // nothing here to compare. It is named by `shotIds`, by `staleShotIds` and by its own finding.
    const packets=sceneShots.filter(shot=>!staleIds.has(shot.id)).map(shot=>continuityPacket(shot,heading,settings.get(shot.id)));
    let lookComparisons=0,wardrobeComparisons=0,handoffComparisons=0;
    for(const entry of stale.filter(value=>value.source.sceneIndex===sceneIndex))
      add("source-stale","unknown",[entry.source.id],"Saved direction for this shot has a changed or missing source, so its continuity is not compared. Review or remove it before rendering.");
    // One finding per look field: the first shot that states it, and every later shot that disagrees.
    for(const field of CONTINUITY_LOOK_FIELDS){
      const declared=packets.filter(packet=>norm(packet.look[field]));if(declared.length<2)continue;
      const first=declared[0]!;lookComparisons+=declared.length-1;
      const conflicting=declared.slice(1).filter(packet=>norm(packet.look[field])!==norm(first.look[field]));
      if(conflicting.length)add("look-changed","warning",[first.shotId,...conflicting.map(packet=>packet.shotId)],
        "This scene declares more than one "+LOOK_LABELS[field]+": “"+first.look[field].trim()+"” and “"+conflicting.map(packet=>packet.look[field].trim()).join("”, “")+"”. Hold one across the scene, or say in the continuity note why it changes.");
    }
    const headingTime=continuityHeadingTime(heading);
    if(headingTime){
      const timed=packets.filter(packet=>continuityTimeFamily(packet.look.timeOfDay));lookComparisons+=timed.length;
      const opposed=timed.filter(packet=>continuityTimeFamily(packet.look.timeOfDay)!==headingTime);
      if(opposed.length)add("time-contradicts-heading","warning",opposed.map(packet=>packet.shotId),
        "The scene heading reads "+headingTime+" and these shots are directed “"+[...new Set(opposed.map(packet=>packet.look.timeOfDay.trim()))].join("”, “")+"”. Correct the heading or the direction before rendering.");
    }
    // A comparison is a wardrobe state this scene actually holds; an unstated one is the unknown below.
    const unstated=characters.filter(character=>wardrobeState(character,sceneNumber).scope==="unstated");
    if(sceneShots.length)wardrobeComparisons+=characters.length-unstated.length;
    if(unstated.length&&sceneShots.length)add("wardrobe-unstated","unknown",sceneShots.map(shot=>shot.id),
      "No wardrobe is stated for "+unstated.map(character=>character.name).join(", ")+" in this scene, and no default is set, so nothing is held constant across its shots.");
    const unanchored=characters.filter(character=>!renderReferences(character).length);
    if(unanchored.length&&sceneShots.length)add("identity-unanchored","unknown",sceneShots.map(shot=>shot.id),
      "No reference image is retained for "+unanchored.map(character=>character.name).join(", ")+", so their consistency across shots rests on the written description alone.");
    // HV-021-08: a CONTINUOUS scene is the same moment as the scene before it, so what both declare
    // about that moment has to agree. Only what both actually state is compared; an unstated wardrobe
    // or an undirected time is not a contradiction, and `wardrobe-unstated` already names the first.
    let continuousComparisons=0;
    const previous=scene&&sceneShots.length&&continuityHeadingContinuous(heading)?parsed.scenes.find(value=>value.index===sceneIndex-1):undefined;
    if(previous){
      const was=declaredTime(previous.heading,(groups.get(previous.index)??[]).filter(shot=>!staleIds.has(shot.id)).map(shot=>({shotId:shot.id,timeOfDay:settings.get(shot.id)?.timeOfDay??""})));
      const is=declaredTime(heading,packets.map(packet=>({shotId:packet.shotId,timeOfDay:packet.look.timeOfDay})));
      const before=timeFamilies(was),after=timeFamilies(is);
      if(before.length&&after.length){
        continuousComparisons+=1;
        // A heading names the whole scene; a directed time names its own shots.
        const opposite=(family:TimeFamily)=>before.some(value=>value!==family);
        const opposed=is.headingTime?[]:is.shots.filter(shot=>opposite(shot.family));
        if(is.headingTime?opposite(is.headingTime):opposed.length)
          add("time-contradicts-previous","warning",is.headingTime?sceneShots.map(shot=>shot.id):opposed.map(shot=>shot.shotId),
            "This scene is CONTINUOUS from scene "+(previous.index+1)+", which is "+describeTime(was)+", and this scene is "+describeTime(is,opposed)
            +". A continuous scene is the same moment, so the time of day cannot change between them. Correct one of the two before rendering.");
      }
      const earlier=new Set(charactersForScene(casting,previous.index,parsed).map(character=>character.id)),seen=new Set<string>(),changed:string[]=[];
      for(const character of characters){
        if(!earlier.has(character.id)||seen.has(character.id))continue;seen.add(character.id);
        const then=wardrobeState(character,previous.index+1),here=wardrobeState(character,sceneNumber);
        if(then.scope==="unstated"||here.scope==="unstated")continue;
        continuousComparisons+=1;
        if(norm(then.description)!==norm(here.description))
          changed.push(character.name+" wears "+describeWardrobe(then)+" in scene "+(previous.index+1)+" and "+describeWardrobe(here)+" in scene "+sceneNumber);
      }
      if(changed.length)add("wardrobe-contradicts-previous","warning",sceneShots.map(shot=>shot.id),
        "This scene is CONTINUOUS from scene "+(previous.index+1)+", and the wardrobe changes between them: "+changed.join("; ")
        +". Nobody changes clothes inside one continuous moment. Correct the wardrobe in the cast, or the heading if time passes.");
    }
    handoffComparisons+=Math.max(0,packets.length-1);
    const unhanded=packets.slice(1).filter(packet=>!packet.handoff);
    if(unhanded.length)add("handoff-absent","note",unhanded.map(packet=>packet.shotId),
      "These shots do not start from a frame anchor, so each is generated without the frame before it. Carry the approved last frame forward where the pool supports it.");
    const priority={warning:0,unknown:1,note:2};findings.sort((a,b)=>priority[a.severity]-priority[b.severity]);
    scenes.push({sceneIndex,sceneNumber,heading,shotIds:sceneShots.map(shot=>shot.id),characters:continuityCharacters(characters,sceneNumber),packets,findings,lookComparisons,wardrobeComparisons,handoffComparisons,continuousComparisons});
  }
  scenes.sort((a,b)=>a.sceneIndex-b.sceneIndex);const findings=scenes.flatMap(scene=>scene.findings);
  const sum=(field:"lookComparisons"|"wardrobeComparisons"|"handoffComparisons"|"continuousComparisons")=>scenes.reduce((total,scene)=>total+scene[field],0);
  const data={schema:"hv-continuity/1" as const,rulesVersion:1 as const,castingRevision:casting.revision,directionRevision:direction.revision,sourcePlanHash:contentHash(sources),
    staleShotIds:[...staleIds],scenes,
    totals:{warnings:findings.filter(finding=>finding.severity==="warning").length,unknowns:findings.filter(finding=>finding.severity==="unknown").length,
      notes:findings.filter(finding=>finding.severity==="note").length,lookComparisons:sum("lookComparisons"),wardrobeComparisons:sum("wardrobeComparisons"),handoffComparisons:sum("handoffComparisons"),continuousComparisons:sum("continuousComparisons")}};
  return {...data,revision:contentHash(data)};
}
