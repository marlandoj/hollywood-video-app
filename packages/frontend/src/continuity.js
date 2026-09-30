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
  "source-stale":"A saved direction's shot has changed",
  "wardrobe-unstated":"No wardrobe is stated",
  "identity-unanchored":"A character has no reference image",
  "handoff-absent":"Shots do not start from the frame before them",
};
const FIELDS={timeOfDay:"time of day",keyLight:"key light",fillLight:"fill light",backLight:"back light",motivatedSources:"motivated sources"};
const count=(n,word)=>n+" "+word+(n===1?"":"s");

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
  function drawReport(value){
    report.replaceChildren();
    if(!value){totals.textContent="The continuity report is not available. Reload the shot plan.";return;}
    const scenes=value.scenes.filter(scene=>scene.findings.length),t=value.totals,found=t.warnings+t.unknowns+t.notes;
    const compared=t.lookComparisons+t.wardrobeComparisons+t.handoffComparisons;
    if(!found){
      // An empty report of a film that declares nothing is not a pass (docs/CONTINUITY.md), so it does not say "agree".
      totals.textContent=compared?"Nothing to fix. The saved declarations agree with each other across "+count(compared,"comparison")+".":"Nothing to fix. Nothing is declared yet that could be compared, so this is not a pass.";
      return;
    }
    totals.textContent=[count(t.warnings,"warning"),count(t.unknowns,"unknown"),count(t.notes,"note")].join(" · ")+", in "+scenes.length+" of "+value.scenes.length+" scenes.";
    for(const scene of scenes){
      const group=node("details"),list=node("ul"),w=scene.findings.filter(f=>f.severity==="warning").length;
      group.open=scenes.length<=3||w>0;
      group.append(node("summary","Scene "+scene.sceneNumber+(scene.heading?" · "+scene.heading:"")+" · "+count(scene.findings.length,"finding")));
      for(const finding of scene.findings){
        const item=node("li");
        item.append(node("strong",(CONTINUITY_SEVERITY[finding.severity]??finding.severity)+": "+(CONTINUITY_KINDS[finding.code]??finding.code)),node("p",finding.message),node("p",(finding.shotIds.length===1?"Shot ":"Shots ")+finding.shotIds.join(", ")));
        list.append(item);
      }
      group.append(list);report.append(group);
    }
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
            for(const edit of edits)list.append(node("li","Shot "+edit.shotId+", "+(FIELDS[edit.field]??edit.field)+": from “"+edit.from+"” to “"+edit.to+"”"));
          }
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
    const desk=state(),maxShots=desk.maxShots,expectedVersion=desk.direction.version,directionRevision=desk.direction.revision;
    return run("Reviewing the continuity repair…",async()=>{
      reviewed=null;drawProposal(null);
      const result=await request("/continuity/repair",{method:"POST",body:{maxShots}});
      drawReport(result.report);
      if(!result.proposal){drawProposal(result);return tell("No repair can be made: "+(result.unavailable||"the server gave no reason."),true);}
      // The version sent on apply is the desk's. If the desk is behind the film the proposal was
      // read from, that version is not the one the proposal belongs to, so the desk reloads first.
      if(result.proposal.directionRevision!==directionRevision){
        drawProposal(null);tell("The direction changed since the desk loaded, so the report has been reloaded. Review the repair again.",true);
        return reload();
      }
      reviewed={proposal:result.proposal,expectedVersion,expectedScriptVersion:result.scriptVersion,maxShots};drawProposal(result);
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
        tell("The direction changed since this repair was reviewed, so nothing was applied. The report has been reloaded; review the repair again.",true);
        return reload();
      }
      reviewed=null;drawProposal(null);
      await accepted(result.direction.version);
      tell("Continuity repair applied as direction version "+result.direction.version+". The report above is the new one. Create a new preview to see it.");
    });
  }
  /** The desk redrew from a new `GET /direction`. A review of an older direction is set aside. */
  function render(){
    const value=state();drawReport(value?.continuity);
    if(reviewed&&!busy&&reviewed.proposal.directionRevision!==value?.direction.revision){reviewed=null;drawProposal(null);tell("The direction changed, so the reviewed repair was set aside. Review it again.",true);}
    sync();
  }
  return {render,get unsaved(){return busy;}};
}
