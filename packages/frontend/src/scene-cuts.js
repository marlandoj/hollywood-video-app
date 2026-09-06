/** Owner reviews a real, ordered scene cut before it enters direction history. */
export function initSceneCuts({parent,request,state,canEdit,accepted}){
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const button=(label,action)=>{const e=node("button",label);e.type="button";e.className="secondary";e.onclick=action;return e;};
  const details=label=>{const e=node("details");e.append(node("summary",label));return e;};
  const section=details("Propose scene coverage"),sceneList=node("div"),editor=node("div"),status=node("p"),actions=node("div");status.setAttribute("role","status");status.className="status";actions.className="result-actions";actions.hidden=true;
  let draft=null,busy=false,reviewed=false,readers=[],notesInput=null,ack=null,serial=0;
  const tell=(text,error=false)=>{status.textContent=text;status.dataset.state=error?"error":"success";};
  const review=button("Review edited cut",async()=>{if(!draft||busy)return;const edits=read();await run(async()=>{draft=await request("/scene-cuts",{method:"POST",body:{sceneIndex:draft.proposal.sceneIndex,maxShots:draft.proposal.binding.maxShots,binding:draft.proposal.binding,edits}});reviewed=true;draw();tell("Step 2 of 2: review the updated cut and accept when ready.");});});
  const accept=button("Accept scene coverage",async()=>{if(!draft||busy||!reviewed)return;if(!canEdit())return tell("Save or discard the other open edit first.",true);if(draft.impact.removeDirectionIds.length&&!ack.checked)return tell("Review and acknowledge the listed saved directions before accepting.",true);
    await run(async()=>{const result=await request("/scene-cuts/accept",{method:"POST",body:{proposal:draft.proposal,removeDirectionIds:draft.impact.removeDirectionIds}});draft=null;reviewed=false;editor.replaceChildren();await accepted(result.direction.version);tell("Coverage accepted as direction version "+result.direction.version+". Create and approve a new preview to review the cut.");});});accept.className="";
  actions.append(review,accept,button("Discard coverage draft",()=>{if(busy)return;draft=null;reviewed=false;editor.replaceChildren();sync();tell("Draft discarded. Accepted coverage is unchanged.");}));
  section.append(node("p","Review an ordered cut of action, speaker angles and optional silent reactions. Notes guide generation and are saved for future renders. Camera sides and eyelines remain unspecified until you direct them."),sceneList,editor,actions,status);parent.append(section);
  function sync(){actions.hidden=!draft;review.hidden=!draft?.proposal.cut;review.disabled=busy||reviewed;accept.disabled=busy||!reviewed||Boolean(draft?.impact.overBudget);}
  async function run(action){if(busy)return;busy=true;sync();const controls=[...section.querySelectorAll("button,input,select,textarea")],disabled=controls.map(e=>e.disabled);controls.forEach(e=>e.disabled=true);tell("Reviewing coverage…");try{await action();}catch(error){tell(error.message||"Could not review coverage. Your draft is retained.",true);}finally{busy=false;controls.forEach((e,i)=>e.disabled=disabled[i]);sync();}}
  function dirty(){reviewed=false;sync();tell("Step 1 of 2: review your edited cut to check beat order and shot limits.");}
  function field(parent,label,kind,value,options){const box=node("div"),caption=node("label",label),input=node(kind==="select"?"select":kind==="textarea"?"textarea":"input");input.id="cut-field-"+(++serial);caption.htmlFor=input.id;box.className="cast-field";
    if(kind==="select")for(const option of options)input.append(new Option(option.replaceAll("-"," "),option));
    else if(kind==="number"){input.type="number";input.min=1;input.max=30;input.step="any";}else if(kind==="textarea"){input.rows=3;input.maxLength=1200;}else input.type="text";
    input.value=value??"";input.addEventListener("input",dirty);input.addEventListener("change",dirty);box.append(caption,input);parent.append(box);return input;
  }
  function read(){return {notes:notesInput.value,shots:readers.map(fn=>fn())};}
  function draw(){editor.replaceChildren();readers=[];const {proposal,impact}=draft;editor.append(node("h3",proposal.cut?"Review scene "+(proposal.sceneIndex+1)+" coverage":"Remove accepted coverage for scene "+(proposal.sceneIndex+1)),
    node("p",impact.beforeShots+" → "+impact.afterShots+" shots across the film · tier limit "+proposal.binding.maxShots),node("p",impact.beforeSeconds.toFixed(2)+" → "+impact.afterSeconds.toFixed(2)+" seconds before automatic speech timing and edit transitions."));
    if(impact.overBudget)editor.append(node("p","This cut exceeds the tier limit. Group adjacent beats or remove silent alternates, then review again."));
    if(impact.removeDirectionIds.length){editor.append(node("p","Accepting replaces the source of these saved directions, including their framing and anchors: "+impact.removeDirectionIds.join(", ")+". The prior version remains in direction history."));const label=node("label","I reviewed these saved directions and accept their removal from the current cut.");label.className="attestation";ack=node("input");ack.type="checkbox";label.prepend(ack);editor.append(label);}
    const source=details("Ordered screenplay beats");for(let i=0;i<impact.beats.length;i+=5){const group=details("Beats "+(i+1)+"–"+Math.min(i+5,impact.beats.length));for(const b of impact.beats.slice(i,i+5))group.append(node("p",b.id+" · lines "+b.startLine+"–"+b.endLine+" · "+(b.kind==="dialogue"?b.character+": "+b.lines.join(" "):b.text)));source.append(group);}editor.append(source);
    if(proposal.cut){notesInput=field(editor,"Scene direction notes","textarea",proposal.cut.notes);const rows=node("div");editor.append(rows);
      for(const [index,shot]of proposal.cut.shots.entries()){const row=details((index+1)+" · "+shot.id+" · "+shot.coverage.role);row.open=proposal.cut.shots.length<=3;rows.append(row);
        row.append(node("p",shot.beatIds.length?"Narrative beats: "+shot.beatIds.join(", "):"Silent alternate view after "+(shot.afterBeatId??"scene opening")+"; no dialogue is repeated."));
        const role=field(row,"Coverage role for "+shot.id,"select",shot.coverage.role,state().coverageChoices.role),subjects=field(row,"Subjects for "+shot.id,"text",shot.coverage.subjects.join(", ")),duration=field(row,"Seconds for "+shot.id+" (blank = automatic)","number",shot.durationFrames===null?"":Number((shot.durationFrames/30).toFixed(3))),notes=field(row,"Direction notes for "+shot.id,"textarea",shot.notes);
        const advanced=details("Beat allocation and alternatives"),beats=field(advanced,"Ordered beat IDs for "+shot.id,"text",shot.beatIds.join(", ")),after=field(advanced,"After beat ID for silent "+shot.id+" (blank = opening)","text",shot.afterBeatId??"");row.append(advanced);
        const parse=value=>value.split(",").map(v=>v.trim()).filter(Boolean);
        readers.push(()=>({...shot,coverage:{...shot.coverage,role:role.value,subjects:parse(subjects.value)},durationFrames:duration.value===""?null:Math.round(Number(duration.value)*30),notes:notes.value,beatIds:parse(beats.value),afterBeatId:after.value.trim()||null}));
        advanced.append(button("Remove "+shot.id,()=>{const edits=read();edits.shots.splice(index,1);draft.proposal.cut={...proposal.cut,...edits};draw();dirty();}),button("Add silent view after "+shot.id,()=>{
          const edits=read(),current=edits.shots[index],id="shot-"+(proposal.sceneIndex+1)+"-"+(Math.max(10000,...edits.shots.map(s=>Number(s.id.split("-")[2])))+1);
          edits.shots.splice(index+1,0,{id,beatIds:[],afterBeatId:current.beatIds.at(-1)??current.afterBeatId,coverage:{...state().coverageDefaults,role:"reaction",subjects:current.coverage.subjects},durationFrames:null,notes:""});draft.proposal.cut={...proposal.cut,...edits};draw();dirty();}),button("Add narrative shot after "+shot.id,()=>{
          const edits=read(),id="shot-"+(proposal.sceneIndex+1)+"-"+(Math.max(10000,...edits.shots.map(s=>Number(s.id.split("-")[2])))+1);
          edits.shots.splice(index+1,0,{id,beatIds:[],afterBeatId:null,coverage:{...state().coverageDefaults,role:"single"},durationFrames:null,notes:""});draft.proposal.cut={...proposal.cut,...edits};draw();dirty();tell("Move the appropriate ordered beat IDs into the new shot, then review the cut.");}));
      }
    }else editor.append(node("p","The scene will return to its screenplay-based shot allocation. A new preview and approval are required."));sync();
  }
  async function start(sceneIndex,options={}){if(draft)return tell("Accept or discard the current coverage draft first.",true);if(!canEdit())return tell("Save or discard the other open edit before proposing coverage.",true);
    await run(async()=>{draft=await request("/scene-cuts",{method:"POST",body:{sceneIndex,maxShots:state().maxShots,...options}});reviewed=true;draw();tell("Step 2 of 2: review this proposal. It has not changed the film yet.");});}
  function render(){if(draft)return;sceneList.replaceChildren();const value=state(),scenes=new Map(value.scenes.map(s=>[s.index,s.heading]));for(const c of value.direction.sceneCuts??[])if(!scenes.has(c.source.sceneIndex))scenes.set(c.source.sceneIndex,c.source.heading+" (removed)");
    for(const [index,heading]of scenes){const row=details("Scene "+(index+1)+" · "+heading),saved=value.direction.sceneCuts?.find(c=>c.source.sceneIndex===index),stale=value.staleSceneIndices.includes(index);row.append(node("p",saved?(stale?"Accepted coverage is stale. Replace or remove it before rendering.":"Accepted coverage: "+saved.shots.length+" shots."):"Screenplay-based shot allocation."));
      if(value.scenes.some(s=>s.index===index)){row.append(button("Propose cut for scene "+(index+1),()=>start(index)),button("Propose cut with reactions for scene "+(index+1),()=>start(index,{includeReactions:true})));
        if(saved&&!stale)row.append(button("Edit accepted cut for scene "+(index+1),()=>start(index,{binding:{projectId:value.direction.projectId,scriptVersion:value.scriptVersion,castingRevision:value.castingRevision,directionRevision:value.direction.revision,maxShots:value.maxShots},edits:{shots:saved.shots,notes:saved.notes}})));}
      if(saved)row.append(button("Review removal for scene "+(index+1),()=>start(index,{remove:true})));sceneList.append(row);
    }sync();
  }
  return {render,get unsaved(){return Boolean(draft)||busy;}};
}
