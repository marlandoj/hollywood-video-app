import {contentHash} from "../../generator/src/capabilities";
import {CONTINUITY_LOOK_FIELDS,type ContinuityLookField,type ContinuityReport} from "./continuity";

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
export const CONTINUITY_REPAIR_CONTRADICTIONS=["time-contradicts-heading"] as const as readonly string[];
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
    for(const field of CONTINUITY_LOOK_FIELDS){
      const declared=value.packets.filter(packet=>norm(packet.look[field]));
      if(declared.length<2)continue;
      const hold=declared[0]!;
      for(const packet of declared.slice(1))if(norm(packet.look[field])!==norm(hold.look[field]))
        edits.push({shotId:packet.shotId,sceneIndex:value.sceneIndex,field,from:packet.look[field],to:hold.look[field]});
    }
    const codes=new Set(value.findings.map(finding=>finding.code));
    for(const code of codes)if(code!=="look-changed")refused.add(code);
    // What is seen and deliberately not proposed. A repair that stays silent about the rest reads as
    // though the rest were fine.
    if(codes.has("time-contradicts-heading"))
      notes.push(scene(value.sceneIndex)+" is directed against its own heading's time. Either the heading or the direction is wrong and only you can say which, so nothing is proposed for it.");
    if(codes.has("wardrobe-unstated"))
      notes.push(scene(value.sceneIndex)+" has a character with no wardrobe stated. Wardrobe belongs to the cast record, not to a shot's direction, so it is not repaired from here.");
    if(codes.has("identity-unanchored"))
      notes.push(scene(value.sceneIndex)+" has a character with no retained reference image. That needs an image made or uploaded, which no direction edit can do.");
    if(codes.has("handoff-absent"))
      notes.push(scene(value.sceneIndex)+" has shots that do not start from the frame before them. Carrying the approved last frame forward is a choice about rendering, and the studio does not make it for you.");
    if(codes.has("source-stale"))
      notes.push(scene(value.sceneIndex)+" has a saved direction whose shot changed. Review that shot before any continuity repair is trusted.");
  }
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
  const named=()=>contradictions.join(", ")+". Read the notes.";
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
