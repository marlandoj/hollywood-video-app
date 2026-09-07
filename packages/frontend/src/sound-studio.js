/** Owner sound sessions keep one picture cut and make independent rendered versions. */
export function initSoundStudio({parent,request,libraryRequest,recording,jobRequest,projectState,assetUrl,canEdit,adopt}) {
  const rate=48000,stems=["dialogue","narration","music","ambience","effects","me","mix"];
  const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  const details=label=>{const el=node("details");el.append(node("summary",label));return el;};
  const panel=node("section"),status=node("p"),sources=node("div"),library=details("Recording library"),editor=node("form"),review=node("div"),history=details("Retained sound versions"),playback=node("div");
  panel.className="motion-workbench sound-studio";panel.hidden=true;status.setAttribute("role","status");status.className="status";
  panel.append(node("h2","Sound session"),node("p","Place music, ambience and effects around the saved character voices and narration. Each render keeps the picture timing and captions and saves a new version."),status,sources,library,editor,review,history,playback);parent.append(panel);
  let quote=null,catalog={version:0,assets:[],events:[]},busy=false,dirty=false,approved=null,serial=0,cueReaders=[],voiceReaders={},timeline,reviewButton,selection={version:0,entries:[]},objectUrls=[];
  const tell=(message,error=false)=>{status.textContent=message;status.dataset.state=error?"error":"success";};
  const available=asset=>catalog.events.filter(e=>e.assetId===asset.id).at(-1)?.available===true;
  const button=(label,action,primary=false)=>{const el=node("button",label);el.type="button";el.className=primary?"":"secondary";el.onclick=()=>run(action);return el;};
  const actions=()=>{const el=node("div");el.className="result-actions";return el;};
  function field(container,label,type,value,{min,max,step=0.1,required=true}={}) {
    const wrap=node("div"),caption=node("label",label),input=node(type==="select"?"select":type==="textarea"?"textarea":"input");
    wrap.className="cast-field";input.id="sound-field-"+(++serial);caption.htmlFor=input.id;
    if(!["select","textarea"].includes(type))input.type=type;
    if(type==="checkbox"){input.checked=Boolean(value);input.required=false;}else{input.value=value??"";input.required=required;}
    if(type==="number"){input.step=step===0.00001?"any":String(step);if(min!==undefined)input.min=String(min);if(max!==undefined)input.max=String(max);}
    if(type==="textarea")input.rows=3;
    wrap.append(caption,input);container.append(wrap);return input;
  }
  async function run(action) {
    if(busy)return;busy=true;panel.setAttribute("aria-busy","true");const controls=[...panel.querySelectorAll("button,input,select,textarea")],disabled=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);
    try{await action();}catch(error){tell(error.message||"This step could not finish. Your sound draft is retained.",true);}
    finally{busy=false;controls.forEach((c,i)=>c.disabled=disabled[i]);panel.removeAttribute("aria-busy");}
  }
  function stop(container){for(const media of container.querySelectorAll("audio,video")){media.pause();media.removeAttribute("src");media.load();}}
  function release(){stop(library);for(const url of objectUrls)URL.revokeObjectURL(url);objectUrls=[];}
  function invalidate(){dirty=true;approved=null;review.replaceChildren();reviewButton?.classList.remove("secondary");tell("Step 1 of 3 · Review your cue timing and levels before rendering.");drawTimeline();}
  function cueDescription(c){return c.asset.label+" · "+c.role+" · "+(c.start/rate).toFixed(3)+"–"+((c.start+c.frames)/rate).toFixed(3)+" s · "+c.gainDb+" dB";}
  function drawTimeline(){
    if(!timeline||!quote)return;timeline.replaceChildren(node("p","Cue placement · 0–"+quote.durationSec.toFixed(3)+" seconds"));
    for(const role of ["music","ambience","effects"]){const row=node("div"),track=node("div");row.className="sound-track-row";track.className="sound-track";row.append(node("span",role),track);timeline.append(row);
      for(const read of cueReaders){let c;try{c=read();}catch{continue;}if(c.role!==role)continue;const bar=node("span",c.asset.label);bar.className="sound-cue";bar.style.top=(5+track.children.length*38)+"px";bar.style.height="32px";bar.style.bottom="auto";track.style.minHeight=(44+track.children.length*38)+"px";bar.style.left=(100*c.start/(quote.durationSec*rate))+"%";bar.style.width=(100*c.frames/(quote.durationSec*rate))+"%";bar.title=cueDescription(c);bar.setAttribute("aria-label",bar.title);track.append(bar);}
    }
  }
  async function preview(asset,container){
    stop(library);const blob=await recording(asset.id),url=URL.createObjectURL(blob);objectUrls.push(url);const audio=node("audio");audio.controls=true;audio.src=url;audio.preload="metadata";audio.setAttribute("aria-label",asset.label+" recording");container.append(audio);tell("Recording ready to audition: "+asset.label+".");
  }
  function drawLibrary(){
    release();library.replaceChildren(node("summary","Recording library · "+catalog.assets.length+" recordings"));const upload=details("Upload a WAV recording");library.append(upload);
    upload.append(node("p","Use a mono or stereo WAV up to 10 minutes and 128 MiB. The original and a stereo mix copy are retained with your source, credit and rights record."));
    const form=node("form"),file=field(form,"WAV file","file",""),label=field(form,"Recording name","text",""),basis=field(form,"Rights basis","select","original"),source=field(form,"Recording source","text",""),credit=field(form,"Credit line","text","",{required:false}),terms=field(form,"Permission and distribution terms","textarea",""),attested=field(form,"I have the rights to use and distribute this recording in this project","checkbox",false);
    file.accept=".wav,audio/wav";label.maxLength=120;source.maxLength=1000;credit.maxLength=500;terms.maxLength=2000;
    for(const [value,text]of [["original","My original recording"],["licensed","Licensed recording"],["public-domain","Public domain recording"]])basis.append(new Option(text,value));
    file.onchange=()=>{if(!label.value)label.value=file.files?.[0]?.name.replace(/\.wav$/i,"")??"";};
    const save=node("button","Save recording");save.type="submit";save.className="secondary";form.append(save);upload.append(form);
    form.onsubmit=event=>{event.preventDefault();if(!form.reportValidity())return;void run(async()=>{if(!attested.checked)throw new Error("Confirm your recording rights before uploading.");const wav=file.files?.[0];if(!wav)throw new Error("Choose a WAV recording.");if(wav.size>128*1024*1024)throw new Error("Choose a WAV smaller than 128 MiB.");tell("Saving and preparing the recording…");const saved=await libraryRequest("",{method:"POST",body:wav,record:{label:label.value,expectedVersion:catalog.version,rights:{basis:basis.value,source:source.value,credit:credit.value,terms:terms.value,attested:true}}});catalog=saved.library;drawLibrary();tell("Recording saved. Add it to a sound cue.");});};
    const list=details("Browse recordings");library.append(list);list.open=catalog.assets.length>0&&catalog.assets.length<=3;
    for(const asset of catalog.assets){const row=details(asset.label+(available(asset)?"":" · unavailable"));list.append(row);row.append(node("p",(asset.audio.frames/rate).toFixed(3)+" s · "+asset.rights.basis+" · source: "+asset.rights.source),node("p","Credit: "+(asset.rights.credit||"No credit supplied")),node("p",asset.rights.terms));const controls=actions();row.append(controls);
      if(available(asset))controls.append(button("Preview "+asset.label,()=>preview(asset,row)));
      controls.append(button(available(asset)?"Withdraw recording":"Restore recording",async()=>{const saved=await libraryRequest("/"+asset.id,{method:"PUT",body:{expectedVersion:catalog.version,available:!available(asset)}});catalog=saved.library;drawLibrary();if(quote)invalidate();tell("Recording availability saved. Mixes using a withdrawn recording cannot be played or selected. Remove its cues to make a new version.");}));
    }
  }
  function addCue(existing){
    const asset=existing?.asset??catalog.assets.find(available);if(!asset)throw new Error("Upload an available recording first.");
    if(cueReaders.length>=64)throw new Error("Use up to 64 cues in one session.");
    const cue=existing??{id:crypto.randomUUID(),asset,role:"ambience",start:0,frames:Math.min(asset.audio.frames,Math.round(quote.durationSec*rate)),trimIn:0,trimOut:asset.audio.frames,loop:false,gainDb:-12,balance:0,fadeIn:0,fadeOut:0,duckDb:-12,duckAttack:4800,duckRelease:14400};
    const row=details(asset.label+" · "+cue.role),main=node("div"),timing=details("Trim, loop and fades"),mixing=details("Level, stereo balance and voice ducking");row.open=!existing;row.className="sound-cue-editor";main.className="sound-fields";row.append(main,timing,mixing);editor.insertBefore(row,reviewButton);
    const selected=field(main,"Recording","select",asset.id),role=field(main,"Track","select",cue.role),start=field(main,"Start in film (seconds)","number",cue.start/rate,{min:0,max:quote.durationSec,step:0.00001}),duration=field(main,"Cue duration (seconds)","number",cue.frames/rate,{min:1/rate,max:quote.durationSec,step:0.00001});
    for(const item of catalog.assets.filter(a=>available(a)||a.id===asset.id))selected.append(new Option(item.label+(available(item)?"":" · unavailable"),item.id));selected.value=asset.id;
    for(const value of ["music","ambience","effects"])role.append(new Option(value,value));role.value=cue.role;
    const trimIn=field(timing,"Recording trim start (seconds)","number",cue.trimIn/rate,{min:0,max:600,step:0.00001}),trimOut=field(timing,"Recording trim end (seconds)","number",cue.trimOut/rate,{min:1/rate,max:600,step:0.00001}),loop=field(timing,"Repeat trimmed recording for the cue duration","checkbox",cue.loop),fadeIn=field(timing,"Fade in (seconds)","number",cue.fadeIn/rate,{min:0,max:quote.durationSec,step:0.00001}),fadeOut=field(timing,"Fade out (seconds)","number",cue.fadeOut/rate,{min:0,max:quote.durationSec,step:0.00001});
    timing.append(node("p","Trimming and looping use the recording's timing. The cue stops at its saved duration."));
    const gain=field(mixing,"Cue level (dB)","number",cue.gainDb,{min:-60,max:12}),balance=field(mixing,"Stereo balance (−1 left, 0 center, 1 right)","number",cue.balance,{min:-1,max:1}),duck=field(mixing,"Reduction during voices (dB)","number",cue.duckDb,{min:-36,max:0}),attack=field(mixing,"Ducking lead-in (seconds)","number",cue.duckAttack/rate,{min:0,max:2,step:0.00001}),release=field(mixing,"Ducking recovery (seconds)","number",cue.duckRelease/rate,{min:0,max:5,step:0.00001});
    selected.onchange=()=>{const next=catalog.assets.find(a=>a.id===selected.value);trimIn.value="0";trimOut.value=String(next.audio.frames/rate);duration.value=String(Math.min(next.audio.frames/rate,quote.durationSec-Number(start.value)));row.querySelector("summary").textContent=next.label+" · "+role.value;};
    const frames=input=>Math.round(Number(input.value)*rate);
    const read=()=>{const chosen=catalog.assets.find(a=>a.id===selected.value);if(!chosen)throw new Error("Choose a saved recording.");return {id:cue.id,asset:chosen,role:role.value,start:frames(start),frames:frames(duration),trimIn:frames(trimIn),trimOut:frames(trimOut),loop:loop.checked,gainDb:Number(gain.value),balance:Number(balance.value),fadeIn:frames(fadeIn),fadeOut:frames(fadeOut),duckDb:Number(duck.value),duckAttack:frames(attack),duckRelease:frames(release)};};
    cueReaders.push(read);row.append(button("Remove cue",()=>{cueReaders=cueReaders.filter(r=>r!==read);row.remove();invalidate();}));drawTimeline();
  }
  function drawEditor(){
    editor.replaceChildren();review.replaceChildren();cueReaders=[];approved=null;dirty=false;if(!quote)return;
    editor.append(node("h3","Step 1 of 3 · Place and balance cues"),node("p","Picture: "+quote.durationSec.toFixed(3)+" s · captions: "+quote.language+" · rendering cost: $0 in provider charges. Existing voice invoices remain attached to their original auditions."));
    timeline=node("div");timeline.className="sound-timeline";editor.append(timeline);
    const voices=details("Dialogue and narration levels");editor.append(voices);voiceReaders={dialogue:field(voices,"Dialogue level (dB)","number",quote.session?.dialogueGainDb??0,{min:-60,max:6}),narration:field(voices,"Narration level (dB)","number",quote.session?.narrationGainDb??0,{min:-60,max:6})};
    voices.append(node("p","The saved voice performances and their timing carry forward. Existing narration ducking remains in the dialogue track."));
    const controls=actions();controls.append(button("Add sound cue",()=>{addCue();invalidate();}),button("Clear all sound cues",()=>{cueReaders=[];for(const row of editor.querySelectorAll(".sound-cue-editor"))row.remove();invalidate();}),button("Discard sound draft",()=>{drawEditor();tell("Draft reset to the selected retained version.");}));editor.append(controls);
    reviewButton=node("button","Review sound session");reviewButton.type="submit";editor.append(reviewButton);for(const cue of quote.session?.cues??[])addCue(cue);drawTimeline();
  }
  editor.addEventListener("input",invalidate);editor.addEventListener("change",invalidate);
  editor.onsubmit=event=>{event.preventDefault();if(!editor.reportValidity())return;void run(async()=>{
    const cues=cueReaders.map(read=>read()),end=Math.round(quote.durationSec*rate);
    for(const c of cues){if(!available(c.asset))throw new Error("Remove or replace the unavailable recording: "+c.asset.label+".");if(c.frames<1||c.start+c.frames>end||c.trimIn>=c.trimOut||c.trimOut>c.asset.audio.frames||!c.loop&&c.frames>c.trimOut-c.trimIn||c.fadeIn+c.fadeOut>c.frames)throw new Error("Check duration, trim, loop and fades for "+c.asset.label+".");}
    const session={reviewed:true,dialogueGainDb:Number(voiceReaders.dialogue.value),narrationGainDb:Number(voiceReaders.narration.value),cues:cues.map(({asset,...c})=>({...c,assetId:asset.id,assetRevision:asset.revision}))};
    approved={idempotencyKey:crypto.randomUUID(),generationApproved:true,sourceRevision:quote.sourceRevision,engineVersion:quote.engineVersion,session};dirty=true;reviewButton.classList.add("secondary");review.replaceChildren(node("h3","Step 2 of 3 · Review this sound session"),node("p","Dialogue "+session.dialogueGainDb+" dB · narration "+session.narrationGainDb+" dB · "+cues.length+" sound cues"));
    if(!cues.length)review.append(node("p","This version contains the retained voices with no music, ambience or effects cues."));
    for(const c of cues){const row=details(cueDescription(c));row.append(node("p","Trim "+c.trimIn/rate+"–"+c.trimOut/rate+" s · "+(c.loop?"loops":"plays once")+" · fades "+c.fadeIn/rate+" / "+c.fadeOut/rate+" s"),node("p","Balance "+c.balance+" · voice reduction "+c.duckDb+" dB · lead-in "+c.duckAttack/rate+" s · recovery "+c.duckRelease/rate+" s"),node("p","Source: "+c.asset.rights.source+" · credit: "+(c.asset.rights.credit||"none supplied")),node("p",c.asset.rights.terms));review.append(row);}
    review.append(node("p","Render a separate mix, then listen before choosing it as your export. Overloads stop rendering; reduce the relevant levels and retry."),button("Render reviewed sound session",render,true));tell("Step 2 of 3 · Check the spotting list, source credits and mix settings.");
  });};
  async function poll(id){for(;;){const job=await jobRequest(id);if(job.status==="done")return job;if(["failed","cancelled"].includes(job.status))throw new Error(job.failureReason||job.cancelReason||"Sound rendering stopped. Revise the levels or recording access and review again.");tell(job.status==="running"?"Rendering stems and mix…":"Queued · waiting for a sound worker…");await new Promise(resolve=>setTimeout(resolve,1500));}}
  async function render(){if(!approved)throw new Error("Review the current session first.");const submitted=approved;const result=await request("/"+quote.sourceJobId,{method:"POST",body:submitted});await poll(result.jobId);dirty=false;approved=null;quote=null;drawEditor();await refreshHistory();await show(result.jobId);tell("Step 3 of 3 · Sound version ready. Listen to the mix and stems, then choose your export.");}
  async function refreshHistory(){const state=await projectState();selection=state.dialogueSelections??{version:0,entries:[]};const data=await request("");catalog=data.library;history.replaceChildren(node("summary","Retained sound versions · "+data.jobs.length));
    for(const job of data.jobs.slice().reverse()){const row=node("div");row.className="result-actions";row.append(node("span",job.id.slice(0,8)+" · "+job.status),button("Open sound version "+job.id.slice(0,8),async()=>{if(["queued","running"].includes(job.status))await poll(job.id);await show(job.id);}));history.append(row);}return data;
  }
  async function show(id){
    const job=await jobRequest(id);playback.hidden=false;stop(playback);playback.replaceChildren(node("h3","Sound version · "+id.slice(0,8)));if(job.mediaUnavailable||!job.output?.mp4Url){playback.append(node("p",job.mediaUnavailable||job.failureReason||"This version has no playable output."));return;}
    const video=node("video");video.controls=true;video.playsInline=true;video.preload="metadata";video.src=assetUrl(job.output.mp4Url);const captions=node("track");captions.kind="captions";captions.srclang=job.captionLanguage??"en";captions.label=captions.srclang;captions.src=assetUrl(job.output.captionsUrl);captions.default=true;video.append(captions);playback.append(video);video.onplay=()=>{for(const other of document.querySelectorAll("audio,video"))if(other!==video)other.pause();};
    const downloads=details("Download mix, stems and cue sheet"),links=actions();downloads.append(links);playback.append(downloads);
    for(const [key,label]of [["mp4Url","Film MP4"],["captionsUrl","Captions"],["manifestUrl","Provenance"],["cueSheetUrl","Download cue sheet"],...stems.map(stem=>[stem+"StemUrl",stem==="me"?"Music & effects WAV":stem+" WAV"])]){if(!job.output[key])continue;const link=node("a",label);link.className="button-link";link.href=assetUrl(job.output[key]);links.append(link);}
    const report=job.sound?.report;
    if(report?.peaks){const meters=details("Measured sample peaks");meters.append(node("p","Peak levels describe saved PCM samples. This export has no loudness normalization or broadcast qualification."));for(const stem of stems){const peak=report.peaks[stem];meters.append(node("p",stem+": "+(peak===0?"silence":(20*Math.log10(peak/8388608)).toFixed(2)+" dBFS")));}playback.append(meters);}
    const controls=actions();controls.append(button("Continue this sound version",()=>inspect(id)));const chosen=selection.entries.at(-1);
    if(chosen?.jobId===id)controls.append(node("p","This is your selected export."));else controls.append(button("Use this sound version as export",async()=>{const saved=await adopt({jobId:id,sourceJobId:job.soundMix.originalJobId,expectedVersion:selection.version,expectedOutputRevision:job.outputRevision});selection=saved.dialogueSelections;await show(id);tell("Export selected. Earlier sound versions remain available for rollback.");},true));playback.append(controls);
  }
  async function inspect(id){if(dirty)throw new Error("Render or discard the sound draft before switching versions.");tell("Checking retained picture, voices and recordings…");quote=await request("/"+id);stop(playback);playback.hidden=true;catalog=quote.library;drawLibrary();drawEditor();tell("Step 1 of 3 · Place cues around the retained voices.");}
  async function open(){panel.hidden=false;if(!canEdit())return tell("Save or discard the other open edit before opening a sound session.",true);if(dirty)return tell("Your sound draft is open. Render or discard it before switching cuts.",true);await run(async()=>{tell("Loading retained cuts and sound recordings…");const data=await refreshHistory();drawLibrary();sources.replaceChildren();const choose=field(sources,"Picture or sound version","select","");for(const item of data.sources){const option=new Option(item.stage+" · "+item.id.slice(0,8)+(item.unavailable?" · "+item.unavailable:""),item.id);option.disabled=Boolean(item.unavailable);choose.append(option);}choose.value=data.sources.filter(s=>!s.unavailable).at(-1)?.id??"";const controls=actions();controls.append(button("Load sound session",()=>inspect(choose.value)),button("Close sound session",()=>{if(dirty)throw new Error("Render or discard the sound draft before closing.");release();stop(playback);panel.hidden=true;}));sources.append(controls);if(choose.value)await inspect(choose.value);else tell("Create a retained film with isolated voices before starting a sound session.");});}
  window.addEventListener("beforeunload",event=>{if(dirty||busy){event.preventDefault();event.returnValue="";}});
  return {open,get unsaved(){return dirty||busy;}};
}
