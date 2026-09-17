const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
const details=label=>{const e=node("details");e.append(node("summary",label));return e;};
function field(parent,label,kind="number",min=0,max=3000){const wrap=node("div"),caption=node("label",label),e=node(kind==="textarea"?"textarea":kind==="select"?"select":"input");e.id="voice-"+crypto.randomUUID();caption.htmlFor=e.id;wrap.className="cast-field";if(kind==="number"){e.type=kind;e.min=min;e.max=max;e.step=1;}if(kind==="checkbox")e.type=kind;if(kind==="textarea"){e.rows=3;e.maxLength=8000;}wrap.append(caption,e);parent.append(wrap);return e;}
export function characterVoice(parent){
  const box=details("Character voice · temporary speech"),voice=field(box,"Built-in voice","select");
  voice.append(new Option("Default reader (no assignment)",""));
  for(const [id,label]of [["en-us","US English · plain"],["en-us+f3","US English · bright"],["en-us+m3","US English · low"],["en-gb","British English · plain"]])voice.append(new Option(label,id));
  box.append(node("p","Local synthetic voices for reviewing dialogue. Assigning one requires a speech-enabled storyboard provider. These are temporary voices, with no voice cloning or lip-sync."));
  const pace=field(box,"Character pace (words per minute)","number",80,300),advanced=details("Pitch, level and pronunciation"),pitch=field(advanced,"Character pitch (0–99)","number",0,99),level=field(advanced,"Character level (20–150)","number",20,150),dictionary=field(advanced,"Pronunciations (one word = spoken replacement per line)","textarea");
  box.append(advanced);parent.append(box);
  return {fill(value){voice.value=value?.voice??"";pace.value=value?.rateWpm??175;pitch.value=value?.pitch??50;level.value=value?.level??100;dictionary.value=(value?.pronunciations??[]).map(p=>p.word+" = "+p.say).join("\n");},read(){if(!voice.value)return {};const pronunciations=dictionary.value.split(/\r?\n/).filter(s=>s.trim()).map(line=>{const i=line.indexOf("=");if(i<1)throw new Error("Use word = spoken replacement for each pronunciation.");return {word:line.slice(0,i).trim(),say:line.slice(i+1).trim()};});return {voice:{engine:"espeak-ng",voice:voice.value,rateWpm:Number(pace.value),pitch:Number(pitch.value),level:Number(level.value),pronunciations}};}};
}
export function linePerformances(parent,changed){
  const box=details("Dialogue lines and performances"),list=node("div"),status=node("p");let rows=[],orphans=[],hadLines=false;
  box.append(node("p","Each spoken screenplay line uses its character's voice. Override pace, pitch, level and pauses here. Parentheticals and acting notes are preserved as direction and are not spoken. Emotion and lip-sync still require production tools."),list,status);parent.append(box);
  return {fill(settings,plan){hadLines=settings.lines!==undefined;rows=[];orphans=[];list.replaceChildren();status.textContent="";const sources=plan?.performanceLines??[];
    const edits=settings.lines??[];orphans=edits.filter(e=>!sources.some(s=>s.index===e.index));
    if(orphans.length){const remove=node("button","Discard directions for removed lines");remove.type="button";remove.className="secondary";remove.onclick=()=>{orphans=[];remove.remove();changed();};list.append(node("p","Some directed lines were removed. Discard their directions or cancel this edit."),remove);}
    if(!sources.length)list.append(node("p","This shot has no spoken lines."));
    for(const source of sources){const saved=edits.find(e=>e.index===source.index),row=details((source.index+1)+". "+source.character+" · "+source.text.slice(0,100)),enabled=field(row,"Direct line "+(source.index+1),"checkbox");enabled.checked=Boolean(saved);row.append(node("p",source.text));if(source.cues.length)row.append(node("p","Screenplay direction: "+source.cues.join(" ")));
      let sourceHash=saved?.sourceHash??source.hash;
      if(sourceHash!==source.hash){const review=node("button","Use current source for line "+(source.index+1));review.type="button";review.className="secondary";review.onclick=()=>{sourceHash=source.hash;review.remove();changed();};row.append(node("p","This line changed. Review the current text before applying its saved performance."),review);}
      const pace=field(row,"Line "+(source.index+1)+" pace (blank = character default)","number",80,300),pauses=details("Pauses and vocal settings"),before=field(pauses,"Line "+(source.index+1)+" leading pause (milliseconds)"),after=field(pauses,"Line "+(source.index+1)+" trailing pause (milliseconds)"),pitch=field(pauses,"Line "+(source.index+1)+" pitch (blank = character default)","number",0,99),level=field(pauses,"Line "+(source.index+1)+" level (blank = character default)","number",20,150),notesBox=details("Acting notes · direction only"),notes=field(notesBox,"Line "+(source.index+1)+" acting notes","textarea");notes.maxLength=600;
      pace.value=saved?.rateWpm??"";pitch.value=saved?.pitch??"";level.value=saved?.level??"";before.value=saved?.beforeMs??0;after.value=saved?.afterMs??200;notes.value=saved?.notes??"";
      row.append(pauses,notesBox);list.append(row);rows.push(()=>{if(!enabled.checked)return null;if(sourceHash!==source.hash)throw new Error("Review the changed source for line "+(source.index+1)+" before saving.");return {index:source.index,sourceHash,rateWpm:pace.value===""?null:Number(pace.value),pitch:pitch.value===""?null:Number(pitch.value),level:level.value===""?null:Number(level.value),beforeMs:Number(before.value),afterMs:Number(after.value),notes:notes.value};});
    }
  },read(){if(orphans.length)throw new Error("Discard directions for removed lines before saving.");const lines=rows.map(read=>read()).filter(Boolean);return lines.length||hadLines?{lines}:{};}};
}
import {createSpeechPlayer} from "./speech-player.js";
import {claimAudioFocus,listenAudioFocus} from './audio-focus.js';
const linePlayer=createSpeechPlayer();
const lineFocus=Symbol('retained-line-review');
export function stopSpeechPlayback(){linePlayer.stop();}
if(typeof window!=="undefined")listenAudioFocus(lineFocus,stopSpeechPlayback);
const reviewCleanup=new WeakMap();
import {showPictureReviews} from "./picture-performance.js";
import {applyBusy} from "./busy.js";
export function describeLineDelivery(line){
  const take=line.audition?.source.take;
  if(!take)return line.voice.voice+" · "+line.voice.rateWpm+" words/min · pitch "+line.voice.pitch+" · level "+line.voice.level;
  const controls=take.line.profile.controls;
  return take.policy.label+" · "+(take.line.profile.provider==="azure"?controls.style+" · intensity "+controls.intensity:controls.emotion)+" · speed "+controls.speed+" · volume "+controls.volume+" · retained audition";
}
export function showSpeechReviews(container,job,assetUrl=path=>path){
  container.classList.add("speech-review");
  reviewCleanup.get(container)?.();reviewCleanup.set(container,stopSpeechPlayback);
  for(const audio of container.querySelectorAll("audio")){audio.pause();audio.removeAttribute("src");audio.load();}container.replaceChildren();
  showPictureReviews(container,job);const renders=(job.shotRenders??[]).filter(r=>r.speech&&r.audioUrl);
  if(job.dialogue?.report&&job.output?.audioUrl){const groups=new Map();for(const line of job.dialogue.report.lines){if(!groups.has(line.shotId))groups.set(line.shotId,[]);groups.get(line.shotId).push({...line,originalText:line.source.text,source:{...line.source,text:line.text}});}for(const [shotId,lines]of groups)renders.push({shotId,speech:{sampleRate:job.dialogue.report.sampleRate,totalSamples:job.dialogue.report.totalSamples,lines},audioUrl:job.output.audioUrl});}
  if(!renders.length)return;
  const group=details("Review character voices and line reads");group.append(node("p","Listen to retained dialogue lines or download the lossless audio. Spoken cuts use straight joins to preserve complete words."));
  for(const render of renders){const url=assetUrl(render.audioUrl),shot=details(render.shotId+" · "+render.speech.lines.length+" lines"),audio=node("audio"),status=node("p"),download=node("a","Download dialogue WAV"),stop=node("button","Stop line playback");audio.controls=true;audio.preload="none";audio.src=url;audio.style.maxWidth="100%";download.href=url;download.className="button-link";stop.type="button";stop.className="secondary";stop.disabled=true;stop.onclick=stopSpeechPlayback;status.setAttribute("role","status");status.setAttribute("aria-live","polite");
    audio.onplay=()=>{stopSpeechPlayback();for(const other of document.querySelectorAll("audio,video"))if(other!==audio)other.pause();};audio.onerror=()=>{status.textContent="Audio is unavailable. Reload this result to refresh its private link.";};shot.append(audio,download,stop,status);
    for(const line of render.speech.lines){const row=details((line.source.index+1)+". "+line.source.character+" · "+line.source.text.slice(0,100)),play=node("button","Play line "+(line.source.index+1)+" · "+line.source.character);play.type="button";play.className="secondary";
      let active=false;
      play.onclick=()=>{if(active){stopSpeechPlayback();return;}claimAudioFocus(lineFocus);void linePlayer.play({url,report:render.speech,line,onState(state){
        active=["loading","playing"].includes(state);stop.disabled=!active;play.textContent=(active?"Stop":"Play")+" line "+(line.source.index+1)+" · "+line.source.character;applyBusy(play,state==="loading");const label="Line "+(line.source.index+1)+" · "+line.source.character;
        status.textContent=state==="loading"?"Loading "+label+"…":state==="playing"?"Playing "+label+".":state==="finished"?label+" finished.":state==="stopped"?label+" stopped.":"Line audio is unavailable or changed. Reload this result and try again.";
      }});};
      const delivery=describeLineDelivery(line);
      row.append(node("p",line.source.text),node("p",delivery+" · "+((line.endSample-line.startSample)/render.speech.sampleRate).toFixed(2)+" s"),play);
      if(line.originalText&&line.originalText!==line.source.text)row.append(node("p","Original read: "+line.originalText));if(line.notes)row.append(node("p","Acting direction: "+line.notes));if(line.spokenText!==line.source.text)row.append(node("p","Pronunciation read: "+line.spokenText));shot.append(row);
    }group.append(shot);
  }container.append(group);
}
