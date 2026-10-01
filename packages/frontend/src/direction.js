import {linePerformances} from "./performances.js";
import {pictureShotEditor} from "./picture-performance.js";
import {initFrameAnchors} from "./frame-anchors.js";
/** Private, source-bound shot direction editor. User content is assigned only as DOM text. */
import {initSceneCuts} from "./scene-cuts.js";
import {showCoverage} from "./coverage.js";
import {initViewfinder} from "./viewfinder.js";
import {initTakes} from "./takes.js";
import {initSubjectMotion} from "./subject-motion.js";
import {initContinuity} from "./continuity.js";
export function initDirection({panel,request,prepare,changed,assetUrl,image,takeRequest,prepareGeneration,motionDownload}) {
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const button=(label,action)=>{const e=node("button",label);e.type="button";e.className="secondary";e.onclick=action;return e;};
  const details=title=>{const e=node("details");e.append(node("summary",title));return e;};
  const title=node("h2","Shot direction"),summary=node("p"),status=node("p"),list=node("div"),form=node("form"),toolbar=node("div"),fields=new Map(),coverageFields=new Map(),coverageReview=details("Coverage findings and inventory");
  title.id="direction-title";panel.setAttribute("aria-labelledby",title.id);status.className="status";status.setAttribute("role","status");toolbar.className="result-actions";form.hidden=true;form.id="direction-editor";
  let state=null,editing=null,dirty=false,busy=false;
  // HV-039-06: where keyboard focus goes back to. Saving hides the form and rebuilds the shot list,
  // so the pressed button is gone and a browser drops focus to the page body, far from the desk.
  let opener=null,editOpener=null;const rowHeadings=new Map();
  /** Still on the page, shown and enabled: somewhere focus can usefully go. */
  const usable=element=>Boolean(element?.isConnected&&!element.hidden&&!element.disabled&&!element.closest?.("[hidden]"));
  /** The control the creator came from if it survived, else the shot's own row, else the desk. */
  function settle(shotId,from){
    if(usable(from))return from.focus();
    const target=(shotId&&rowHeadings.get(shotId))||title;
    // A row can sit in a collapsed scene or group of six; focus inside a closed <details> goes nowhere.
    for(let parent=target.parentElement;parent&&parent!==panel;parent=parent.parentElement)if(parent.localName==="details")parent.open=true;
    target.tabIndex=-1;target.focus();
  }
  const takePanel=node("div"),takes=initTakes({parent:takePanel,request:takeRequest,prepareGeneration,prepare,state:()=>state,canEdit:()=>!dirty&&!busy&&!subjectMotion.unsaved&&!sceneCuts.unsaved,assetUrl,adopted:async version=>{changed(version,true);state=await request("");render();}});
  const motionPanel=node("div"),subjectMotion=initSubjectMotion({parent:motionPanel,request,image,download:motionDownload,prepare,canEdit:()=>!dirty&&!busy&&!takes.unsaved&&!sceneCuts.unsaved,changed:async()=>{state=await request("");render();}});
  const cutPanel=node("div"),sceneCuts=initSceneCuts({parent:cutPanel,request,state:()=>state,canEdit:()=>!dirty&&!busy&&!takes.unsaved&&!subjectMotion.unsaved,accepted:async version=>{changed(version,true);state=await request("");render();}});
  // HV-021-07: the continuity report and its one repair. It reloads the desk the same way a scene cut does.
  const continuityPanel=node("div"),continuity=initContinuity({parent:continuityPanel,request,state:()=>state,canEdit:()=>!dirty&&!busy&&!takes.unsaved&&!subjectMotion.unsaved&&!sceneCuts.unsaved,
    accepted:async version=>{changed(version,true);state=await request("");render();},reload:async()=>{state=await request("");render();changed(state.direction.version,false);}});
  const tell=(text,error=false)=>{status.textContent=text;status.dataset.state=error?"error":"success";};
  function field(parent,key,label,kind="text",options) {
    const wrapper=node("div"),caption=node("label",label),input=node(kind==="select"?"select":kind==="textarea"?"textarea":"input");
    wrapper.className="cast-field";input.id="direction-"+key;caption.htmlFor=input.id;
    if(kind==="number"){input.type="number";input.min=options[0];input.max=options[1];input.step=options[2]??"any";}
    if(kind==="checkbox")input.type="checkbox";
    if(kind==="text"||kind==="textarea"){input.maxLength=options??600;if(kind==="textarea")input.rows=3;}
    if(kind==="select")for(const [value,text]of options)input.append(new Option(text,value));
    if(kind==="checkbox"){caption.className="attestation";caption.prepend(input);wrapper.append(caption);}else wrapper.append(caption,input);parent.append(wrapper);fields.set(key,input);return input;
  }
  const timing=node("fieldset");timing.append(node("legend","Timing and storyboard motion"));
  // HV-030-06: the contract allows 30 s, but the configured providers may render less. The API says
  // how much less, and the field says so too rather than letting a save through that admission refuses.
  const durationLimit=()=>Number(state?.durationLimitSec)>0?Number(state.durationLimitSec):30;
  const durationInput=field(timing,"durationSeconds","Duration in seconds (blank = automatic)","number",[1,durationLimit(),"any"]);
  field(timing,"previewMove","Storyboard motion","select",[["","Automatic"],["static","Static"],["push-in","Push in"],["pull-out","Pull out"],["pan-left","Pan left"],["pan-right","Pan right"]]);
  field(timing,"seed","Generation seed (blank = screenplay default)","number",[0,2147483647,1]);
  const timingNote=node("p");timing.append(timingNote);
  const describeTiming=()=>"Storyboard motion moves a still image. Duration is rounded to the nearest frame at 30 fps. A fixed duration must fit the dialogue; automatic duration can expand for temporary speech. This project's providers render at most "+durationLimit()+" seconds a shot; a longer shot has to be split into coverage.";
  timingNote.textContent=describeTiming();
  const currentSource=node("p"),oldSource=details("Previously directed source");form.append(node("h3","Edit this shot"),currentSource,oldSource,timing);
  const framing=details("Viewfinder and camera"),composition=details("Composition and lens intent"),motion=details("Camera movement and blocking"),lighting=details("Lighting plan"),performance=details("Performance and sound");
  const choiceLabels={size:"Shot size",angle:"Camera angle",lensType:"Lens type",movement:"Camera movement intent",screenDirection:"Screen direction"};
  const choiceFields={};for(const key of ["size","angle","lensType"])choiceFields[key]=field(composition,key,choiceLabels[key],"select",[]);
  field(composition,"heightM","Camera height in meters","number",[0,100]);field(composition,"lensMm","Focal length in mm","number",[8,1000]);
  const viewfinder=initViewfinder({parent:framing,assetUrl,direction:()=>({lensMm:fields.get("lensMm").value,durationFrames:fields.get("durationSeconds").value===""?null:Math.round(Number(fields.get("durationSeconds").value)*30)}),applyDirection:values=>{for(const [key,value]of Object.entries(values))if(fields.has(key))fields.get(key).value=value;},changed:()=>{dirty=true;},canEdit:()=>!busy});framing.append(composition);
  for(const key of ["movement","screenDirection"])choiceFields[key]=field(motion,key,choiceLabels[key],"select",[]);
  field(motion,"movementSpeed","Movement speed","text",80);field(motion,"blocking","Blocking","textarea",600);field(motion,"eyelines","Eyelines","textarea",400);
  for(const [key,label,limit]of [["keyLight","Key light",240],["fillLight","Fill light",240],["backLight","Back light",240],["motivatedSources","Motivated light sources",400],["timeOfDay","Time of day",80]])field(lighting,key,label,"text",limit);
  field(lighting,"temperatureK","Color temperature in kelvin","number",[1000,20000,1]);field(lighting,"contrastRatio","Key to fill contrast ratio","number",[1,100]);
  field(performance,"performance","Performance direction","textarea",600);field(performance,"soundIntent","Sound intent","textarea",400);field(performance,"transitionIntent","Transition intent","textarea",240);
  const lineEditor=linePerformances(performance,()=>{dirty=true;});
  const pictureEditor=pictureShotEditor(performance,()=>{dirty=true;});
  const coverage=details("Coverage and continuity"),coverageReport=node("div"),coverageRole=details("Role and subjects"),coverageAxis=details("Axis continuity"),coverageGaze=details("Eyeline matching");coverageRole.open=true;coverage.append(coverageRole,coverageAxis,coverageGaze);coverageReview.append(coverageReport);
  function coverageField(key,label,kind="text",options=80){const parent=["role","subjects"].includes(key)?coverageRole:key.startsWith("gaze")?coverageGaze:coverageAxis;const input=field(parent,"coverage-"+key,label,kind,options);fields.delete("coverage-"+key);coverageFields.set(key,input);return input;}
  for(const [key,label]of [["role","Coverage role"],["cameraSide","Camera side of axis"],["gazeDirection","Looking direction on screen"]])coverageField(key,label,"select",[]);
  coverageField("subjects","Shot subjects (one per line)","textarea",647);coverageField("axis","Continuity axis label");
  coverageField("gazeSubject","Looking subject");coverageField("gazeTarget","Looking target");
  coverageField("reestablish","This shot reestablishes or deliberately crosses the axis","checkbox");coverageField("continuityNote","Continuity explanation","textarea",400);
  coverage.append(node("p","Use the same axis label and side A/B for related shots in one scene. Match subject names to screenplay speakers for dialogue coverage. Explain deliberate axis changes. These declarations guide generation and advisory checks; they do not prove the rendered geometry."));
  const anchors=details("Frame anchors"),anchorEditor=initFrameAnchors({parent:anchors,request,image,context:()=>({state,shot:editing}),changed:()=>{dirty=true;},locked,tell});
  form.append(anchors,framing,motion,lighting,performance,coverage,node("p","Shot size, lens, lighting, movement and performance guide generation. The viewfinder crop or timed camera path is applied to the rendered pixels. Sound and transition notes remain intent; they do not create a mix or change the edit."));
  const save=node("button","Save shot direction");save.type="submit";const actions=node("div");actions.className="result-actions";
  actions.append(save,button("Cancel shot edit",()=>{const id=editing?.source.id;dirty=false;editing=null;form.hidden=true;tell("Shot edit cancelled.");settle(id,editOpener);}));form.append(actions);
  const history=details("Direction history"),historySelect=field(history,"historyVersion","Saved direction version","select",[]);fields.delete("historyVersion");
  history.append(node("p","Restore creates a new revision. Changed source shots must be reviewed before rendering. The 100 most recent direction versions are retained."),button("Restore directions",()=>{
    if(dirty)return tell("Save or cancel the shot edit before restoring.",true);return mutate(()=>request("/restore",{method:"POST",body:{expectedVersion:state.direction.version,version:Number(historySelect.value)}}));
  }));
  toolbar.append(button("Reload shot plan",()=>load(true)),button("Close shot editor",()=>{if(continuity.unsaved)return tell("Wait for the continuity repair to finish before closing the desk.",true);if(dirty||busy||subjectMotion.unsaved||sceneCuts.unsaved)return tell("Save or cancel the shot or movement edit first.",true);takes.pause();subjectMotion.close();panel.hidden=true;if(usable(opener))opener.focus();}));
  panel.append(title,node("p","Choose a shot to direct its timing, framing, lighting and performance. Saved edits require a new preview and approval. The editor follows the free 24-shot plan; an operator can use the 60-shot plan through the API."),summary,toolbar,cutPanel,coverageReview,continuityPanel,list,form,takePanel,motionPanel,history,status);
  const sourceText=source=>source.prompt+(source.dialogue.length?"\n"+source.dialogue.map(value=>value.character+": "+value.lines.join(" ")).join("\n"):"");
  const seconds=frames=>String(Number((frames/30).toFixed(3)));
  function settings(){const result={};for(const [key,input]of fields){if(key==="durationSeconds"){if(input.value!==""&&Number(input.value)>durationLimit())throw new Error("This project's providers render at most "+durationLimit()+" seconds a shot. Shorten this shot or split it into coverage.");result.durationFrames=input.value===""?null:Math.round(Number(input.value)*30);}else if(key==="seed"){if(input.value!=="")result.seed=Number(input.value);}else if(["heightM","lensMm","temperatureK","contrastRatio"].includes(key))result[key]=input.value===""?null:Number(input.value);else result[key]=key==="previewMove"?(input.value||null):input.value;}
    const c={};for(const [key,input]of coverageFields)c[key]=key==="subjects"?input.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean):key==="reestablish"?input.checked:input.value;
    if(JSON.stringify(c)!==JSON.stringify(Object.fromEntries([...coverageFields.keys()].map(key=>[key,state.coverageDefaults[key]]))))result.coverage=c;return {...result,...viewfinder.read(),...anchorEditor.read(),...lineEditor.read(),...pictureEditor.read()};}
  function fillValues(values){for(const [key,input]of fields)input.value=key==="durationSeconds"?(values.durationFrames===null?"":seconds(values.durationFrames)):values[key]??"";
    const c=values.coverage??state.coverageDefaults;for(const [key,input]of coverageFields){if(key==="reestablish")input.checked=c[key];else input.value=key==="subjects"?c.subjects.join("\n"):c[key];}viewfinder.fill(values,state,editing?.source.id);anchorEditor.fill(values,state);lineEditor.fill(values,editing);pictureEditor.fill(values,editing);}
  function edit(plan,draft,previousSource){
    if(busy)return;if(continuity.unsaved)return tell("Wait for the continuity repair to finish before editing a shot.",true);if(sceneCuts.unsaved)return tell("Accept or discard the coverage draft first.",true);if(dirty&&!draft)return tell("Save or cancel the current shot edit first.",true);
    if(takes.unsaved)return tell("Render or discard the take draft before editing shot direction.",true);
    if(subjectMotion.unsaved)return tell("Save or discard the movement draft before editing shot direction.",true);
    const saved=state.direction.entries.find(entry=>entry.source.id===plan.source.id),values=draft??saved?.settings??plan.settings??state.defaults;editing=plan;dirty=Boolean(draft);
    if(!form.contains(document.activeElement))editOpener=document.activeElement;
    currentSource.textContent="Current source · "+plan.source.id+": "+sourceText(plan.source);oldSource.replaceChildren(node("summary","Previously directed source"));
    const previous=previousSource??saved?.source;oldSource.hidden=!previous||sourceText(previous)===sourceText(plan.source);
    if(previous)oldSource.append(node("p",sourceText(previous)));
    fillValues(values);
    form.hidden=false;fields.get("durationSeconds").focus();tell(draft?"Draft kept. Review the latest shot and saved version before saving.":"Editing "+plan.source.id+". Review the source before saving.");
  }
  function render(){
    sceneCuts.render();continuity.render();
    durationInput.max=durationLimit();timingNote.textContent=describeTiming();
    summary.textContent="Direction version "+state.direction.version+" · "+state.direction.entries.length+" shot overrides · "+state.plan.length+" planned shots";
    for(const [key,input]of Object.entries(choiceFields)){input.replaceChildren();for(const value of state.choices[key])input.append(new Option(value==="unspecified"?"Unspecified":value.replaceAll("-"," "),value));}
    for(const [key,choices]of Object.entries(state.coverageChoices)){const input=coverageFields.get(key);input.replaceChildren();for(const value of choices)input.append(new Option(value==="unspecified"?"Unspecified":value.replaceAll("-"," "),value));}
    showCoverage(coverageReport,state.coverage,id=>{const plan=state.plan.find(value=>value.source.id===id);if(plan)edit(plan);else tell("This source shot disappeared. Remove its saved direction or restore the screenplay.",true);});
    list.replaceChildren();rowHeadings.clear();const scenes=new Map();
    for(const plan of state.plan){const index=plan.source.sceneIndex;if(!scenes.has(index))scenes.set(index,[]);scenes.get(index).push(plan);}
    for(const [scene,shots]of scenes){const section=details("Scene "+(scene+1)+" · "+shots.length+" shots");section.open=scenes.size===1||scenes.keys().next().value===scene;list.append(section);
      for(let start=0;start<shots.length;start+=6){const group=shots.length>6?details("Shots "+(start+1)+"–"+Math.min(start+6,shots.length)):section;if(group!==section){group.open=start===0;section.append(group);}
        for(const plan of shots.slice(start,start+6)){const saved=state.direction.entries.find(entry=>entry.source.id===plan.source.id),row=node("article");row.className="cast-card";
          const heading=node("h3",plan.source.id);rowHeadings.set(plan.source.id,heading);
          row.append(heading,node("p",plan.source.prompt.slice(0,220)),node("p",saved?(state.staleShotIds.includes(plan.source.id)?"Source changed — review required":"Saved direction · "+(saved.settings.durationFrames===null?"automatic duration":seconds(saved.settings.durationFrames)+" seconds · "+saved.settings.durationFrames+" frames")):plan.settings?.coverage?"Accepted coverage · "+plan.settings.coverage.role+" · "+(plan.settings.durationFrames===null?"automatic duration":seconds(plan.settings.durationFrames)+" seconds"):"Automatic direction"));
          if(plan.pictureError){const issue=node("p",plan.pictureError);issue.className="status";issue.dataset.state="error";row.append(issue);}
          if(plan.picturePrompt){const picture=details("Review picture performance prompt"),text=node("p",plan.picturePrompt);text.style.whiteSpace="pre-wrap";picture.append(text);row.append(picture);}
          const actions=node("div");actions.className="result-actions";actions.append(button("Edit "+plan.source.id,()=>edit(plan)),button("Compare takes for "+plan.source.id,()=>takes.open(plan)),button("Plan subject motion for "+plan.source.id,()=>subjectMotion.open(plan,state.maxShots)));row.append(actions);group.append(row);}
      }
    }
    const saved=details("Saved directions · review or remove");
    for(let start=0;start<state.direction.entries.length;start+=6){const group=state.direction.entries.length>6?details("Directions "+(start+1)+"–"+Math.min(start+6,state.direction.entries.length)):saved;if(group!==saved)saved.append(group);
      for(const entry of state.direction.entries.slice(start,start+6)){const row=node("article");row.className="cast-card";row.append(node("h3",entry.source.id),node("p",entry.source.prompt.slice(0,220)),button("Remove direction for "+entry.source.id,()=>{if(dirty)return tell("Save or cancel the shot edit first.",true);return mutate(()=>request("/"+entry.source.id+"/remove",{method:"POST",body:{expectedVersion:state.direction.version}}),entry.source.id);}));group.append(row);}}
    if(state.direction.entries.length)list.append(saved);
    const earlier=state.motionPlans?.filter(s=>!state.plan.some(p=>p.source.id===s.shotId))??[];if(earlier.length){const group=details("Movement plans for earlier shots");for(const study of earlier)group.append(button("Review movement plan for "+study.shotId,()=>subjectMotion.open({source:{id:study.shotId}},study.maxShots)));list.append(group);}
    historySelect.replaceChildren(new Option("Version 0 — automatic directions","0"));for(const value of state.history.slice().reverse())historySelect.append(new Option("Version "+value.version+" · "+value.shots+" shot overrides · "+(value.sceneCuts??0)+" scene cuts · "+new Date(value.createdAt).toLocaleString(),String(value.version)));historySelect.value=String(state.direction.version);
    if(!state.plan.length)list.append(node("p","Save a screenplay with scenes to direct its shots."));
  }
  async function locked(action){if(busy)return;busy=true;const controls=[...panel.querySelectorAll("button,input,textarea,select")],disabled=controls.map(e=>e.disabled);controls.forEach(e=>{e.disabled=true;});try{return await action();}finally{busy=false;controls.forEach((e,i)=>{e.disabled=disabled[i];});}}
  async function load(keepDraft=false){
    if(sceneCuts.unsaved)return tell("Accept or discard the coverage draft before reloading.",true);
    if(subjectMotion.unsaved)return tell("Save or discard the movement draft before reloading shot direction.",true);
    if(busy)return;let draft;try{draft=keepDraft&&dirty&&editing?{id:editing.source.id,source:editing.source,settings:settings()}:null;}catch(error){return tell(error.message,true);}tell("Loading shot plan…");
    try{await locked(async()=>{await prepare();state=await request("");render();form.hidden=true;dirty=false;changed(state.direction.version,false);});
      if(draft){const plan=state.plan.find(value=>value.source.id===draft.id);if(plan)edit(plan,draft.settings,draft.source);else {editing={source:draft.source};fillValues(draft.settings);dirty=true;form.hidden=false;tell("The edited shot disappeared. Your draft is still in the form; cancel it or restore the screenplay before saving.",true);}}
      else {const stale=Boolean(state.staleShotIds.length||state.staleSceneIndices.length||state.plan.some(p=>p.pictureError));tell(stale?"Some source shots, character intent or accepted coverage changed. Review or remove their saved directions before rendering.":"Shot plan loaded.",stale);}
    }catch(error){tell(error.message||"Could not load shot directions.",true);}
  }
  async function mutate(action,shotId){if(busy)return;if(sceneCuts.unsaved)return tell("Accept or discard the coverage draft first.",true);tell("Saving shot directions…");let saved=false;try{await locked(async()=>{const result=await action();changed(result.direction.version,true);state=await request("");render();dirty=false;editing=null;form.hidden=true;tell("Saved direction version "+state.direction.version+". Create a new preview to review it.");saved=true;});}catch(error){tell(error.message||"Could not save shot directions. Reload the plan to review changes.",true);}
    // After the controls are enabled again: the form is hidden and the list rebuilt, so the pressed
    // button is gone. The shot's own row, or the desk when the save had no one shot.
    if(saved)settle(shotId);}
  form.addEventListener("input",()=>{dirty=true;viewfinder.refresh();});form.addEventListener("change",()=>{dirty=true;});
  form.addEventListener("submit",async event=>{event.preventDefault();if(!editing||!state)return;let input;try{input=settings();}catch(error){return tell(error.message,true);}const sourceHash=editing.sourceHash,id=editing.source.id,expectedVersion=state.direction.version,expectedScriptVersion=state.scriptVersion;
    await mutate(async()=>{await prepare();return request("/"+id,{method:"PUT",body:{settings:input,sourceHash,expectedVersion,expectedScriptVersion,maxShots:state.maxShots}});},id);});
  return {get unsaved(){return dirty||busy||takes.unsaved||subjectMotion.unsaved||sceneCuts.unsaved||continuity.unsaved;},async checkCoverage(container){await prepare();const value=await request("");changed(value.direction.version,false);showCoverage(container,value.coverage);return value.coverage;},async open(){if(!panel.contains(document.activeElement))opener=document.activeElement;panel.hidden=false;if(dirty)return;await load();title.tabIndex=-1;title.focus();}};
}
