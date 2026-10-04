/**
 * HV-021-07: the Continuity Supervisor's report and its one repair, on the Director's desk.
 *
 * `GET /direction` has carried the continuity report since HV-021-01 and the repair routes have
 * existed since HV-021-02, and nothing in the studio showed either. This panel reads the report,
 * reviews the repair, and applies exactly the edits the creator reviewed. Every server string is
 * assigned as DOM text.
 */
import {whileBusy} from "./busy.js";

/** A severity in words. The report's own order is warning, unknown, note. */
export const CONTINUITY_SEVERITY={warning:"Warning",unknown:"Unknown",note:"Note"};
/** What each finding code means, in a line a creator reads. The server's message follows it. */
export const CONTINUITY_KINDS={
  "look-changed":"The look changes within the scene",
  "time-contradicts-heading":"A shot's time of day contradicts the scene heading",
  "time-contradicts-previous":"A CONTINUOUS scene's time of day contradicts the scene before it",
  "wardrobe-contradicts-previous":"A character's wardrobe changes across a CONTINUOUS heading",
  "boundary-look-changed":"The light changes across a sequence boundary in the same place",
  "source-stale":"A saved direction's shot has changed",
  "wardrobe-unstated":"No wardrobe is stated",
  "identity-unanchored":"A character has no reference image",
  "handoff-absent":"Shots do not start from the frame before them",
};
const FIELDS={timeOfDay:"time of day",keyLight:"key light",fillLight:"fill light",backLight:"back light",motivatedSources:"motivated sources"};
const count=(n,word)=>n+" "+word+(n===1?"":"s");
const inWords=items=>items.length<2?items.join(""):items.slice(0,-1).join(", ")+" and "+items.at(-1);
/** HV-021-11: where a finding or an edit sits on a feature's sequence boundary, in words. */
const atBoundary=boundary=>boundary?" (where sequence "+boundary.from+" meets sequence "+boundary.to+")":"";
/**
 * HV-021-11: one line per sequence boundary of a feature, so the report says what it did at each,
 * including that it compared nothing where story time may pass.
 */
export function boundaryLine(boundary){
  const where="Sequence "+boundary.from+" to "+boundary.to+", scene "+boundary.lastScene+" to scene "+boundary.firstScene+": ";
  if(!boundary.continuous)return where+"not compared. Scene "+boundary.firstScene+" is not CONTINUOUS, so story time may pass between the two.";
  if(!boundary.comparisons)return where+"CONTINUOUS, but nothing is declared on both sides to compare.";
  return where+"CONTINUOUS"+(boundary.sameLocation?", in the same place":"")+"; "+count(boundary.comparisons,"comparison")+", "+(boundary.findings?count(boundary.findings,"finding")+".":"nothing contradicts.");
}
/**
 * HV-021-11: the sequences a repair sends back for a new rough cut (`continuityRepairRemakes`), in a
 * sentence. Empty when there are none.
 */
export function remakeSentence(remake,applied){
  if(!remake?.length)return "";
  const names=remake.map((entry,index)=>(index?"sequence ":"Sequence ")+entry.sequence+(entry.touched?" (changed by this repair)":""));
  return inWords(names)+(remake.length===1?(applied?" was":" is"):(applied?" were":" are"))+" made under the "+(applied?"earlier":"current")+" shot directions, so "
    +(remake.length===1?"it":"each")+(applied?" needs":" will need")+" a new rough cut before its final.";
}
/**
 * A reviewed repair belongs to the desk only while the desk shows the same film: the same report,
 * the same direction and the same screenplay version. The report's revision covers the shot plan,
 * cast and direction; a screenplay save that leaves the shots alone still moves `scriptVersion`,
 * which the accept route checks, so that is compared too.
 */
const sameFilm=(proposal,scriptVersion,desk)=>Boolean(desk?.continuity&&proposal.reportRevision===desk.continuity.revision
  &&proposal.directionRevision===desk.direction?.revision&&scriptVersion===desk.scriptVersion);

/**
 * `state()` is the desk's last `GET /direction`. `accepted(version)` and `reload()` reload it and
 * redraw the desk, which calls `render()` here. `canEdit()` is false while another edit is open.
 */
export function initContinuity({parent,request,state,canEdit,accepted,reload}){
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const button=(label,action,primary=false)=>{const e=node("button",label);e.type="button";e.className=primary?"":"secondary";e.onclick=action;return e;};
  const section=node("section"),title=node("h3","Continuity"),totals=node("p"),report=node("div"),actions=node("div"),proposalView=node("div"),status=node("p");
  title.id="continuity-title";section.setAttribute("aria-labelledby",title.id);actions.className="result-actions";proposalView.hidden=true;
  status.className="status";status.setAttribute("role","status");
  /** The proposal the creator reviewed, and the versions it was reviewed under. Applying sends these and nothing else. */
  let reviewed=null,busy=false;
  const tell=(text,error=false)=>{status.textContent=text;status.dataset.state=error?"error":"success";};
  const review=button("Review continuity repair",()=>reviewRepair());
  const apply=button("Apply continuity repair",()=>applyRepair(),true);
  const discard=button("Discard repair review",()=>{if(busy)return;reviewed=null;drawProposal(null);tell("Repair review discarded. Nothing was changed.");});
  actions.append(review,apply,discard);
  section.append(title,node("p","Checks the saved screenplay, cast and shot directions against each other. It reads no pictures, so a clean report means the declarations agree, not that the shots will match."),totals,report,actions,proposalView,status);
  parent.append(section);

  function sync(){
    const edits=reviewed?.proposal.edits.length??0;
    review.disabled=busy||!state()?.continuity;apply.hidden=!edits;apply.disabled=busy||!edits;discard.hidden=!reviewed&&proposalView.hidden;discard.disabled=busy;
  }
  function drawBoundaries(value){
    if(!value.boundaries?.length)return;
    const group=node("details"),list=node("ul"),found=value.boundaries.reduce((total,boundary)=>total+boundary.findings,0);
    group.open=found>0;
    group.append(node("summary","Sequence boundaries ("+value.boundaries.length+") · "+count(found,"finding")));
    for(const boundary of value.boundaries)list.append(node("li",boundaryLine(boundary)));
    group.append(list);report.append(group);
  }
  function drawReport(value){
    report.replaceChildren();
    if(!value){totals.textContent="The continuity report is not available. Reload the shot plan.";return;}
    const scenes=value.scenes.filter(scene=>scene.findings.length),t=value.totals,found=t.warnings+t.unknowns+t.notes;
    // HV-021-10: comparisons across a CONTINUOUS heading count too, or a film whose only declarations
    // meet across one would be told nothing is declared.
    const compared=t.lookComparisons+t.wardrobeComparisons+t.handoffComparisons+t.continuousComparisons;
    if(!found){
      // An empty report of a film that declares nothing is not a pass (docs/CONTINUITY.md), so it does not say "agree".
      totals.textContent=compared?"Nothing to fix. The saved declarations agree with each other across "+count(compared,"comparison")+".":"Nothing to fix. Nothing is declared yet that could be compared, so this is not a pass.";
      drawBoundaries(value);
      return;
    }
    totals.textContent=[count(t.warnings,"warning"),count(t.unknowns,"unknown"),count(t.notes,"note")].join(" · ")+", in "+scenes.length+" of "+value.scenes.length+" scenes.";
    for(const scene of scenes){
      const group=node("details"),list=node("ul"),w=scene.findings.filter(f=>f.severity==="warning").length;
      group.open=scenes.length<=3||w>0;
      const opens=scene.findings.find(finding=>finding.sequenceBoundary)?.sequenceBoundary;
      group.append(node("summary","Scene "+scene.sceneNumber+(scene.heading?" · "+scene.heading:"")+(opens?" · opens sequence "+opens.to:"")+" · "+count(scene.findings.length,"finding")));
      for(const finding of scene.findings){
        const item=node("li");
        item.append(node("strong",(CONTINUITY_SEVERITY[finding.severity]??finding.severity)+": "+(CONTINUITY_KINDS[finding.code]??finding.code)+atBoundary(finding.sequenceBoundary)),node("p",finding.message),node("p",(finding.shotIds.length===1?"Shot ":"Shots ")+finding.shotIds.join(", ")));
        list.append(item);
      }
      group.append(list);report.append(group);
    }
    drawBoundaries(value);
  }
  function drawProposal(result){
    proposalView.replaceChildren();proposalView.hidden=!result;
    if(result){
      proposalView.append(node("h4","Proposed continuity repair"));
      if(!result.proposal)proposalView.append(node("p","No repair can be made: "+(result.unavailable||"the server gave no reason.")));
      else {
        const {proposal}=result;
        proposalView.append(node("p",result.summary??""));
        if(proposal.edits.length){
          proposalView.append(node("p","Applying makes "+count(proposal.edits.length,"change")+" to saved shot directions, and nothing else. Nothing has changed yet."));
          const scenes=new Map();for(const edit of proposal.edits){if(!scenes.has(edit.sceneIndex))scenes.set(edit.sceneIndex,[]);scenes.get(edit.sceneIndex).push(edit);}
          for(const [sceneIndex,edits]of scenes){
            const list=node("ul");proposalView.append(node("h5","Scene "+(sceneIndex+1)),list);
            for(const edit of edits)list.append(node("li","Shot "+edit.shotId+", "+(FIELDS[edit.field]??edit.field)+": from “"+edit.from+"” to “"+edit.to+"”"+atBoundary(edit.sequenceBoundary)));
          }
          // HV-021-11: what applying sends back for a new rough cut, said before it is applied.
          const remake=remakeSentence(result.remake,false);if(remake)proposalView.append(node("p",remake));
        }else proposalView.append(node("p","There is nothing to apply."));
        if(proposal.notes.length){const notes=node("ul");for(const note of proposal.notes)notes.append(node("li",note));proposalView.append(node("h5","Left for you to decide"),notes);}
      }
    }
    sync();
  }
  async function run(message,action){
    if(busy)return;busy=true;sync();tell(message);
    try{await whileBusy(section,action);}
    catch(error){tell(error.message||"The continuity request failed. Nothing was changed.",true);}
    finally{busy=false;sync();}
  }
  function reviewRepair(){
    if(busy)return;if(!canEdit())return tell("Save or cancel the open shot edit before reviewing a continuity repair.",true);
    const maxShots=state().maxShots;
    return run("Reviewing the continuity repair…",async()=>{
      reviewed=null;drawProposal(null);
      const result=await request("/continuity/repair",{method:"POST",body:{maxShots}});
      drawReport(result.report);
      if(!result.proposal){drawProposal(result);return tell("No repair can be made: "+(result.unavailable||"the server gave no reason."),true);}
      // Compared with the desk as it is now, not as it was when the button was pressed: the desk
      // can reload while the review is out. The versions sent on apply are the desk's, so a
      // proposal read from any other film is not offered; the desk reloads and the creator reviews again.
      const desk=state();
      if(!sameFilm(result.proposal,result.scriptVersion,desk)){
        drawProposal(null);tell("The film changed while the repair was being reviewed, so the report has been reloaded. Review the repair again.",true);
        return reload();
      }
      reviewed={proposal:result.proposal,expectedVersion:desk.direction.version,expectedScriptVersion:result.scriptVersion,maxShots};drawProposal(result);
      tell(result.proposal.edits.length?"Review the "+count(result.proposal.edits.length,"change")+" below. Nothing has been applied.":"This repair has nothing to apply. Nothing was changed.");
    });
  }
  function applyRepair(){
    if(busy||!reviewed?.proposal.edits.length)return;
    if(!canEdit())return tell("Save or cancel the open shot edit before applying the continuity repair.",true);
    const held=reviewed;
    return run("Applying the continuity repair…",async()=>{
      let result;
      try{result=await request("/continuity/repair/accept",{method:"POST",body:{edits:held.proposal.edits,expectedVersion:held.expectedVersion,expectedScriptVersion:held.expectedScriptVersion,maxShots:held.maxShots}});}
      catch(error){
        if(error.status!==409)throw error;
        // Not retried: what the creator reviewed is no longer what the server would apply.
        reviewed=null;drawProposal(null);
        // The server's own reason: the screenplay, the direction or the edits, whichever moved.
        tell("Nothing was applied. "+(error.message||"The film changed since this repair was reviewed.")+" The report has been reloaded; review the repair again.",true);
        return reload();
      }
      reviewed=null;drawProposal(null);
      await accepted(result.direction.version);
      const remake=remakeSentence(result.remake,true);
      tell("Continuity repair applied as direction version "+result.direction.version+". The report above is the new one. "+(remake||"Create a new preview to see it."));
    });
  }
  /** The desk redrew from a new `GET /direction`. A review of any other film is set aside. */
  function render(){
    const value=state();drawReport(value?.continuity);
    if(reviewed&&!busy&&!sameFilm(reviewed.proposal,reviewed.expectedScriptVersion,value)){reviewed=null;drawProposal(null);tell("The film changed, so the reviewed repair was set aside. Review it again.",true);}
    sync();
  }
  return {render,get unsaved(){return busy;}};
}
