/** Owner voice defaults and immutable line auditions. User text uses DOM properties. */
import {createPhraseEditor,describePhrase} from "./audio-phrases.js";
import {pictureControlsEditor} from "./picture-performance.js";
import {whileBusy} from "./busy.js";
export function initAudioStudio({parent,prepare,prepareGeneration,request,saveVoice,savePerformance,projectId,assetUrl,canEdit,changed}) {
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(["p","textarea"].includes(tag))e.dir="auto";return e;};
  const details=label=>{const e=node("details");e.append(node("summary",label));return e;};
  const panel=node("section"),title=node("h2","Voices and line auditions"),status=node("p"),toolbar=node("div"),layout=node("div"),editor=node("form"),history=node("div"),review=node("div"),pendingBox=node("div");
  panel.className="cast-panel dialogue-workbench audio-studio";panel.hidden=true;title.id="audio-studio-title";panel.setAttribute("aria-labelledby",title.id);status.className="status";status.setAttribute("role","status");status.setAttribute("aria-live","polite");
  toolbar.className="result-actions";layout.className="audio-layout";editor.id="audio-line-editor";editor.noValidate=false;layout.append(editor,history);panel.append(title,node("p","Save a character's voice, direct screenplay dialogue or a separate narration read, and compare retained takes. Use Dialogue replacement to place saved reads and mix narration into a film."),toolbar,pendingBox,status,layout);parent.append(panel);
  let state=null,selected=null,castId="",editingVersion=0,dirty=false,busy=false,approved=null,pending=null,timer=null,generation=0,comparison=["",""],historySignature="",reloading=false;
  const tell=(message,error=false)=>{status.textContent=message;status.dataset.state=error?"error":"success";};
  const button=(label,action,primary=false)=>{const e=node("button",label);e.type="button";e.className=primary?"":"secondary";e.onclick=()=>void run(action);return e;};
  function field(parent,label,kind="select",min,max,step){
    const wrap=node("div"),caption=node("label",label),input=node(kind==="textarea"?"textarea":kind==="select"?"select":"input");wrap.className="cast-field";input.id="audio-"+crypto.randomUUID();caption.htmlFor=input.id;
    if(kind==="number"){input.type="number";input.min=min;input.max=max;input.step=step??"any";input.required=true;}
    if(kind==="textarea"){input.rows=3;input.maxLength=600;}
    wrap.append(caption,input);parent.append(wrap);return input;
  }
  const choose=node("fieldset");choose.append(node("legend","1 · Choose a character and read"));
  const characters=field(choose,"Screenplay character"),readKind=field(choose,"Read type"),lines=field(choose,"Screenplay line"),text=node("p"),cues=node("p");readKind.append(new Option("Screenplay dialogue","dialogue"),new Option("Narration or voice-over","narration"));choose.append(text,cues);editor.append(choose);
  const narrationFields=node("fieldset");narrationFields.hidden=true;narrationFields.disabled=true;narrationFields.append(node("legend","Separate narration read"));choose.append(narrationFields);
  const narrationScene=field(narrationFields,"Narration scene"),narrationText=field(narrationFields,"Narration text","textarea"),narrationReviewed=field(narrationFields,"I reviewed this narration text and its scene context","checkbox");narrationReviewed.type="checkbox";narrationText.maxLength=20000;narrationText.required=true;
  narrationFields.append(node("p","This text stays separate from screenplay dialogue. Choose the scene whose character permission and acting intent apply. Place the completed read within that scene in Dialogue replacement."));
  const scenePanel=details("Scene performance direction"),sceneSettings=node("fieldset");sceneSettings.append(node("legend","Saved intent for this character"));scenePanel.append(sceneSettings);editor.append(scenePanel);
  const scenes=field(sceneSettings,"Performance scene"),sceneStatus=node("p"),sceneText=details("Read the current scene"),sceneExcerpt=node("p"),sceneNotes=field(sceneSettings,"Scene acting intent","textarea");sceneExcerpt.style.whiteSpace="pre-wrap";sceneText.append(sceneExcerpt);sceneSettings.append(sceneStatus,sceneText);
  const sceneVocal=details("Scene vocal overrides"),sceneEmotion=field(sceneVocal,"Scene emotion"),sceneSpeed=field(sceneVocal,"Scene speed multiplier","number",.6,1.5,.05),sceneVolume=field(sceneVocal,"Scene volume multiplier","number",.5,2,.05);
  sceneEmotion.append(new Option("Inherit character emotion",""));for(const v of ["neutral","calm","angry","content","sad","scared"])sceneEmotion.append(new Option(v,v));sceneSpeed.required=false;sceneVolume.required=false;
  sceneVocal.append(node("p","Leave a value blank to inherit the character default. Explicit line settings take precedence."));sceneSettings.append(sceneVocal,node("p","Scene intent guides picture prompts and initializes new line notes. Vocal controls guide expressive auditions. Free-form notes are retained with audio; listen to judge the performance."));
  const sceneNative=details("Azure scene voice direction"),sceneStyle=field(sceneNative,"Scene speaking style"),sceneIntensity=field(sceneNative,"Scene style intensity","number",.01,2,.01);
  sceneNative.append(node("p","Choose a style and intensity for Azure reads in this scene, or inherit the character defaults. Scene emotion applies to Cartesia when an Azure style is saved here. Speed and volume apply to either voice; explicit line settings take precedence."));sceneVocal.append(sceneNative);
  function configureSceneStyle(){sceneIntensity.disabled=!sceneStyle.value||sceneStyle.value==="neutral";if(sceneStyle.value==="neutral")sceneIntensity.value=1;}
  sceneStyle.onchange=configureSceneStyle;
  let sceneDirty=false,sceneNumber=0,sceneBinding=null;
  const scenePicture=pictureControlsEditor(sceneSettings,"Scene picture performance",()=>{sceneDirty=true;lock();tell("Scene picture draft changed. Save or discard it before directing a line.");});
  const sceneSave=button("Save scene performance",()=>saveScene(false)),sceneRemove=button("Remove saved scene performance",()=>saveScene(true)),sceneDiscard=button("Discard scene changes",()=>{sceneDirty=false;drawScene(sceneNumber);tell("Scene draft reset to its saved direction.");});sceneSettings.append(sceneSave,sceneRemove,sceneDiscard);
  // Validate before run() disables the fieldset: disabled controls are excluded
  // from constraint validation, while the API still validates every save.
  sceneSave.onclick=()=>{if([sceneSpeed,sceneVolume,sceneIntensity].every(input=>input.reportValidity()))void run(()=>saveScene(false));};
  const settings=node("fieldset"),lineOrigin=node("p");settings.append(node("legend","2 · Direct the read"),lineOrigin);
  const voice=field(settings,"Voice"),emotion=field(settings,"Emotion direction"),speed=field(settings,"Speed multiplier","number",.6,1.5,.05);
  const localizationPanel=details("Translate this line for dubbing"),language=field(localizationPanel,"Dub language"),translation=field(localizationPanel,"Reviewed translation","textarea"),translationReviewed=field(localizationPanel,"I reviewed this translation against the original line","checkbox");translationReviewed.type="checkbox";translation.maxLength=20000;
  localizationPanel.append(node("p","Enter a translation you have reviewed. The original screenplay stays unchanged. Only languages authorized for this voice are available. A complete dubbed film needs reviewed takes for every spoken line."));settings.append(localizationPanel);
  for(const value of ["neutral","calm","angry","content","sad","scared"])emotion.append(new Option(value[0].toUpperCase()+value.slice(1),value));
  const advanced=details("Level, pronunciation and pauses"),volume=field(advanced,"Volume multiplier","number",.5,2,.05),dictionary=field(advanced,"Pronunciations · word = spoken replacement","textarea"),before=field(advanced,"Leading pause (milliseconds)","number",0,3000,1),after=field(advanced,"Trailing pause (milliseconds)","number",0,3000,1),notes=field(advanced,"Acting notes · retained as direction","textarea");
  dictionary.maxLength=8000;advanced.append(node("p","Acting notes are retained with the take. Emotion guides the voice; listen to judge the result."));settings.append(advanced);
  const intensity=field(settings,"Style intensity","number",.01,2,.01),nativeHelp=node("p");intensity.value=1;intensity.parentElement.hidden=true;settings.append(nativeHelp);
  const phraseEditor=createPhraseEditor({parent:settings,node,details,field,button,changed:editChanged});
  const defaults=details("Character voice defaults"),profileStatus=node("p");defaults.append(profileStatus,
    button("Save these vocal settings for character",saveDefaults),button("Use saved character and scene defaults",()=>{fillDefaults();editChanged();}),
    button("Clear character voice assignment",async()=>{if(!castId)throw new Error("Choose a saved character.");const saved=await saveVoice(castId,{expectedVersion:editingVersion,clear:true});changed(saved.casting.version);await load(true);tell("Voice assignment cleared. Retained takes remain available.");}));
  settings.append(defaults);editor.append(settings);
  const reviewButton=node("button","Review line audition");reviewButton.type="submit";editor.append(reviewButton,button("Discard unsubmitted changes",()=>{if(sceneDirty)throw new Error("Save or discard scene changes first.");approved=null;dirty=false;droppedPhrases=0;review.replaceChildren();fillDefaults();tell("Draft reset to the character and scene defaults. Retained takes remain available.");}),review);
  toolbar.append(button("Refresh saved takes",()=>{historySignature="";return load(false);}),button("Reload screenplay and voice defaults",async()=>{if(dirty||sceneDirty)throw new Error("Save or discard unsubmitted changes before reloading defaults.");await prepare();await load(true);}),
    button("Close voice studio",()=>{if(dirty||sceneDirty)throw new Error("Save or discard unsubmitted changes before closing.");close();
      // HV-039-16: closing returns focus to the control that opened the panel; hiding the panel with focus inside it left focus on the page body.
      if(opener?.isConnected&&!opener.disabled)opener.focus();}));
  function lock(){settings.disabled=busy||!castId||sceneDirty;choose.disabled=busy||!state||sceneDirty;sceneSettings.disabled=busy||!castId||dirty||Boolean(pending);reviewButton.disabled=busy||sceneDirty||!state?.enabled||!selected||Boolean(selected.unavailable)||Boolean(pending);reviewButton.className=approved?"secondary":"";sceneSave.disabled=!sceneBinding?.sourceHash;sceneRemove.disabled=!actor()?.scenePerformances?.some(p=>p.sceneNumber===sceneNumber);}
  async function run(action){if(busy)return;busy=true;lock();try{await whileBusy(panel,action);}catch(error){tell(error.message||"This step could not finish. Your draft is retained.",true);}finally{busy=false;lock();}}
  /**
   * What this edit cost, when it cost something (HV-024-05).
   *
   * HV-024-04 wrote its sentence with `tell` from inside `retext` -- and every path that can reach
   * `retext` reaches `editChanged` immediately afterwards, which wrote the generic line over it:
   * `language.onchange` and `narrationText.oninput` call it outright, and `translation` sits inside
   * the `settings` fieldset, whose own `input` listener is `editChanged`. So the creator lost a
   * direction and was told to review their settings. The count is held here instead and said *by*
   * `editChanged`, which is the only thing that writes the status for an edit, so no ordering
   * between a handler and a bubbled listener can cover it.
   *
   * It survives until the draft does: a draft that was saved, submitted, reset or reloaded is a
   * different draft, and those are the four places `dirty` goes back to false.
   */
  let droppedPhrases=0;
  const droppedNotice=()=>droppedPhrases
    ?droppedPhrases+" phrase direction"+(droppedPhrases===1?" was":"s were")+" removed because the words "+(droppedPhrases===1?"it names":"they name")+" changed. Review this line's settings before generating an audition."
    :"";
  function editChanged(){dirty=true;approved=null;review.replaceChildren();lock();tell(droppedNotice()||"Review this line's settings before generating an audition.");}
  /**
   * HV-024-04: the line's text changed under its phrase directions. The ones the edit left exactly
   * where they were are kept; the rest are dropped, and the creator is told, because the old
   * behaviour -- `phraseEditor.set(text, [])` -- emptied all sixteen on one keystroke in silence.
   */
  function retext(text){
    droppedPhrases=phraseEditor.retext(text);
    editChanged();
  }
  settings.addEventListener("input",editChanged);settings.addEventListener("change",editChanged);
  const isNative=()=>state?.voices.find(p=>p.id===voice.value)?.provider==="azure";
  const languageLabel=code=>{try{return new Intl.DisplayNames(["en"],{type:"language"}).of(code)+" ("+code+")";}catch{return code;}};
  function configureLocalization(preferred=language.value){const allowed=state?.voices.find(p=>p.id===voice.value)?.dubLanguages??[];language.replaceChildren(new Option("Use original screenplay line",""));for(const code of allowed)language.append(new Option(languageLabel(code),code));if(preferred&&!allowed.includes(preferred))language.append(new Option(languageLabel(preferred)+" · unavailable for this voice",preferred));language.value=preferred;translation.disabled=!preferred;translationReviewed.disabled=!preferred;}
  function configureVoice(value){const native=isNative(),options=native?state.voices.find(p=>p.id===voice.value).styles:["neutral","calm","angry","content","sad","scared"];emotion.replaceChildren(new Option(native?"Choose a speaking style":"Choose an emotion",""));for(const v of options)emotion.append(new Option(v,v));emotion.value=value??"";emotion.previousElementSibling.textContent=native?"Speaking style":"Emotion direction";intensity.parentElement.hidden=!native;intensity.disabled=!native;phraseEditor.configure(native);nativeHelp.textContent=native?"This voice supports native word emphasis and speaking style intensity. It returns word timing. Listen to judge the performance; phoneme and lip-sync timing are unavailable.":"";}
  voice.onchange=()=>{configureLocalization();configureVoice();translationReviewed.checked=false;editChanged();};
  language.onchange=()=>{translationReviewed.checked=false;configureLocalization();if(language.value&&language.value!=="en")emotion.value="neutral";retext(language.value?translation.value:selected?.source.text);editChanged();};
  translation.oninput=()=>{translationReviewed.checked=false;retext(translation.value);};
  emotion.onchange=()=>{if(isNative()&&emotion.value==="neutral")intensity.value=1;};
  const lineKey=line=>line.sceneIndex+":"+line.source.index+":"+line.source.hash;
  const actor=()=>state?.characters.find(c=>c.id===castId);
  const isNarration=()=>readKind.value==="narration";
  function narrationSelection(){const scene=state?.scenes.find(s=>s.sceneNumber===Number(narrationScene.value)),memory=actor()?.scenePerformances?.find(p=>p.sceneNumber===scene?.sceneNumber)??null;
    selected=scene&&actor()?{sceneIndex:scene.sceneNumber-1,source:{index:0,dialogueIndex:0,lineIndex:0,character:actor().name,text:narrationText.value.trim(),cues:[],hash:""},memory,performanceRevision:memory?.revision??null,unavailable:memory&&memory.sourceHash!==scene.sourceHash?"This scene changed. Review its saved performance before auditioning narration.":null}:null;
    text.textContent="";cues.textContent=selected?.unavailable??"Narration is retained separately from the original screenplay.";historySignature="";
  }
  readKind.onchange=()=>{if(dirty){readKind.value=selected?.narration||narrationFields.hidden===false?"narration":"dialogue";return tell("Discard unsubmitted changes before switching read types.",true);}drawLines();fillDefaults();};
  narrationScene.onchange=()=>{narrationReviewed.checked=false;narrationSelection();fillDefaults();editChanged();drawHistory();};
  narrationText.oninput=()=>{narrationReviewed.checked=false;translationReviewed.checked=false;narrationSelection();retext(language.value?translation.value:narrationText.value);editChanged();};
  narrationReviewed.onchange=editChanged;
  function drawScene(preferred){
    const saved=actor()?.scenePerformances??[],available=[...(state?.scenes??[])];for(const p of saved)if(!available.some(s=>s.sceneNumber===p.sceneNumber))available.push({sceneNumber:p.sceneNumber,heading:p.heading+" · removed from screenplay",sourceHash:null,text:"This scene no longer exists. Remove its saved performance."});
    scenes.replaceChildren();for(const s of available)scenes.append(new Option(s.sceneNumber+" · "+s.heading,String(s.sceneNumber)));sceneNumber=available.some(s=>s.sceneNumber===preferred)?preferred:available[0]?.sceneNumber??0;scenes.value=String(sceneNumber);
    const current=available.find(s=>s.sceneNumber===sceneNumber),memory=saved.find(s=>s.sceneNumber===sceneNumber);sceneBinding=current?{sceneNumber,sourceHash:current.sourceHash,expectedScriptVersion:state.scriptVersion,expectedVersion:state.castingVersion}:null;
    sceneNotes.value=memory?.notes??"";sceneEmotion.value=memory?.controls.emotion??"";sceneSpeed.value=memory?.controls.speed??"";sceneVolume.value=memory?.controls.volume??"";scenePicture.fill(memory?.picture);sceneExcerpt.textContent=current?.text??"No saved screenplay scenes.";
    sceneStyle.replaceChildren(new Option("Inherit character style and intensity",""));for(const style of state?.sceneNativeStyles??[])sceneStyle.append(new Option(style,style));sceneStyle.value=memory?.nativeVoice?.style??"";sceneIntensity.value=memory?.nativeVoice?.intensity??1;configureSceneStyle();
    sceneStatus.textContent=memory?(memory.sourceHash===current?.sourceHash?"Saved for "+actor().name+" in scene "+sceneNumber+". Earlier takes keep their own direction.":"This scene changed. Read the current scene, revise the intent, and save to bind it again, or remove it."):"No saved performance for this character in this scene. Silent scenes can have acting intent too.";lock();
  }
  scenes.onchange=()=>{if(sceneDirty){scenes.value=String(sceneNumber);return tell("Save or discard scene changes before switching scenes.",true);}drawScene(Number(scenes.value));};
  for(const input of [sceneNotes,sceneEmotion,sceneSpeed,sceneVolume,sceneStyle,sceneIntensity])input.addEventListener("input",()=>{sceneDirty=true;lock();tell("Scene draft changed. Save or discard it before directing a line.");});
  async function saveScene(remove){
    if(!sceneBinding)throw new Error("Choose a saved scene.");
    const controls={};if(sceneEmotion.value)controls.emotion=sceneEmotion.value;if(sceneSpeed.value!=="")controls.speed=Number(sceneSpeed.value);if(sceneVolume.value!=="")controls.volume=Number(sceneVolume.value);
    const nativeVoice=sceneStyle.value?{style:sceneStyle.value,intensity:Number(sceneIntensity.value)}:undefined;
    const picture=remove?undefined:scenePicture.read();const saved=await savePerformance(castId,{...sceneBinding,...(remove?{remove:true}:{notes:sceneNotes.value,controls,...(picture?{picture}:{}),...(nativeVoice?{nativeVoice}:{})})});changed(saved.casting.version);sceneDirty=false;const preferred=sceneNumber;await load(true);drawScene(preferred);tell(remove?"Scene direction removed. Earlier takes retain their saved performance.":"Scene performance saved. New line drafts and picture prompts inherit it; explicit line and shot settings override it.");
  }
  function values(){const pronunciations=dictionary.value.split(/\r?\n/).filter(s=>s.trim()).map(s=>{const i=s.indexOf("=");if(i<1)throw new Error("Use word = spoken replacement for each pronunciation.");return {word:s.slice(0,i).trim(),say:s.slice(i+1).trim()};});
    if(!voice.value||!state.voices.some(v=>v.id===voice.value))throw new Error("Choose a currently authorized voice.");
    const native=isNative();if(!emotion.value)throw new Error(native?"Choose a speaking style for this voice.":"Choose an emotion direction.");
    let localization;if(language.value){if(native||!state.voices.find(v=>v.id===voice.value)?.dubLanguages.includes(language.value))throw new Error("Choose a voice authorized for this dubbing language.");if(!translationReviewed.checked||!translation.value.trim())throw new Error("Review the translated text against the original line and check its review box.");if(language.value!=="en"&&emotion.value!=="neutral")throw new Error("Choose neutral for this language. Emotion comes from the translated transcript; English emotion controls are omitted.");localization={language:language.value,text:translation.value,sourceHash:selected.source.hash,reviewed:true};}
    if(native&&(!Number.isFinite(Number(intensity.value))||Number(intensity.value)<.01||Number(intensity.value)>2||Math.abs(Number(intensity.value)*100-Math.round(Number(intensity.value)*100))>1e-8||emotion.value==="neutral"&&Number(intensity.value)!==1))throw new Error("Set style intensity from 0.01 to 2, in steps of 0.01. Neutral uses 1.");
    return {voiceId:voice.value,controls:{speed:Number(speed.value),volume:Number(volume.value),emotion:native?"neutral":emotion.value,...(native?{style:emotion.value,intensity:Number(intensity.value)}:{})},pronunciations,beforeMs:Number(before.value),afterMs:Number(after.value),notes:notes.value,alignment:native||localization?"words":"words-and-phonemes",phrases:phraseEditor.values(),...(localization?{localization}:{})};
  }
  function fill(values={}){
    narrationReviewed.checked=false;
    voice.replaceChildren(new Option("Choose a voice",""));for(const v of state?.voices??[])voice.append(new Option(v.label,v.id));
    voice.value=state?.voices.some(v=>v.id===values.voiceId)?values.voiceId:"";configureVoice(isNative()?(values.controls?.emotion&&values.controls.emotion!=="neutral"?"":values.controls?.style??"neutral"):values.controls?.emotion??"neutral");intensity.value=values.controls?.intensity??1;speed.value=values.controls?.speed??1;volume.value=values.controls?.volume??1;
    dictionary.value=(values.pronunciations??[]).map(p=>p.word+" = "+p.say).join("\n");before.value=values.beforeMs??0;after.value=values.afterMs??200;notes.value=values.notes??"";
    configureLocalization(values.localization?.language??"");translation.value=values.localization?.text??"";translationReviewed.checked=false;localizationPanel.open=Boolean(values.localization);phraseEditor.set(values.localization?.text??selected?.source.text,values.phrases??[]);
  }
  function fillDefaults(){droppedPhrases=0;const c=actor(),current=state?.lines.find(l=>selected&&lineKey(l)===lineKey(selected));if(current)selected=current;
    const memory=selected?.memory,scene=state?.scenes?.find(s=>s.sceneNumber===memory?.sceneNumber),valid=memory&&scene?.sourceHash===memory.sourceHash?memory:null;
    fill({...c?.profile,voiceId:c?.profile?.voice.id,controls:{...c?.profile?.controls,...valid?.controls,...(c?.profile?.provider==="azure"&&valid?.nativeVoice?{emotion:"neutral",...valid.nativeVoice}:{})},notes:valid?.notes??""});lineOrigin.textContent=selected?"Line in scene "+(selected.sceneIndex+1)+" · "+(valid?"character defaults and saved scene direction":"character defaults")+" initialize this read. The line settings below take precedence.":"Choose a spoken line to direct a read.";profileStatus.textContent=(c?.profile?(c.voiceAvailable?"Saved voice: "+c.voiceLabel+".":"The saved voice is unavailable. Choose an authorized voice and save a new assignment."):"No expressive voice is assigned to this character.")+(valid?" Scene "+valid.sceneNumber+" direction is inherited. Explicit line settings override it.":"")+" Earlier takes retain their reviewed settings.";editingVersion=state?.castingVersion??0;drawScene(selected?selected.sceneIndex+1:sceneNumber);}
  function drawLines(preferred){
    const narration=isNarration();lines.parentElement.hidden=narration;lines.disabled=narration;narrationFields.hidden=!narration;narrationFields.disabled=!narration;
    if(narration){const previous=narrationScene.value;narrationScene.replaceChildren();for(const scene of state.scenes)narrationScene.append(new Option(scene.sceneNumber+" · "+scene.heading,String(scene.sceneNumber)));narrationScene.value=state.scenes.some(s=>String(s.sceneNumber)===previous)?previous:String(state.scenes[0]?.sceneNumber??"");narrationReviewed.checked=false;narrationSelection();drawHistory();lock();return;}
    const available=state.lines.filter(l=>l.characterId===castId);lines.replaceChildren();
    for(const line of available)lines.append(new Option((line.sceneIndex+1)+" · "+line.source.character+" · "+line.source.text.slice(0,100),lineKey(line)));
    selected=available.find(l=>lineKey(l)===preferred)??available[0]??null;lines.value=selected?lineKey(selected):"";text.textContent=selected?.source.text??"No spoken lines match this saved character.";cues.textContent=selected?.source.cues.length?"Screenplay direction: "+selected.source.cues.join(" "):"";
    if(selected?.unavailable)cues.textContent=selected.unavailable;historySignature="";drawHistory();lock();
  }
  characters.onchange=()=>{if(dirty){characters.value=castId;return tell("Discard unsubmitted changes before switching characters.",true);}castId=characters.value;drawLines();fillDefaults();};
  lines.onchange=()=>{if(dirty){lines.value=selected?lineKey(selected):"";return tell("Discard unsubmitted changes before switching lines.",true);}drawLines(lines.value);fillDefaults();};
  async function saveDefaults(){
    if(language.value)throw new Error("Translated language and pronunciation settings stay with this line's take. Use the original line mode to save character defaults.");
    if(!editor.reportValidity())return;const v=values(),policy=state.voices.find(p=>p.id===v.voiceId);
    const saved=await saveVoice(castId,{expectedVersion:editingVersion,voiceId:v.voiceId,policyRevision:policy.policyRevision,controls:v.controls,pronunciations:v.pronunciations});
    changed(saved.casting.version);state=await request();editingVersion=state.castingVersion;profileStatus.textContent="Character defaults saved. This line's pauses and notes stay with its audition.";tell("Voice defaults saved for "+actor().name+". Review the line to generate a take.");
  }
  editor.onsubmit=event=>{event.preventDefault();if(!editor.reportValidity())return;void run(async()=>{
    if(pending)throw new Error("Resolve the previous request before generating another audition.");if(!selected)throw new Error("Choose a saved screenplay line.");
    let narration;if(isNarration()){if(!narrationReviewed.checked||!narrationText.value.trim())throw new Error("Review the narration text and its scene context, then check the review box.");narration={text:narrationText.value,reviewed:true};selected=await request({previewNarration:true,method:"POST",body:{characterId:castId,sceneIndex:selected.sceneIndex,expectedScriptVersion:state.scriptVersion,narration}});}
    const v=values(),policy=state.voices.find(p=>p.id===v.voiceId);approved={idempotencyKey:crypto.randomUUID(),generationApproved:true,sceneIndex:selected.sceneIndex,lineIndex:selected.source.index,sourceHash:selected.source.hash,characterId:castId,policyRevision:policy.policyRevision,performanceRevision:selected.performanceRevision??null,...(narration?{narration,expectedScriptVersion:state.scriptVersion}:{}),...(isNative()?{nativeCapabilityRevision:state.nativeCapabilityRevision}:{}),...(v.localization?{multilingualCapabilityRevision:state.multilingualCapabilityRevision}:{}),...(v.phrases.length?{phraseCapabilityRevision:v.localization?state.multilingualCapabilityRevision:isNative()?state.nativeCapabilityRevision:state.phraseCapabilityRevision}:{}),...v};
    dirty=true;
    review.replaceChildren(node("h3","Review · "+selected.source.character),node("p",selected.source.text),node("p",policy.label+" · "+(v.controls.style?v.controls.style+" · intensity "+v.controls.intensity:v.controls.emotion)+" · speed "+v.controls.speed+" · volume "+v.controls.volume),
      node("p","Leading pause "+v.beforeMs+" ms · trailing pause "+v.afterMs+" ms"),node("p","Operator reservation: $"+policy.heldUsd.toFixed(6)+". You are not charged. The final provider allocation may remain pending after the take is ready."));
    if(narration)review.append(node("p","Separate narration · scene "+(selected.sceneIndex+1)+". The screenplay is unchanged; the completed audition can be placed on a narration or voice-over track."));
    if(v.pronunciations.length)review.append(node("p","Pronunciations: "+v.pronunciations.map(p=>p.word+" = "+p.say).join("; ")));if(v.notes)review.append(node("p","Acting direction: "+v.notes));
    if(v.localization)review.append(node("h4","Reviewed dub · "+languageLabel(v.localization.language)),node("p",v.localization.text),node("p","Word timing follows this translated read. Listen before applying it to picture. Non-English requests omit explicit emotion controls."));
    if(selected.memory)review.append(node("p","Saved scene "+selected.memory.sceneNumber+" intent: "+(selected.memory.notes||"Vocal controls only")),node("p","This take uses the explicit line settings shown above."));
    for(const phrase of v.phrases)review.append(node("p",describePhrase(phrase,v.localization?.text??selected.source.text)));if(v.phrases.length)review.append(node("p","Phrase controls guide delivery. Requested pauses are measured in the returned audio; speed and volume return to the line settings after each phrase."));
    review.append(button("Generate reviewed audition",submit,true));tell("2 of 3 · Check the read and reservation, then generate.");lock();
  });};
  const storageKey=()=>"hv-audio-pending:"+projectId();
  function persistPending(value){try{if(value)sessionStorage.setItem(storageKey(),JSON.stringify(value));else sessionStorage.removeItem(storageKey());}catch{throw new Error("The browser could not retain this request for recovery. Enable session storage before generating.");}pending=value;drawPending();}
  function drawPending(){pendingBox.replaceChildren();if(!pending)return;pendingBox.append(node("p","An audition request is awaiting confirmation. Retrying uses the same request, so it cannot create a duplicate take."),button("Check saved takes",()=>load(false)),button("Retry the same audition request",submit));}
  async function submit(){
    const body=pending??approved;if(!body)throw new Error("Review this line before generating.");await prepareGeneration();
    if(!pending)persistPending(body);tell("Submitting the reviewed audition…");
    try{const admitted=await request({method:"POST",body});persistPending(null);approved=null;dirty=false;droppedPhrases=0;review.replaceChildren();comparison=[admitted.jobId,comparison[0]];await load(false);tell(admitted.status==="done"?"3 of 3 · Audition ready. Play the retained read or compare it with another take.":"3 of 3 · Audition queued. Saved takes will update as the worker finishes.");}
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
    const v=job.audioTake.settings;parent.append(node("p",(v.controls.style?v.controls.style+" · intensity "+v.controls.intensity:v.controls.emotion)+" · speed "+v.controls.speed+" · volume "+v.controls.volume+" · pauses "+v.beforeMs+"/"+v.afterMs+" ms"));
    if(job.audioTake.narration)parent.append(node("p","Narration read · scene "+(job.audioTake.sceneIndex+1)));
    if(v.notes)parent.append(node("p","Acting direction: "+v.notes));
    if(v.localization)parent.append(node("p","Reviewed dub · "+languageLabel(v.localization.language)),node("p",v.localization.text));
    for(const phrase of v.phrases??[])parent.append(node("p",describePhrase(phrase,v.localization?.text??job.audioTake.source.text)));
    if(job.audioTake.memory){const memory=job.audioTake.memory;parent.append(node("p","Retained scene "+memory.sceneNumber+" intent: "+(memory.notes||"Vocal controls only")),node("p","Later edits do not change this take."));if(memory.nativeVoice)parent.append(node("p","Saved Azure scene voice: "+memory.nativeVoice.style+" · intensity "+memory.nativeVoice.intensity+". The effective line settings are shown above."));}
    if(job.audioUnavailable)parent.append(node("p",job.audioUnavailable));
    else if(job.status==="done"&&job.output?.audioUrl){const audio=node("audio");audio.controls=true;audio.preload="metadata";audio.src=assetUrl(job.output.audioUrl);audio.setAttribute("aria-label",label+" "+job.audioTake.source.text);
      audio.onplay=()=>{for(const other of document.querySelectorAll("audio,video"))if(other!==audio)other.pause();};audio.onerror=()=>tell("This retained audio is unavailable or expired. Refresh takes to check its permission.",true);parent.append(audio);
      const links=node("div");links.className="result-actions";for(const [key,label]of [["audioUrl","Download WAV"],["manifestUrl","Performance timing"]])if(job.output[key]){const a=node("a",label);a.className="button-link";a.href=assetUrl(job.output[key]);links.append(a);}parent.append(links);
      const timing=job.audio?.report;if(timing)parent.append(node("p",(timing.totalSamples/48000).toFixed(2)+" s · "+timing.alignment.words.length+" word timings · "+timing.alignment.phonemes.length+" phoneme timings"));
    }else parent.append(node("p",job.failureReason||job.cancelReason||"Waiting for the audition worker."));
    if(isNarration()&&job.audioTake.narration)parent.append(button("Use "+label+" narration for a new take",()=>{if(sceneDirty)throw new Error("Save or discard scene changes before reusing a narration read.");phraseEditor.assertDraftApplied();narrationText.value=job.audioTake.narration.text;narrationScene.value=String(job.audioTake.sceneIndex+1);narrationReviewed.checked=false;narrationSelection();fill(v);editChanged();editor.scrollIntoView({block:"start",behavior:"smooth"});}));
    else if(selected&&job.audioTake.source.hash===selected.source.hash)parent.append(button("Use "+label+" settings for a new take",()=>{if(sceneDirty)throw new Error("Save or discard scene changes before reusing take settings.");phraseEditor.assertDraftApplied();fill(v);editChanged();editor.scrollIntoView({block:"start",behavior:"smooth"});}));
    else parent.append(node("p","Historical screenplay line. Choose its current line to direct a new read."));
  }
  function drawHistory(){
    const jobs=state?.jobs.filter(j=>j.audioTake.characterId===castId&&Boolean(j.audioTake.narration)===isNarration()&&(!selected||j.audioTake.sceneIndex===selected.sceneIndex&&j.audioTake.source.index===selected.source.index))??[];
    // Signed URLs change on polling. Only redraw for content/status changes;
    // explicit refresh replaces expired links without interrupting every read.
    const signature=()=>JSON.stringify({jobs:jobs.map(({output,audio,artifactUrlsExpireInSeconds:_expires,...job})=>({...job,hasAudio:Boolean(output?.audioUrl),report:audio?.report})),comparison});
    if(signature()===historySignature)return;historySignature=signature();stopMedia();history.replaceChildren(node("h3","3 · Compare saved takes"));
    if(!jobs.length){history.append(node("p","No saved reads for this line yet. Generate an audition to hear it here."));return;}
    const slots=node("div");slots.className="audio-comparison";history.append(slots);
    for(const [i,label]of ["A","B"].entries()){
      const slot=node("article"),choice=field(slot,"Take "+label),playback=node("div");choice.append(new Option("Choose a saved take",""));
      for(const job of jobs.slice().reverse())choice.append(new Option(job.id.slice(0,8)+" · "+(job.audioTake.localization?languageLabel(job.audioTake.localization.language):job.audioTake.narration?"Narration":"Original line")+" · "+(job.audioTake.controls.style??job.audioTake.controls.emotion)+" · "+job.status+(!job.audioTake.narration&&job.audioTake.source.hash!==selected?.source.hash?" · earlier screenplay":""),job.id));
      const picked=jobs.find(j=>j.id===comparison[i])??(i===0?jobs.at(-1):jobs.length>1?jobs.at(-2):null);comparison[i]=picked?.id??"";choice.value=comparison[i];
      // HV-039-09: the choice is part of the signature, so the signature moves with it. Left behind, the
      // next status check (every 2 s while any read renders) saw a "change", stopped every take and
      // rebuilt both slots: the take just chosen stopped playing and focus left the list.
      choice.onchange=()=>{stopMedia(playback);comparison[i]=choice.value;historySignature=signature();const job=jobs.find(j=>j.id===choice.value);if(job)showTake(playback,job,label);else playback.replaceChildren();};
      slot.append(playback);slots.append(slot);if(picked)showTake(playback,picked,label);
    }
    historySignature=signature();
  }
  async function load(reset=false){
    const epoch=generation,next=await request();if(epoch!==generation||panel.hidden)return;state=next;
    if(pending){const match=state.jobs.find(j=>j.idempotencyKey===projectId()+":"+pending.idempotencyKey);if(match){comparison=[match.id,comparison[0]];persistPending(null);approved=null;dirty=false;droppedPhrases=0;review.replaceChildren();tell("The submitted audition was found. Its saved status is "+match.status+".");}}
    if(reset){const preferred=selected&&lineKey(selected);characters.replaceChildren();for(const c of state.characters)characters.append(new Option(c.name,c.id));castId=state.characters.some(c=>c.id===castId)?castId:state.characters[0]?.id??"";characters.value=castId;drawLines(preferred);fillDefaults();}
    drawHistory();drawPending();lock();schedule();
    if(!state.enabled)tell("Expressive auditions are not enabled. The operator must configure an authorized voice catalogue and audio service. Temporary voices remain in the cast editor.");
    else if(!state.characters.length)tell("Save an original fictional character in the cast editor, then reopen voices.");
    else if(reset)tell(pending?"Your previous request is retained. Check its saved status or retry the same request.":"1 of 3 · Choose a line, direct its read, then review the audition.");
  }
  function schedule(){clearTimeout(timer);const epoch=generation;if(panel.hidden||!state?.jobs.some(j=>["queued","running"].includes(j.status)))return;timer=setTimeout(async()=>{if(epoch!==generation||panel.hidden)return;if(busy||reloading){schedule();return;}reloading=true;try{await load(false);}catch(error){tell(error.message||"Could not refresh takes. Use Refresh saved takes to reconnect.",true);}finally{reloading=false;}},2000);}
  function close(){panel.hidden=true;generation++;clearTimeout(timer);stopMedia();}
  window.addEventListener("pagehide",close);
  let opener=null;
  return {async open(){if(!panel.contains(document.activeElement))opener=document.activeElement;if(!canEdit())return tell("Save or cancel the other open edit before opening voices.",true);panel.hidden=false;
      if(dirty||sceneDirty)return tell("Your unsubmitted performance changes are retained. Save or discard them before reloading.");
      await run(async()=>{tell("Loading screenplay voices and retained reads…");await prepare();try{const raw=sessionStorage.getItem(storageKey());pending=raw&&raw.length<64000?JSON.parse(raw):null;if(pending&&(!/^[a-f0-9-]{36}$/.test(pending.idempotencyKey)||typeof pending.sourceHash!=="string"))pending=null;}catch{pending=null;}await load(true);panel.scrollIntoView({block:"start"});});},get unsaved(){return dirty||sceneDirty||busy;},close};
}
