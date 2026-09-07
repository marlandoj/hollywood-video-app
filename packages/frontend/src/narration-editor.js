/** A reviewed cue sheet reuses retained narration; all media URLs come from the owner API. */
export function createNarrationEditor({parent,quote,node,details,field,button,changed,language,assetUrl}){
  const data=quote.narration??{takes:[],scenes:[],current:null},panel=details("Narration and voice-over tracks"),enabled=field(panel,"Include a reviewed narration mix","checkbox",Boolean(data.current)),controls=node("fieldset"),rows=node("div");
  panel.open=Boolean(data.current);controls.append(node("legend","Narration cue sheet"),node("p","Create a separate narration read in Voices and line auditions, then place its complete saved audio within the reviewed scene. Dialogue is lowered around measured narration speech. Each version keeps dry dialogue, narration, ducked dialogue and the final mix."),rows);panel.append(controls);parent.append(panel);
  let cues=[],nextCue=0;
  const reviewed=field(panel,"I listened to the narration takes and reviewed cue timing and ducking","checkbox",false);
  function update(){controls.disabled=!enabled.checked;reviewed.disabled=!enabled.checked;}
  enabled.onchange=()=>{update();changed();};
  const choiceText=t=>t.character+" · "+t.voiceLabel+" · scene "+(t.sceneIndex+1)+" · "+t.durationSec.toFixed(2)+" s · "+t.text.slice(0,70);
  function add(saved){
    if(cues.length>=64)throw new Error("Use up to 64 narration cues in one mix.");
    const id=saved?.id??crypto.randomUUID(),label="Cue "+(++nextCue),row=details(label),take=field(row,label+" narration take","select",saved?.auditionJobId??""),role=field(row,label+" role","select",saved?.role??"narration"),info=node("p"),listen=node("div");
    row.open=true;role.append(new Option("Narration","narration"),new Option("Voice-over","voice-over"));role.value=saved?.role??"narration";take.append(new Option("Choose a saved narration read",""));
    for(const t of data.takes){const option=new Option(choiceText(t),t.jobId);option.disabled=Boolean(t.unavailable);take.append(option);}take.value=saved?.auditionJobId??"";
    const start=field(row,label+" start (seconds)","number",saved?saved.startSample/22050:0,0,quote.durationSec),gain=field(row,label+" narration gain (dB)","number",saved?.gainDb??-6,-24,0),duck=field(row,label+" dialogue level during speech (dB)","number",saved?.duckDb??-12,-36,0),attack=field(row,label+" duck attack (milliseconds)","number",saved?.attackMs??100,0,1000),release=field(row,label+" duck release (milliseconds)","number",saved?.releaseMs??300,0,3000);
    start.step="any";gain.step=duck.step="0.1";row.append(info,listen);
    function describe(move=false){const selected=data.takes.find(t=>t.jobId===take.value);for(const audio of listen.querySelectorAll("audio"))audio.pause();listen.replaceChildren();
      const windows=selected?data.scenes.filter(s=>s.sceneIndex===selected.sceneIndex):[];
      info.textContent=selected?selected.text+" · "+selected.durationSec.toFixed(3)+" s · "+(selected.unavailable??"Scene window: "+windows.map(w=>(w.startSample/22050).toFixed(3)+"–"+(w.endSample/22050).toFixed(3)+" s").join(", ")):"Choose a retained narration take to inspect its text and timing.";
      if(move&&windows[0])start.value=windows[0].startSample/22050;
      if(selected?.audioUrl&&!selected.unavailable){const audio=node("audio");audio.controls=true;audio.preload="metadata";audio.src=assetUrl(selected.audioUrl);audio.setAttribute("aria-label",label+" retained narration");audio.onplay=()=>{for(const other of document.querySelectorAll("audio,video"))if(other!==audio)other.pause();};listen.append(audio);}
    }
    take.onchange=()=>describe(true);describe();
    const cue={id,row,read(){const selected=data.takes.find(t=>t.jobId===take.value&&!t.unavailable);if(!selected)throw new Error("Choose an available narration take for "+label+".");if(selected.language!==language())throw new Error("Choose narration in the export's dialogue language.");
      for(const input of [start,gain,duck,attack,release])if(!input.checkValidity())throw new Error("Correct the timing or mix level for "+label+".");
      const startSample=Math.round(Number(start.value)*22050),endSample=startSample+Math.round(selected.durationSec*22050);if(!data.scenes.some(w=>w.sceneIndex===selected.sceneIndex&&startSample>=w.startSample&&endSample<=w.endSample))throw new Error("Place the complete "+label+" read inside its reviewed scene window.");
      return {id,role:role.value,startSample,gainDb:Number(gain.value),duckDb:Number(duck.value),attackMs:Number(attack.value),releaseMs:Number(release.value),auditionJobId:selected.jobId,auditionRevision:selected.revision};}};
    row.append(button("Remove "+label,()=>{for(const audio of row.querySelectorAll("audio"))audio.pause();cues=cues.filter(c=>c!==cue);row.remove();changed();}));cues.push(cue);rows.append(row);
  }
  controls.append(button("Add narration cue",()=>{add();changed();}));
  for(const saved of data.current?.cues??[])add(saved);update();
  return {reviewed,invalidate(){reviewed.checked=false;},read(){if(!enabled.checked){if(data.current)throw new Error("To remove narration, keep the mix enabled, remove its cues and review the empty track.");return undefined;}
    if(!reviewed.checked)throw new Error("Listen to the narration takes and confirm review of their timing and ducking.");if(!cues.length&&!data.current)throw new Error("Add a narration cue before reviewing a new mix.");return {language:language(),reviewed:true,cues:cues.map(c=>c.read())};},describe(parent,request){if(!request)return;
    parent.append(node("h3","Reviewed narration mix"),node("p",request.cues.length?"Narration is mixed with ducked dialogue. Overlapping cues add together; overlapping duck envelopes use the lower dialogue level. A mix that would clip is rejected. Dry dialogue remains available.":"This version removes narration and restores the dry dialogue mix."));
    for(const cue of request.cues){const take=data.takes.find(t=>t.jobId===cue.auditionJobId);parent.append(node("p",cue.role+" · "+take.character+" · "+take.text),node("p",(cue.startSample/22050).toFixed(3)+" s · "+take.durationSec.toFixed(3)+" s read · narration "+cue.gainDb+" dB · dialogue "+cue.duckDb+" dB · attack "+cue.attackMs+" ms / release "+cue.releaseMs+" ms"));}
  }};
}
