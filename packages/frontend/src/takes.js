import {takePlayer} from "./take-player.js";
/** Saved source context is fixed until the creator explicitly starts a new group. */
import {linePerformances} from "./performances.js";
import {pictureShotEditor,showPictureReviews} from "./picture-performance.js";
export function initTakes({parent,request,prepareGeneration,prepare,state,canEdit,adopted,assetUrl}) {
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const button=(label,action)=>{const e=node("button",label);e.type="button";e.className="secondary";e.onclick=action;return e;};
  const panel=node("section"),title=node("h3","Compare shot takes"),source=node("p"),status=node("p"),form=node("form"),builder=node("details"),cards=node("div"),quoteBox=node("div"),history=node("div"),viewer=node("div"),groupChoice=node("select"),count=node("select");builder.open=true;builder.append(node("summary","Set up take alternatives"),form);
  panel.className="take-workbench";panel.hidden=true;status.className="status";status.setAttribute("role","status");cards.className="take-grid";groupChoice.setAttribute("aria-label","Saved take group");count.setAttribute("aria-label","Number of takes");count.append(new Option("Two takes","2"),new Option("Three takes","3"));count.value="3";
  let shot=null,base=null,context=null,busy=false,dirty=false,groups=[],quote=null,player=null,timer,selectedGroup=null,selectedTake="take-a",renderedKey="";const inputs=[];
  const tell=(text,error=false)=>{status.textContent=text;status.dataset.state=error?"error":"success";};
  const allowed=()=>{if(!canEdit())throw new Error("Save or cancel the shot edit before working with takes.");};
  async function run(action){if(busy)return;busy=true;const controls=[...panel.querySelectorAll("button,input,select")],disabled=controls.map(e=>e.disabled);controls.forEach(e=>{e.disabled=true;});try{return await action();}catch(error){tell(error.message||"The take action could not finish. Refresh and try again.",true);}finally{busy=false;controls.forEach((e,i)=>e.disabled=disabled[i]);}}
  function field(parent,caption,value,type,min,max){const label=node("label",caption),input=node("input");input.type=type;input.value=value;input.required=true;if(type==="number"){input.min=min;input.max=max;input.step="1";}else input.maxLength=80;label.append(input);parent.append(label);return input;}
  for(let i=0;i<3;i++){
    const card=node("fieldset"),label="Take "+"ABC"[i];card.append(node("legend",label));
    const values={label:field(card,label+" label",label,"text"),seed:field(card,label+" seed",7000+i,"number",0,2147483647),lensMm:field(card,label+" focal length in mm",[35,50,85][i],"number",8,1000),frames:field(card,label+" duration in frames (blank = automatic)",120,"number",30,900)};
    const motionLabel=node("label",label+" storyboard motion"),motion=node("select");for(const [value,text]of [["static","Static"],["push-in","Push in"],["pull-out","Pull out"],["pan-left","Pan left"],["pan-right","Pan right"]])motion.append(new Option(text,value));motionLabel.append(motion);card.append(motionLabel);values.frames.required=false;values.motion=motion;values.lines=linePerformances(card,invalidate);values.picture=pictureShotEditor(card,invalidate);values.card=card;inputs.push(values);cards.append(card);
  }
  function invalidate(){dirty=true;quote=null;quoteBox.replaceChildren();estimateButton.className="";tell("Take draft changed. Review a fresh estimate before rendering.");}
  count.onchange=()=>{inputs[2].card.hidden=count.value==="2";for(const input of inputs[2].card.querySelectorAll("input,select"))input.disabled=count.value==="2";invalidate();};
  form.addEventListener("input",invalidate);form.addEventListener("submit",e=>{e.preventDefault();estimateDraft();});
  const estimateButton=node("button","Estimate preview takes");estimateButton.type="submit";form.append(node("p","Step 1 of 3 · Set up two or three alternatives. Each inherits this shot’s saved framing, camera path, anchors, lighting and performance. The values below change only the take group."),count,cards,estimateButton);
  function draft(){return {shotId:shot.source.id,sourceHash:shot.sourceHash,takes:inputs.slice(0,Number(count.value)).map(v=>({label:v.label.value,seed:Number(v.seed.value),settings:{...base,...v.lines.read(),...v.picture.read(),lensMm:Number(v.lensMm.value),durationFrames:v.frames.value===""?null:Number(v.frames.value),previewMove:v.motion.value}}))};}
  const versions=()=>({expectedScriptVersion:context.scriptVersion,expectedCastingVersion:context.castingVersion,expectedDirectionVersion:context.directionVersion});
  async function estimateDraft(){if(!form.reportValidity())return;await run(async()=>{allowed();await prepare();tell("Estimating preview takes…");const body={settings:draft(),stage:"take-preview",...versions()};showQuote(await request("/quote",{method:"POST",body}),body);});}
  function showQuote(value,body){quote={value,body};estimateButton.className="secondary";quoteBox.replaceChildren(node("h4","Step 2 of 3 · Review generation cost"),node("p","Estimated provider cost: $"+value.minimumEstimateUsd.toFixed(3)+"–$"+value.maximumEstimateUsd.toFixed(3)+". The group cap including retries is $"+value.costCapUsd.toFixed(2)+"; each take is capped at $"+value.perTakeCapUsd.toFixed(2)+"."));
    const start=button(body.stage==="take-final"?"Approve and render final takes":"Render preview takes",()=>run(async()=>{allowed();const reviewed=quote;if(!reviewed)throw new Error("The take settings changed. Review a fresh estimate.");await prepareGeneration();
      if(body.stage==="take-final")await request("/"+body.animaticJobId+"/decision",{method:"POST",body:{decision:"approved"}});
      const admitted=await request("",{method:"POST",body:{...reviewed.body,providerPlanRevision:reviewed.value.providerPlanRevision,generationApproved:true}});selectedGroup=admitted.jobId;quote=null;quoteBox.replaceChildren();dirty=false;builder.open=false;await load();tell("Step 3 of 3 · Take group queued. Each alternative will appear here when the group finishes.");}));start.className="";quoteBox.append(start);tell("Estimate ready. Review the cap before rendering.");
  }
  function showGroup(){player?.destroy();player=null;viewer.replaceChildren();const job=groups.find(j=>j.id===groupChoice.value);if(!job)return;selectedGroup=job.id;
    renderedKey=job.id+":"+job.status+":"+job.checkpointShots;
    viewer.append(node("p",(job.stage==="take-preview"?"Preview":"Final")+" group · direction "+job.directionVersion+" · "+job.status+" · "+job.checkpointShots+" / "+job.shotTakes.takes.length+" takes completed"));
    if(job.status!=="done"){viewer.append(node("p",job.failureReason||job.cancelReason||"Generation is in progress. You can refresh this group without changing your draft."));return;}
    // HV-029-04: a finished group whose cast permission has been withdrawn
    // keeps its clip rows and loses their private media links.
    if(job.mediaUnavailable||job.takeClips.some(clip=>!clip.mp4Url)){viewer.append(node("p",job.mediaUnavailable||"This take group is no longer available."));return;}
    player=takePlayer({parent:viewer,clips:job.takeClips,assetUrl,selected:selectedTake,select:id=>{selectedTake=id;}});
    showPictureReviews(viewer,job);
    const actions=node("div");actions.className="result-actions";
    actions.append(button("Adopt selected take direction",()=>run(async()=>{allowed();if(dirty)throw new Error("Render or discard your edited take draft before adopting a result.");await prepare();player?.pause();const result=await request("/"+job.id+"/adopt",{method:"POST",body:{takeId:selectedTake,expectedScriptVersion:context.scriptVersion,expectedDirectionVersion:context.directionVersion}});await adopted(result.direction.version);await load();tell("Adopted "+job.takeClips.find(c=>c.id===selectedTake).label+" as direction version "+result.direction.version+". Create a new full-film preview to review this choice in the cut.");})));
    if(job.stage==="take-preview")actions.append(button("Estimate final take group",()=>run(async()=>{allowed();if(dirty)throw new Error("Render or discard the take draft before reviewing a saved group.");await prepare();player?.pause();const settings={shotId:job.shotTakes.source.id,sourceHash:job.shotTakes.sourceHash,takes:job.shotTakes.takes.map(({label,seed,settings})=>({label,seed,settings}))},body={settings,stage:"take-final",animaticJobId:job.id,...versions()};
      if(job.scriptVersion!==context.scriptVersion||job.castingVersion!==context.castingVersion||job.directionVersion!==context.directionVersion)throw new Error("The screenplay, cast or direction changed. Start a new preview take group before final rendering.");showQuote(await request("/quote",{method:"POST",body}),body);})));viewer.append(actions);
  }
  groupChoice.onchange=()=>{quote=null;quoteBox.replaceChildren();showGroup();};
  /**
   * HV-039-08: the status check runs beside the creator, not in their way. It used to go through
   * `run`, which disabled every control in the panel and set `busy` for each 2.5-second check. While
   * a group rendered, that dropped keystrokes typed into the take draft every 2.5 seconds and moved
   * focus off a disabled field. A click on Estimate, Render or Adopt that landed during a check was
   * refused by `if(busy)return` with nothing said. The check now changes only what it reports, and
   * waits while the creator's own action runs.
   */
  let checking=false;
  const poll=()=>{clearTimeout(timer);if(panel.hidden)return;timer=setTimeout(async()=>{if(busy||checking)return poll();checking=true;try{await load(false);}catch(error){tell((error.message||"The take status check failed.")+" Use Refresh take groups to try again.",true);}finally{checking=false;}},2500);};
  async function load(refreshPlayer=true){clearTimeout(timer);if(!shot)return;const result=await request("?shotId="+encodeURIComponent(shot.source.id));context={scriptVersion:result.scriptVersion,castingVersion:result.castingVersion,directionVersion:result.directionVersion};groups=result.groups;
    // The same groups in the same order keep their options, so an open list is not closed under the
    // pointer by a status check; only a label whose words changed is written.
    const labels=groups.map(job=>(job.stage==="take-preview"?"Preview":"Final")+" · "+job.status+" · "+job.id.slice(0,8)),options=[...groupChoice.children];
    if(options.length===groups.length&&options.every((option,i)=>option.value===groups[i].id))options.forEach((option,i)=>{if(option.textContent!==labels[i])option.textContent=labels[i];});
    else{groupChoice.replaceChildren();groups.forEach((job,i)=>groupChoice.append(new Option(labels[i],job.id)));}
    if(groups.some(j=>j.id===selectedGroup))groupChoice.value=selectedGroup;history.hidden=!groups.length;const selected=groups.find(j=>j.id===groupChoice.value);if(refreshPlayer||!selected||renderedKey!==selected.id+":"+selected.status+":"+selected.checkpointShots)showGroup();
    if(!panel.hidden&&groups.some(j=>["queued","running"].includes(j.status)))poll();
    else if(groups.find(j=>j.id===selectedGroup)?.status==="done")tell("Step 3 of 3 · Take group ready. Compare the results, then adopt your selected direction.");
  }
  function reset(plan){shot=plan;const current=state();base=structuredClone(current.direction.entries.find(e=>e.source.id===plan.source.id)?.settings??current.defaults);source.textContent=plan.source.id+": "+plan.source.prompt;
    inputs.forEach((v,i)=>{v.label.value="Take "+"ABC"[i];v.seed.value=String(((base.seed??7000)+i)%2147483648);v.lensMm.value=String([35,50,85][i]);v.frames.value=String(base.durationFrames??(plan.performanceLines?.length?"":Math.round(plan.durationSec*30)));v.motion.value=base.previewMove??"static";v.lines.fill(base,plan);v.picture.fill(base,plan);});dirty=false;quote=null;quoteBox.replaceChildren();
  }
  const toolbar=node("div");toolbar.className="result-actions";toolbar.append(button("Refresh take groups",()=>run(async()=>{await load();tell("Take groups refreshed. Your draft is unchanged.");})),button("Discard take draft",()=>{if(busy)return;const plan=state().plan.find(p=>p.source.id===shot?.source.id);if(plan){reset(plan);tell("Take draft reset from the saved shot direction.");}}),button("Close take comparison",()=>{if(busy)return;player?.pause();panel.hidden=true;clearTimeout(timer);}));
  const groupLabel=node("label","Saved take group");groupLabel.append(groupChoice);history.append(groupLabel,viewer);panel.append(title,source,toolbar,builder,quoteBox,history,status);parent.append(panel);
  return {get unsaved(){return busy||dirty;},pause(){player?.pause();clearTimeout(timer);},async open(plan){if(busy)return;if(dirty&&shot?.source.id!==plan.source.id){panel.hidden=false;tell("Render or discard this take draft before switching source shots.",true);return;}panel.hidden=false;await run(async()=>{allowed();if(!shot||shot.source.id!==plan.source.id)reset(plan);await load();tell(dirty?"Your take draft is preserved.":"Adjust alternatives, then estimate their preview cost.");});title.tabIndex=-1;title.focus();}};
}
