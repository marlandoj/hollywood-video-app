import {contentHash} from "../../generator/src/capabilities";
import {CONTINUITY_LOOK_FIELDS,continuityContinuousTime,continuityHeadingContinuous,type ContinuityLookField,type ContinuityReport} from "./continuity";

/**
 * HV-021-02: the repair half of the Continuity Supervisor. It proposes exactly one kind of fix — the
 * look a scene declares more than once — and says why it proposes nothing for the rest.
 *
 * That restraint is the design. A scene directed against its own heading is drift the studio can see
 * and cannot resolve: either the heading is wrong or the direction is, and only the creator knows
 * which. Offering to "fix" it would make the studio pick, silently, and be right about half the time.
 */
export const CONTINUITY_REPAIR_LIMIT=240;
/** The findings that are a contradiction rather than something the project has not stated. */
export const CONTINUITY_REPAIR_CONTRADICTIONS=["time-contradicts-heading","time-contradicts-previous","wardrobe-contradicts-previous"] as const as readonly string[];
/**
 * HV-021-10: each contradiction as the summary says it. The summary is read by a creator, so it
 * names what is wrong in words; `refused` still carries the codes, for anything that reads them.
 */
export const CONTINUITY_REPAIR_CONTRADICTION_WORDS:Readonly<Record<string,string>>={
  "time-contradicts-heading":"a shot's time of day contradicts the scene heading",
  "time-contradicts-previous":"a CONTINUOUS scene's time of day contradicts the scene before it",
  "wardrobe-contradicts-previous":"a character's wardrobe changes across a CONTINUOUS heading",
};
/** "a", "a and b", "a, b and c". */
const inWords=(items:string[])=>items.length<2?items.join(""):items.slice(0,-1).join(", ")+" and "+items.at(-1);
const LOOK_LABELS:Record<ContinuityLookField,string>={timeOfDay:"time of day",keyLight:"key light",fillLight:"fill light",backLight:"back light",motivatedSources:"motivated sources"};
export interface ContinuityRepairEdit {shotId:string;sceneIndex:number;field:ContinuityLookField;from:string;to:string}
export interface ContinuityRepairProposal {
  schema:"hv-continuity-repair/1";
  /** Bound to the report it was read from, and to the same three inputs that report was computed from. */
  reportRevision:string;castingRevision:string;directionRevision:string;sourcePlanHash:string;
  edits:ContinuityRepairEdit[];notes:string[];
  /**
   * The finding codes this repair saw and would not repair, so a reader can tell a scene that
   * contradicts itself from one that merely has not been described. The notes say it in words; this
   * says it in a form the summary can be precise about.
   */
  refused:string[];revision:string;
}
const norm=(value:string)=>value.trim().replace(/\s+/g," ").toLocaleLowerCase("en-US");
const scene=(index:number)=>"Scene "+(index+1);
/**
 * HV-021-08: the scenes whose time-of-day edits are held back, so that accepting the repair never
 * leaves a CONTINUOUS scene opposing the scene before it in a shot (or heading) that did not oppose
 * before. Each CONTINUOUS pair is compared before and after the proposed time edits, with the same
 * `continuityContinuousTime` the report uses; a pair the edits would make worse keeps both scenes'
 * times as they are, and the check runs again until nothing more is held, since holding one scene
 * back changes the pair on its other side. Holding back only ever returns a scene to what the report
 * already compared, so this always ends, at worst with no time edits at all.
 *
 * Where the scene before is not in the report (it has no shots), only its heading can be declared,
 * which no edit changes: a CONTINUOUS scene that already opposes it is held, and one that does not
 * cannot be made to, because its own edits only narrow the times it declares.
 */
function continuousTimeHeld(report:ContinuityReport,edits:ContinuityRepairEdit[]):Set<number>{
  const byIndex=new Map(report.scenes.map(value=>[value.sceneIndex,value]));
  const target=new Map(edits.filter(edit=>edit.field==="timeOfDay").map(edit=>[edit.shotId,edit.to]));
  const held=new Set<number>();let changed=true;
  const looks=(value:ContinuityReport["scenes"][number],applied:boolean)=>value.packets.map(packet=>({shotId:packet.shotId,
    timeOfDay:applied&&!held.has(value.sceneIndex)?target.get(packet.shotId)??packet.look.timeOfDay:packet.look.timeOfDay}));
  const hold=(index:number)=>{if(!held.has(index)){held.add(index);changed=true;}};
  while(changed){
    changed=false;
    for(const value of report.scenes){
      if(!continuityHeadingContinuous(value.heading))continue;
      const previous=byIndex.get(value.sceneIndex-1);
      if(!previous){if(value.findings.some(finding=>finding.code==="time-contradicts-previous"))hold(value.sceneIndex);continue;}
      const check=(applied:boolean)=>continuityContinuousTime(previous.heading,looks(previous,applied),value.heading,looks(value,applied));
      const before=check(false),after=check(true),opposed=new Set(before.opposed.map(shot=>shot.shotId));
      if((after.headingOpposed&&!before.headingOpposed)||after.opposed.some(shot=>!opposed.has(shot.shotId))){hold(previous.sceneIndex);hold(value.sceneIndex);}
    }
  }
  return held;
}
/**
 * The value a scene holds is the one its first declaring shot states. The Supervisor does not choose
 * between two looks on its own merits: it makes the scene agree with the shot the creator set first.
 */
export function continuityRepair(report:ContinuityReport):ContinuityRepairProposal{
  const edits:ContinuityRepairEdit[]=[],notes:string[]=[],refused=new Set<string>(),stale=new Set(report.staleShotIds);
  // A report's packets are the shots it compared, so a stale shot cannot be among them. Refused
  // rather than filtered: a report that says a shot is both compared and stale is not a report to
  // propose edits from, and quietly skipping the shot would hide that.
  if(report.scenes.some(value=>value.packets.some(packet=>stale.has(packet.shotId))))
    throw new Error("This continuity report lists a shot as both compared and stale. Run the check again.");
  for(const value of report.scenes){
    const codes=new Set(value.findings.map(finding=>finding.code));
    for(const field of CONTINUITY_LOOK_FIELDS){
      // HV-021-06: a scene directed against its own heading's time gets no time-of-day edit. "Hold the
      // first shot's look" does not know which of the heading and the direction is wrong, and in
      // INT. KITCHEN - DAY with shot 1 at night it proposed turning shot 2 to night as well: the scene
      // contradicted its heading in two shots after the repair instead of one, while the note beneath
      // said nothing was proposed.
      if(field==="timeOfDay"&&codes.has("time-contradicts-heading"))continue;
      const declared=value.packets.filter(packet=>norm(packet.look[field]));
      if(declared.length<2)continue;
      const hold=declared[0]!;
      for(const packet of declared.slice(1))if(norm(packet.look[field])!==norm(hold.look[field]))
        edits.push({shotId:packet.shotId,sceneIndex:value.sceneIndex,field,from:packet.look[field],to:hold.look[field]});
    }
    for(const code of codes)if(code!=="look-changed")refused.add(code);
    // What is seen and deliberately not proposed. A repair that stays silent about the rest reads as
    // though the rest were fine.
    if(codes.has("time-contradicts-heading"))
      notes.push(scene(value.sceneIndex)+" is directed against its own heading's time. Either the heading or the direction is wrong and only you can say which, so nothing is proposed for it.");
    if(codes.has("time-contradicts-previous"))
      notes.push(scene(value.sceneIndex)+" is CONTINUOUS from "+scene(value.sceneIndex-1)+" and the two declare opposite times of day. Only you can say which is right, and no time-of-day edit is proposed that would carry the contradiction into another shot.");
    if(codes.has("wardrobe-contradicts-previous"))
      notes.push(scene(value.sceneIndex)+" is CONTINUOUS from "+scene(value.sceneIndex-1)+" and a character's wardrobe changes between them. Wardrobe belongs to the cast record, not to a shot's direction, so it is not repaired from here.");
    if(codes.has("wardrobe-unstated"))
      notes.push(scene(value.sceneIndex)+" has a character with no wardrobe stated. Wardrobe belongs to the cast record, not to a shot's direction, so it is not repaired from here.");
    if(codes.has("identity-unanchored"))
      notes.push(scene(value.sceneIndex)+" has a character with no retained reference image. That needs an image made or uploaded, which no direction edit can do.");
    if(codes.has("handoff-absent"))
      notes.push(scene(value.sceneIndex)+" has shots that do not start from the frame before them. Carrying the approved last frame forward is a choice about rendering, and the studio does not make it for you.");
    if(codes.has("source-stale"))
      notes.push(scene(value.sceneIndex)+" has a saved direction whose shot changed. Review that shot before any continuity repair is trusted.");
  }
  // HV-021-08: across a CONTINUOUS heading, holding a scene's time to its own first shot can make it
  // contradict its neighbour in a shot that agreed before. Those scenes keep their times as they are.
  const held=continuousTimeHeld(report,edits),dropped=new Set(edits.filter(edit=>edit.field==="timeOfDay"&&held.has(edit.sceneIndex)).map(edit=>edit.sceneIndex));
  for(const index of [...dropped].sort((a,b)=>a-b))
    notes.push(scene(index)+"'s time of day is not held to its first shot: next to a CONTINUOUS heading, that would make it contradict the scene it meets in a shot that agrees now.");
  for(let index=edits.length-1;index>=0;index--)if(edits[index]!.field==="timeOfDay"&&held.has(edits[index]!.sceneIndex))edits.splice(index,1);
  // HV-021-04: the old message said "Fix a scene at a time", which is not something a creator can do
  // -- review is all-or-nothing across the film and there is no per-scene repair route. It says what
  // is true instead: the report is still there, and it names the scenes.
  if(edits.length>CONTINUITY_REPAIR_LIMIT)
    throw new Error("This film's declared look drifts in "+edits.length+" places, more than the "+CONTINUITY_REPAIR_LIMIT
      +" one repair carries. The continuity report beside this names every scene; settle the look in the direction panel and read it again.");
  edits.sort((a,b)=>a.shotId.localeCompare(b.shotId,"en-US",{numeric:true})||CONTINUITY_LOOK_FIELDS.indexOf(a.field)-CONTINUITY_LOOK_FIELDS.indexOf(b.field));
  const data={schema:"hv-continuity-repair/1" as const,reportRevision:report.revision,castingRevision:report.castingRevision,
    directionRevision:report.directionRevision,sourcePlanHash:report.sourcePlanHash,edits,notes,refused:[...refused].sort()};
  return {...data,revision:contentHash(data)};
}
/**
 * One line a creator can read before accepting: what changes, where, and to what.
 *
 * HV-021-04: "Nothing in this film's declared look contradicts itself" was said whenever there were
 * no edits -- including for a film whose only defect is a scene directed against its own heading,
 * which this repair deliberately proposes nothing for. The report held a warning and the headline
 * said there was none. An empty proposal that carries notes now says which of the two it is.
 */
export function continuityRepairSummary(proposal:ContinuityRepairProposal):string{
  // A contradiction this repair will not resolve is the only thing that makes the sentence below
  // untrue. An unknown -- a wardrobe nobody stated, a character with no reference image -- is not a
  // declared look contradicting itself, and saying it were would make the check one to dismiss.
  const contradictions=proposal.refused.filter(code=>CONTINUITY_REPAIR_CONTRADICTIONS.includes(code));
  /** The contradictions named, and what to do about them, written once for both halves below. */
  const named=()=>inWords(contradictions.map(code=>CONTINUITY_REPAIR_CONTRADICTION_WORDS[code]??code))+". Read the notes.";
  if(!proposal.edits.length)
    return contradictions.length
      ?"Nothing here can be repaired automatically: "+named()
      :"Nothing in this film's declared look contradicts itself.";
  const shots=new Set(proposal.edits.map(edit=>edit.shotId)),fields=new Set(proposal.edits.map(edit=>LOOK_LABELS[edit.field]));
  const repair="Hold "+[...fields].join(", ")+" across "+shots.size+(shots.size===1?" shot":" shots")+", matching the first shot that states each.";
  /**
   * HV-021-05: and a contradiction is said whether or not there is anything to repair beside it.
   *
   * `contradictions` was computed above and then consulted only inside the branch above -- so a film
   * with a repairable drift in one scene and a scene directed against its own heading in another got
   * a headline about the drift and nothing about the contradiction. That is the same defect HV-021-04
   * was written to close, on its other branch, and it is the worse half: a creator who accepts this
   * has applied the repair and has every reason to believe the continuity pass is done.
   */
  return contradictions.length?repair+" What is left cannot be repaired automatically: "+named():repair;
}
