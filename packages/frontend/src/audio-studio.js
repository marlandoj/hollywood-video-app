/** Owner voice defaults and immutable line auditions. User text uses DOM properties. */
export function initAudioStudio({parent,prepare,prepareGeneration,request,saveVoice,projectId,assetUrl,canEdit,changed}) {
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const details=label=>{const e=node("details");e.append(node("summary",label));return e;};
  const panel=node("section"),title=node("h2","Voices and line auditions"),status=node("p"),toolbar=node("div"),layout=node("div"),editor=node("form"),history=node("div"),review=node("div"),pendingBox=node("div");
  panel.className="cast-panel dialogue-workbench audio-studio";panel.hidden=true;title.id="audio-studio-title";panel.setAttribute("aria-labelledby",title.id);status.className="status";status.setAttribute("role","status");status.setAttribute("aria-live","polite");
  toolbar.className="result-actions";layout.className="audio-layout";editor.id="audio-line-editor";editor.noValidate=false;layout.append(editor,history);panel.append(title,node("p","Save a character's voice, direct one screenplay line, and compare retained reads. Use Dialogue replacement to apply a saved take to a film."),toolbar,pendingBox,status,layout);parent.append(panel);
  let state=null,selected=null,castId="",editingVersion=0,dirty=false,busy=false,approved=null,pending=null,timer=null,generation=0,comparison=["",""],historySignature="",reloading=false;
  const tell=(message,error=false)=>{status.textContent=message;status.dataset.state=error?"error":"success";};
  const button=(label,action,primary=false)=>{const e=node("button",label);e.type="button";e.className=primary?"":"secondary";e.onclick=()=>void run(action);return e;};
  function field(parent,label,kind="select",min,max,step){
    const wrap=node("div"),caption=node("label",label),input=node(kind==="textarea"?"textarea":kind==="select"?"select":"input");wrap.className="cast-field";input.id="audio-"+crypto.randomUUID();caption.htmlFor=input.id;
    if(kind==="number"){input.type="number";input.min=min;input.max=max;input.step=step??"any";input.required=true;}
    if(kind==="textarea"){input.rows=3;input.maxLength=600;}
    wrap.append(caption,input);parent.append(wrap);return input;
  }
  const choose=node("fieldset");choose.append(node("legend","1 · Choose a character and line"));
  const characters=field(choose,"Screenplay character"),lines=field(choose,"Screenplay line"),text=node("p"),cues=node("p");choose.append(text,cues);editor.append(choose);
  const settings=node("fieldset");settings.append(node("legend","2 · Direct the read"));
  const voice=field(settings,"Voice"),emotion=field(settings,"Emotion direction"),speed=field(settings,"Speed multiplier","number",.6,1.5,.05);
  for(const value of ["neutral","calm","angry","content","sad","scared"])emotion.append(new Option(value[0].toUpperCase()+value.slice(1),value));
  const advanced=details("Level, pronunciation and pauses"),volume=field(advanced,"Volume multiplier","number",.5,2,.05),dictionary=field(advanced,"Pronunciations · word = spoken replacement","textarea"),before=field(advanced,"Leading pause (milliseconds)","number",0,3000,1),after=field(advanced,"Trailing pause (milliseconds)","number",0,3000,1),notes=field(advanced,"Acting notes · retained as direction","textarea");
  dictionary.maxLength=8000;advanced.append(node("p","Acting notes are retained with the take. Emotion guides the voice; listen to judge the result."));settings.append(advanced);
  const defaults=details("Character voice defaults"),profileStatus=node("p");defaults.append(profileStatus,
    button("Save these vocal settings for character",saveDefaults),button("Use saved character defaults",()=>{fillDefaults();editChanged();}),
    button("Clear character voice assignment",async()=>{if(!castId)throw new Error("Choose a saved character.");const saved=await saveVoice(castId,{expectedVersion:editingVersion,clear:true});changed(saved.casting.version);await load(true);tell("Voice assignment cleared. Retained takes remain available.");}));
  settings.append(defaults);editor.append(settings);
  const reviewButton=node("button","Review line audition");reviewButton.type="submit";editor.append(reviewButton,button("Discard unsubmitted changes",()=>{approved=null;dirty=false;review.replaceChildren();fillDefaults();tell("Draft reset to the character defaults. Retained takes remain available.");}),review);
  toolbar.append(button("Refresh saved takes",()=>{historySignature="";return load(false);}),button("Reload screenplay and voice defaults",async()=>{if(dirty)throw new Error("Discard unsubmitted changes before reloading defaults.");await prepare();await load(true);}),
    button("Close voice studio",()=>{if(dirty)throw new Error("Discard unsubmitted changes before closing.");close();}));
  function lock(){settings.disabled=busy||!castId;choose.disabled=busy||!state;reviewButton.disabled=busy||!state?.enabled||!selected||Boolean(selected.unavailable)||Boolean(pending);reviewButton.className=approved?"secondary":"";}
  async function run(action){if(busy)return;busy=true;panel.setAttribute("aria-busy","true");lock();try{await action();}catch(error){tell(error.message||"This step could not finish. Your draft is retained.",true);}finally{busy=false;panel.removeAttribute("aria-busy");lock();}}
  function editChanged(){dirty=true;approved=null;review.replaceChildren();lock();tell("Review this line's settings before generating an audition.");}
  settings.addEventListener("input",editChanged);settings.addEventListener("change",editChanged);
  const lineKey=line=>line.sceneIndex+":"+line.source.index+":"+line.source.hash;
  const actor=()=>state?.characters.find(c=>c.id===castId);
  function values(){const pronunciations=dictionary.value.split(/\r?\n/).filter(s=>s.trim()).map(s=>{const i=s.indexOf("=");if(i<1)throw new Error("Use word = spoken replacement for each pronunciation.");return {word:s.slice(0,i).trim(),say:s.slice(i+1).trim()};});
    if(!voice.value||!state.voices.some(v=>v.id===voice.value))throw new Error("Choose a currently authorized voice.");
    return {voiceId:voice.value,controls:{speed:Number(speed.value),volume:Number(volume.value),emotion:emotion.value},pronunciations,beforeMs:Number(before.value),afterMs:Number(after.value),notes:notes.value,alignment:"words-and-phonemes"};
  }
  function fill(values={}){
    voice.replaceChildren(new Option("Choose a voice",""));for(const v of state?.voices??[])voice.append(new Option(v.label,v.id));
    voice.value=state?.voices.some(v=>v.id===values.voiceId)?values.voiceId:"";emotion.value=values.controls?.emotion??"neutral";speed.value=values.controls?.speed??1;volume.value=values.controls?.volume??1;
    dictionary.value=(values.pronunciations??[]).map(p=>p.word+" = "+p.say).join("\n");before.value=values.beforeMs??0;after.value=values.afterMs??200;notes.value=values.notes??"";
  }
  function fillDefaults(){const c=actor();fill(c?.profile?{...c.profile,voiceId:c.profile.voice.id}:{});profileStatus.textContent=c?.profile?(c.voiceAvailable?"Saved voice: "+c.voiceLabel+". Changes here do not alter earlier takes.":"The saved voice is unavailable. Choose an authorized voice and save a new assignment."):"No expressive voice is assigned to this character.";editingVersion=state?.castingVersion??0;}
  function drawLines(preferred){
    const available=state.lines.filter(l=>l.characterId===castId);lines.replaceChildren();
    for(const line of available)lines.append(new Option((line.sceneIndex+1)+" · "+line.source.character+" · "+line.source.text.slice(0,100),lineKey(line)));
    selected=available.find(l=>lineKey(l)===preferred)??available[0]??null;lines.value=selected?lineKey(selected):"";text.textContent=selected?.source.text??"No spoken lines match this saved character.";cues.textContent=selected?.source.cues.length?"Screenplay direction: "+selected.source.cues.join(" "):"";
    if(selected?.unavailable)cues.textContent=selected.unavailable;historySignature="";drawHistory();lock();
  }
  characters.onchange=()=>{if(dirty){characters.value=castId;return tell("Discard unsubmitted changes before switching characters.",true);}castId=characters.value;drawLines();fillDefaults();};
  lines.onchange=()=>{if(dirty){lines.value=selected?lineKey(selected):"";return tell("Discard unsubmitted changes before switching lines.",true);}drawLines(lines.value);fillDefaults();};
  async function saveDefaults(){
    if(!editor.reportValidity())return;const v=values(),policy=state.voices.find(p=>p.id===v.voiceId);
    const saved=await saveVoice(castId,{expectedVersion:editingVersion,voiceId:v.voiceId,policyRevision:policy.policyRevision,controls:v.controls,pronunciations:v.pronunciations});
    changed(saved.casting.version);state=await request();editingVersion=state.castingVersion;profileStatus.textContent="Character defaults saved. This line's pauses and notes stay with its audition.";tell("Voice defaults saved for "+actor().name+". Review the line to generate a take.");
  }
  editor.onsubmit=event=>{event.preventDefault();if(!editor.reportValidity())return;void run(async()=>{
    if(pending)throw new Error("Resolve the previous request before generating another audition.");if(!selected)throw new Error("Choose a saved screenplay line.");
    const v=values(),policy=state.voices.find(p=>p.id===v.voiceId);approved={idempotencyKey:crypto.randomUUID(),generationApproved:true,sceneIndex:selected.sceneIndex,lineIndex:selected.source.index,sourceHash:selected.source.hash,characterId:castId,policyRevision:policy.policyRevision,...v};
    dirty=true;
    review.replaceChildren(node("h3","Review · "+selected.source.character),node("p",selected.source.text),node("p",policy.label+" · "+v.controls.emotion+" · speed "+v.controls.speed+" · volume "+v.controls.volume),
      node("p","Leading pause "+v.beforeMs+" ms · trailing pause "+v.afterMs+" ms"),node("p","Operator reservation: $"+policy.heldUsd.toFixed(6)+". You are not charged. The final provider allocation may remain pending after the take is ready."));
    if(v.pronunciations.length)review.append(node("p","Pronunciations: "+v.pronunciations.map(p=>p.word+" = "+p.say).join("; ")));if(v.notes)review.append(node("p","Acting direction: "+v.notes));
    review.append(button("Generate reviewed audition",submit,true));tell("2 of 3 · Check the read and reservation, then generate.");lock();
  });};
  const storageKey=()=>"hv-audio-pending:"+projectId();
  function persistPending(value){try{if(value)sessionStorage.setItem(storageKey(),JSON.stringify(value));else sessionStorage.removeItem(storageKey());}catch{throw new Error("The browser could not retain this request for recovery. Enable session storage before generating.");}pending=value;drawPending();}
  function drawPending(){pendingBox.replaceChildren();if(!pending)return;pendingBox.append(node("p","An audition request is awaiting confirmation. Retrying uses the same request, so it cannot create a duplicate take."),button("Check saved takes",()=>load(false)),button("Retry the same audition request",submit));}
  async function submit(){
    const body=pending??approved;if(!body)throw new Error("Review this line before generating.");await prepareGeneration();
    if(!pending)persistPending(body);tell("Submitting the reviewed audition…");
    try{const admitted=await request({method:"POST",body});persistPending(null);approved=null;dirty=false;review.replaceChildren();comparison=[admitted.jobId,comparison[0]];await load(false);tell(admitted.status==="done"?"3 of 3 · Audition ready. Play the retained read or compare it with another take.":"3 of 3 · Audition queued. Saved takes will update as the worker finishes.");}
    catch(error){if(error.status>=400&&error.status<500&&error.status!==408){persistPending(null);approved=null;review.replaceChildren();}throw error;}
  }
  function billing(job){const b=job.audioBilling;if(!b)return "Billing unavailable";
    if(b.state==="invoice-allocated")return "Operator invoice allocation: $"+b.actualUsd.toFixed(6);
    if(b.state==="not-incurred")return "No provider charge incurred";
    return (b.state==="reserved"?"Reserved":"Provider cost not yet reconciled")+" · $"+Number(b.heldUsd).toFixed(6)+" held";
  }
  function stopMedia(root=history){for(const media of root.querySelectorAll("audio")){media.pause();media.removeAttribute("src");media.load();}}
  function showTake(parent,job,label){
    parent.replaceChildren(node("h4",label+" · "+job.id.slice(0,8)),node("p",job.audioTake.source.text),node("p",job.audioTake.voiceLabel+" · "+job.status),node("p",billing(job)));
    const v=job.audioTake.settings;parent.append(node("p",v.controls.emotion+" · speed "+v.controls.speed+" · volume "+v.controls.volume+" · pauses "+v.beforeMs+"/"+v.afterMs+" ms"));
    if(v.notes)parent.append(node("p","Acting direction: "+v.notes));
    if(job.audioUnavailable)parent.append(node("p",job.audioUnavailable));
    else if(job.status==="done"&&job.output?.audioUrl){const audio=node("audio");audio.controls=true;audio.preload="metadata";audio.src=assetUrl(job.output.audioUrl);audio.setAttribute("aria-label",label+" "+job.audioTake.source.text);
      audio.onplay=()=>{for(const other of document.querySelectorAll("audio,video"))if(other!==audio)other.pause();};audio.onerror=()=>tell("This retained audio is unavailable or expired. Refresh takes to check its permission.",true);parent.append(audio);
      const links=node("div");links.className="result-actions";for(const [key,label]of [["audioUrl","Download WAV"],["manifestUrl","Performance timing"]])if(job.output[key]){const a=node("a",label);a.className="button-link";a.href=assetUrl(job.output[key]);links.append(a);}parent.append(links);
      const timing=job.audio?.report;if(timing)parent.append(node("p",(timing.totalSamples/48000).toFixed(2)+" s · "+timing.alignment.words.length+" word timings · "+timing.alignment.phonemes.length+" phoneme timings"));
    }else parent.append(node("p",job.failureReason||job.cancelReason||"Waiting for the audition worker."));
    if(selected&&job.audioTake.source.hash===selected.source.hash)parent.append(button("Use "+label+" settings for a new take",()=>{fill(v);editChanged();editor.scrollIntoView({block:"start",behavior:"smooth"});}));
    else parent.append(node("p","Historical screenplay line. Choose its current line to direct a new read."));
  }
  function drawHistory(){
    const jobs=state?.jobs.filter(j=>j.audioTake.characterId===castId&&(!selected||j.audioTake.sceneIndex===selected.sceneIndex&&j.audioTake.source.index===selected.source.index))??[];
    // Signed URLs change on polling. Only redraw for content/status changes;
    // explicit refresh replaces expired links without interrupting every read.
    const signature=()=>JSON.stringify({jobs:jobs.map(({output,audio,artifactUrlsExpireInSeconds:_expires,...job})=>({...job,hasAudio:Boolean(output?.audioUrl),report:audio?.report})),comparison});
    if(signature()===historySignature)return;historySignature=signature();stopMedia();history.replaceChildren(node("h3","3 · Compare saved takes"));
    if(!jobs.length){history.append(node("p","No saved reads for this line yet. Generate an audition to hear it here."));return;}
    const slots=node("div");slots.className="audio-comparison";history.append(slots);
    for(const [i,label]of ["A","B"].entries()){
      const slot=node("article"),choice=field(slot,"Take "+label),playback=node("div");choice.append(new Option("Choose a saved take",""));
      for(const job of jobs.slice().reverse())choice.append(new Option(job.id.slice(0,8)+" · "+job.audioTake.controls.emotion+" · "+job.status+(job.audioTake.source.hash!==selected?.source.hash?" · earlier screenplay":""),job.id));
      const picked=jobs.find(j=>j.id===comparison[i])??(i===0?jobs.at(-1):jobs.length>1?jobs.at(-2):null);comparison[i]=picked?.id??"";choice.value=comparison[i];
      choice.onchange=()=>{stopMedia(playback);comparison[i]=choice.value;const job=jobs.find(j=>j.id===choice.value);if(job)showTake(playback,job,label);else playback.replaceChildren();};
      slot.append(playback);slots.append(slot);if(picked)showTake(playback,picked,label);
    }
    historySignature=signature();
  }
  async function load(reset=false){
    const epoch=generation,next=await request();if(epoch!==generation||panel.hidden)return;state=next;
    if(pending){const match=state.jobs.find(j=>j.idempotencyKey===projectId()+":"+pending.idempotencyKey);if(match){comparison=[match.id,comparison[0]];persistPending(null);approved=null;dirty=false;review.replaceChildren();tell("The submitted audition was found. Its saved status is "+match.status+".");}}
    if(reset){const preferred=selected&&lineKey(selected);characters.replaceChildren();for(const c of state.characters)characters.append(new Option(c.name,c.id));castId=state.characters.some(c=>c.id===castId)?castId:state.characters[0]?.id??"";characters.value=castId;drawLines(preferred);fillDefaults();}
    drawHistory();drawPending();lock();schedule();
    if(!state.enabled)tell("Expressive auditions are not enabled. The operator must configure an authorized voice catalogue and audio service. Temporary voices remain in the cast editor.");
    else if(!state.characters.length)tell("Save an original fictional character in the cast editor, then reopen voices.");
    else if(reset)tell(pending?"Your previous request is retained. Check its saved status or retry the same request.":"1 of 3 · Choose a line, direct its read, then review the audition.");
  }
  function schedule(){clearTimeout(timer);const epoch=generation;if(panel.hidden||!state?.jobs.some(j=>["queued","running"].includes(j.status)))return;timer=setTimeout(async()=>{if(epoch!==generation||panel.hidden)return;if(busy||reloading){schedule();return;}reloading=true;try{await load(false);}catch(error){tell(error.message||"Could not refresh takes. Use Refresh saved takes to reconnect.",true);}finally{reloading=false;}},2000);}
  function close(){panel.hidden=true;generation++;clearTimeout(timer);stopMedia();}
  window.addEventListener("pagehide",close);
  return {async open(){if(!canEdit())return tell("Save or cancel the other open edit before opening voices.",true);panel.hidden=false;
      if(dirty)return tell("Your unsubmitted line changes are retained. Review or discard them before reloading.");
      await run(async()=>{tell("Loading screenplay voices and retained reads…");await prepare();try{const raw=sessionStorage.getItem(storageKey());pending=raw&&raw.length<64000?JSON.parse(raw):null;if(pending&&(!/^[a-f0-9-]{36}$/.test(pending.idempotencyKey)||typeof pending.sourceHash!=="string"))pending=null;}catch{pending=null;}await load(true);panel.scrollIntoView({block:"start"});});},get unsaved(){return dirty||busy;},close};
}
