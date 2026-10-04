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
 * HV-021-08: "INT. HALL - CONTINUOUS" picks up in the same moment the scene before it left off. Read
 * as continuous: a segment after the location that is exactly CONTINUOUS, with or without spaces
 * around its dash ("INT. HALL-CONTINUOUS") and with or without a closing full stop, and a
 * parenthetical "(CONTINUOUS)" anywhere after the location. A trailing Fountain scene number ("#2#")
 * is ignored. "LATER" and "MOMENTS LATER" are a jump in story time, however small, and a character
 * may have changed or the light gone in it; reading them as continuous would report contradictions
 * the screenplay never made. "SAME" and "CONT'D" are not read either.
 */
export function continuityHeadingContinuous(heading:string):boolean{
  const text=norm(heading.replace(/\s*#[^#]*#\s*$/,""));
  if(/\S.*\(\s*continuous\s*\)/.test(text))return true;
  return text.split(/\s*[-–—]{1,2}\s*/).slice(1).some(segment=>/^continuous\.?$/.test(segment));
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
/**
 * `sequenceBoundary` (HV-021-11) marks a finding made across a feature's sequence boundary: on the
 * scene that opens sequence `to`, against the scene that closes sequence `from`. Absent everywhere
 * else, so a reel's or a short's findings are exactly what they were.
 */
export interface ContinuityFinding {code:string;severity:"warning"|"unknown"|"note";shotIds:string[];message:string;sequenceBoundary?:{from:number;to:number}}
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
/**
 * HV-021-11: one boundary between two of a feature's sequences -- the last scene of sequence `from`
 * and the first of sequence `to`, one-based as the desk numbers scenes. Every boundary of the plan has
 * one, so the report says what it did at each, including that it compared nothing.
 *
 * - `continuous`: the opening scene's heading is CONTINUOUS, so no story time passes across the
 *   boundary and what the CONTINUOUS check compares (time of day, wardrobe) must agree. Without it,
 *   time may pass and nothing is held across.
 * - `sameLocation`: both headings name the same place. CONTINUOUS and the same place is one moment in
 *   one place, split between two renders, so the light it is directed with must hold across it too.
 * - `comparisons`: every comparison made across this boundary (the CONTINUOUS check's, plus the light);
 *   all of them are already counted in the opening scene's counters and in the totals.
 * - `findings`: how many of the opening scene's findings are about this boundary.
 */
export interface ContinuityBoundary {from:number;to:number;lastScene:number;firstScene:number;continuous:boolean;sameLocation:boolean;comparisons:number;findings:number}
/** A feature's sequence plan, as far as the report reads it: consecutive runs of one-based scenes, in order. */
export interface ContinuitySequences {sequences:readonly {firstScene:number;lastScene:number}[]}
/**
 * `boundaries` (HV-021-11) is present only for a feature with a current sequence plan, so a reel's or a
 * short's report -- and its revision -- is exactly what it was.
 */
export interface ContinuityReport {
  schema:"hv-continuity/1";rulesVersion:1;castingRevision:string;directionRevision:string;sourcePlanHash:string;staleShotIds:string[];
  scenes:ContinuityScene[];totals:{warnings:number;unknowns:number;notes:number;lookComparisons:number;wardrobeComparisons:number;handoffComparisons:number;continuousComparisons:number};
  boundaries?:ContinuityBoundary[];revision:string;
}
/**
 * HV-021-11: the look held across a same-place CONTINUOUS sequence boundary. Time of day is not here:
 * the CONTINUOUS check already compares it across every such heading, and which of two scenes is
 * right about the time is the creator's call (HV-021-08), so it stays that check's.
 */
export const CONTINUITY_BOUNDARY_LOOK_FIELDS=["keyLight","fillLight","backLight","motivatedSources"] as const satisfies readonly ContinuityLookField[];
/** The finding codes that compare a scene with the one before it, and so are labelled when that scene opens a sequence. */
export const CONTINUITY_BOUNDARY_CODES:readonly string[]=["time-contradicts-previous","wardrobe-contradicts-previous","boundary-look-changed"];
export type TimeFamily="day"|"night";
/**
 * The time a scene declares, for comparing it with a neighbour. The heading is the scene's own
 * statement of its time, so where it has one, that is the scene's time: a shot directed against it is
 * already `time-contradicts-heading`, and comparing that shot with the next scene too would report one
 * defect twice. Without one, the scene's time is whatever its compared shots are directed, which may
 * be both families, and may be nothing at all -- in which case there is nothing to compare.
 */
export interface DeclaredTime {heading:string;headingTime:TimeFamily|null;shots:{shotId:string;value:string;family:TimeFamily}[]}
function declaredTime(heading:string,looks:{shotId:string;timeOfDay:string}[]):DeclaredTime{
  return {heading,headingTime:continuityHeadingTime(heading),shots:looks.flatMap(look=>{const family=continuityTimeFamily(look.timeOfDay);return family?[{shotId:look.shotId,value:look.timeOfDay.trim(),family}]:[];})};
}
const timeFamilies=(time:DeclaredTime):TimeFamily[]=>time.headingTime?[time.headingTime]:[...new Set(time.shots.map(shot=>shot.family))];
/**
 * The time comparison across a CONTINUOUS heading, shared by the report and by the repair so the two
 * cannot disagree about what is opposed. A declaration opposes only when its family is one the scene
 * before does not declare at all: a previous scene directed both day and night already contradicts
 * itself (`look-changed`), and either of its families agrees with something in it.
 */
export function continuityContinuousTime(previousHeading:string,previousLooks:{shotId:string;timeOfDay:string}[],heading:string,looks:{shotId:string;timeOfDay:string}[]){
  const was=declaredTime(previousHeading,previousLooks),is=declaredTime(heading,looks),before=timeFamilies(was);
  const compared=before.length>0&&timeFamilies(is).length>0,absent=(family:TimeFamily)=>!before.includes(family);
  // A heading names the whole scene; a directed time names its own shots.
  const headingOpposed=compared&&is.headingTime!==null&&absent(is.headingTime);
  const opposed=compared&&!is.headingTime?is.shots.filter(shot=>absent(shot.family)):[];
  return {was,is,compared,headingOpposed,opposed};
}
/**
 * HV-021-11: the place a heading names, for telling whether a CONTINUOUS scene stays where the scene
 * before it was. The heading's first segment, with a trailing Fountain scene number, any
 * parenthetical and a trailing "-CONTINUOUS" taken off: "INT. LIGHTHOUSE - NIGHT",
 * "INT. LIGHTHOUSE - CONTINUOUS" and "int. lighthouse (CONTINUOUS)" are one place.
 */
export function continuityHeadingLocation(heading:string):string{
  const text=norm(heading.replace(/\s*#[^#]*#\s*$/,"")).replace(/\([^)]*\)/g," ").replace(/\s*[-–—]{1,2}\s*continuous\.?\s*$/,"");
  return norm(text.split(/\s+[-–—]{1,2}\s+/)[0]??"");
}
/**
 * HV-021-11: the value each scene opening a same-place CONTINUOUS sequence boundary is held to, per
 * light field, keyed "sceneIndex:field". It is the first shot that states the field in the run of
 * scenes joined that way -- the rule a scene's own look is held to (`look-changed`), across the
 * boundary -- so a chain of such boundaries holds every scene in it to the same shot. Shared by the
 * report and the repair, so the two cannot disagree about what a boundary holds.
 */
export function continuityBoundaryHolds(scenes:readonly {sceneIndex:number;packets:readonly ContinuityPacket[]}[],boundaries:readonly ContinuityBoundary[]):Map<string,{shotId:string;value:string}>{
  const joined=new Set(boundaries.filter(boundary=>boundary.continuous&&boundary.sameLocation).map(boundary=>boundary.firstScene-1));
  const held=new Map<string,{shotId:string;value:string}>(),inherited=new Map<string,{shotId:string;value:string}>();
  for(const scene of [...scenes].sort((a,b)=>a.sceneIndex-b.sceneIndex))for(const field of CONTINUITY_BOUNDARY_LOOK_FIELDS){
    const from=joined.has(scene.sceneIndex)?held.get((scene.sceneIndex-1)+":"+field):undefined,first=scene.packets.find(packet=>norm(packet.look[field]));
    if(from)inherited.set(scene.sceneIndex+":"+field,from);
    const out=from??(first?{shotId:first.shotId,value:first.look[field]}:undefined);
    if(out)held.set(scene.sceneIndex+":"+field,out);
  }
  return inherited;
}
const describeTime=(time:DeclaredTime,shots=time.shots)=>time.headingTime?"headed “"+time.heading.trim()+"”":"directed “"+[...new Set(shots.map(shot=>shot.value))].join("”, “")+"”";
/** Typography is not a costume change: curly and straight quotes, case, spacing and a closing full stop are folded. */
const wardrobeNorm=(value:string)=>norm(value.replace(/[‘’ʼ′]/g,"'").replace(/[“”″]/g,"\"")).replace(/[\s.,;:!]+$/,"");
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
/**
 * HV-021-11: `sequences` is a feature's current sequence plan. With it, the report covers every
 * sequence boundary: each gets a {@link ContinuityBoundary}, the CONTINUOUS check's findings on a
 * scene that opens a sequence are labelled with the boundary, and a same-place CONTINUOUS boundary is
 * checked for the light (`boundary-look-changed`). Without it -- a reel, a short -- nothing changes.
 */
export function continuityReport(shots:Shot[],casting:CastingSnapshot,direction:DirectionSnapshot,parsed:ParseResult,sequences?:ContinuitySequences):ContinuityReport{
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
      const time=continuityContinuousTime(previous.heading,(groups.get(previous.index)??[]).filter(shot=>!staleIds.has(shot.id)).map(shot=>({shotId:shot.id,timeOfDay:settings.get(shot.id)?.timeOfDay??""})),
        heading,packets.map(packet=>({shotId:packet.shotId,timeOfDay:packet.look.timeOfDay})));
      if(time.compared)continuousComparisons+=1;
      if(time.headingOpposed||time.opposed.length)
        add("time-contradicts-previous","warning",time.headingOpposed?sceneShots.map(shot=>shot.id):time.opposed.map(shot=>shot.shotId),
          "This scene is CONTINUOUS from scene "+(previous.index+1)+", which is "+describeTime(time.was)+", and this scene is "+describeTime(time.is,time.opposed)
          +". A continuous scene is the same moment, so the time of day cannot change between them. Correct one of the two before rendering.");
      const earlier=new Set(charactersForScene(casting,previous.index,parsed).map(character=>character.id)),seen=new Set<string>(),changed:string[]=[];
      for(const character of characters){
        if(!earlier.has(character.id)||seen.has(character.id))continue;seen.add(character.id);
        const then=wardrobeState(character,previous.index+1),here=wardrobeState(character,sceneNumber);
        if(then.scope==="unstated"||here.scope==="unstated")continue;
        continuousComparisons+=1;
        if(wardrobeNorm(then.description)!==wardrobeNorm(here.description))
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
  scenes.sort((a,b)=>a.sceneIndex-b.sceneIndex);
  const boundaries=sequences?sequenceBoundaries(scenes,parsed,sequences):undefined;
  const findings=scenes.flatMap(scene=>scene.findings);
  const sum=(field:"lookComparisons"|"wardrobeComparisons"|"handoffComparisons"|"continuousComparisons")=>scenes.reduce((total,scene)=>total+scene[field],0);
  const data={schema:"hv-continuity/1" as const,rulesVersion:1 as const,castingRevision:casting.revision,directionRevision:direction.revision,sourcePlanHash:contentHash(sources),
    staleShotIds:[...staleIds],scenes,
    totals:{warnings:findings.filter(finding=>finding.severity==="warning").length,unknowns:findings.filter(finding=>finding.severity==="unknown").length,
      notes:findings.filter(finding=>finding.severity==="note").length,lookComparisons:sum("lookComparisons"),wardrobeComparisons:sum("wardrobeComparisons"),handoffComparisons:sum("handoffComparisons"),continuousComparisons:sum("continuousComparisons")},
    ...(boundaries?{boundaries}:{})};
  return {...data,revision:contentHash(data)};
}
/**
 * HV-021-11: the Supervisor compares each sequence's last scene with the next one's first, as it does
 * across a CONTINUOUS heading -- because that is what it does: the scene opening a sequence is checked
 * against the one before it by the same CONTINUOUS check every other scene gets, and here those
 * findings are labelled with the boundary. A boundary whose opening scene is not CONTINUOUS lets story
 * time pass, so nothing is held across it, and the boundary says so rather than reading as a pass.
 *
 * One check is the boundary's own. A CONTINUOUS scene in the same place as the scene before it is the
 * same moment in the same place; split between two sequences, the two halves are rendered and
 * approved separately and nothing else carries the light from one to the other. So each light field
 * both declare is held to the first shot that states it, as within a scene. Mutates `scenes`.
 */
function sequenceBoundaries(scenes:ContinuityScene[],parsed:ParseResult,plan:ContinuitySequences):ContinuityBoundary[]{
  const boundaries=plan.sequences.slice(1).map((sequence,index):ContinuityBoundary=>{
    const opening=parsed.scenes.find(value=>value.index===sequence.firstScene-1),closing=parsed.scenes.find(value=>value.index===sequence.firstScene-2);
    return {from:index+1,to:index+2,lastScene:sequence.firstScene-1,firstScene:sequence.firstScene,continuous:Boolean(opening&&closing&&continuityHeadingContinuous(opening.heading)),
      sameLocation:Boolean(opening&&closing&&continuityHeadingLocation(opening.heading)===continuityHeadingLocation(closing.heading)),comparisons:0,findings:0};
  });
  const holds=continuityBoundaryHolds(scenes,boundaries),priority={warning:0,unknown:1,note:2};
  for(const boundary of boundaries){
    const scene=scenes.find(value=>value.sceneIndex===boundary.firstScene-1);if(!scene)continue;
    let looks=0;
    if(boundary.continuous&&boundary.sameLocation)for(const field of CONTINUITY_BOUNDARY_LOOK_FIELDS){
      const hold=holds.get(scene.sceneIndex+":"+field),declared=scene.packets.filter(packet=>norm(packet.look[field]));
      if(!hold||!declared.length)continue;
      looks+=declared.length;
      const conflicting=declared.filter(packet=>norm(packet.look[field])!==norm(hold.value));
      if(conflicting.length)scene.findings.push({code:"boundary-look-changed",severity:"warning",shotIds:[hold.shotId,...conflicting.map(packet=>packet.shotId)],
        message:"Sequence "+boundary.to+" opens in the place and moment sequence "+boundary.from+" closes (scene "+boundary.firstScene+" is CONTINUOUS from scene "+boundary.lastScene
          +", in the same place), and the "+LOOK_LABELS[field]+" changes across them: “"+hold.value.trim()+"”, then “"+[...new Set(conflicting.map(packet=>packet.look[field].trim()))].join("”, “")
          +"”. The two sequences are rendered separately, so nothing else carries the light across. Hold one, or say in the continuity note why it changes."});
    }
    scene.lookComparisons+=looks;
    const label={from:boundary.from,to:boundary.to};
    for(const finding of scene.findings)if(CONTINUITY_BOUNDARY_CODES.includes(finding.code))finding.sequenceBoundary=label;
    scene.findings.sort((a,b)=>priority[a.severity]-priority[b.severity]);
    boundary.comparisons=scene.continuousComparisons+looks;
    boundary.findings=scene.findings.filter(finding=>finding.sequenceBoundary).length;
  }
  return boundaries;
}
