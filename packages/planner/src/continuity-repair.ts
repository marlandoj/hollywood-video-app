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
const LOOK_LABELS:Record<ContinuityLookField,string>={timeOfDay:"time of day",keyLight:"key light",fillLight:"fill light",backLight:"back light",motivatedSources:"motivated sources"};
export interface ContinuityRepairEdit {shotId:string;sceneIndex:number;field:ContinuityLookField;from:string;to:string}
export interface ContinuityRepairProposal {
  schema:"hv-continuity-repair/1";
  /** Bound to the report it was read from, and to the same three inputs that report was computed from. */
  reportRevision:string;castingRevision:string;directionRevision:string;sourcePlanHash:string;
  edits:ContinuityRepairEdit[];notes:string[];revision:string;
}
const norm=(value:string)=>value.trim().replace(/\s+/g," ").toLocaleLowerCase("en-US");
const scene=(index:number)=>"Scene "+(index+1);
/**
 * The value a scene holds is the one its first declaring shot states. The Supervisor does not choose
 * between two looks on its own merits: it makes the scene agree with the shot the creator set first.
 */
export function continuityRepair(report:ContinuityReport):ContinuityRepairProposal{
  const edits:ContinuityRepairEdit[]=[],notes:string[]=[],stale=new Set(report.staleShotIds);
  for(const value of report.scenes){
    const live=value.packets.filter(packet=>!stale.has(packet.shotId));
    for(const field of CONTINUITY_LOOK_FIELDS){
      const declared=live.filter(packet=>norm(packet.look[field]));
      if(declared.length<2)continue;
      const hold=declared[0]!;
      for(const packet of declared.slice(1))if(norm(packet.look[field])!==norm(hold.look[field]))
        edits.push({shotId:packet.shotId,sceneIndex:value.sceneIndex,field,from:packet.look[field],to:hold.look[field]});
    }
    const codes=new Set(value.findings.map(finding=>finding.code));
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
  if(edits.length>CONTINUITY_REPAIR_LIMIT)throw new Error("This film has more continuity drift than one repair can carry. Fix a scene at a time.");
  edits.sort((a,b)=>a.shotId.localeCompare(b.shotId,"en-US",{numeric:true})||CONTINUITY_LOOK_FIELDS.indexOf(a.field)-CONTINUITY_LOOK_FIELDS.indexOf(b.field));
  const data={schema:"hv-continuity-repair/1" as const,reportRevision:report.revision,castingRevision:report.castingRevision,
    directionRevision:report.directionRevision,sourcePlanHash:report.sourcePlanHash,edits,notes};
  return {...data,revision:contentHash(data)};
}
/** One line a creator can read before accepting: what changes, where, and to what. */
export function continuityRepairSummary(proposal:ContinuityRepairProposal):string{
  if(!proposal.edits.length)return "Nothing in this film's declared look contradicts itself.";
  const shots=new Set(proposal.edits.map(edit=>edit.shotId)),fields=new Set(proposal.edits.map(edit=>LOOK_LABELS[edit.field]));
  return "Hold "+[...fields].join(", ")+" across "+shots.size+(shots.size===1?" shot":" shots")+", matching the first shot that states each.";
}
