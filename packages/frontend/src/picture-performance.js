const emotions=["neutral","calm","joyful","sad","angry","fearful","surprised","determined"],intensities=["restrained","natural","heightened"],gestures=["hold-still","nod","shake-head","avert-gaze","open-palms","shrug","smile","frown"];
const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
let sequence=0;
function select(parent,label,choices){const wrap=node("div"),caption=node("label",label),input=node("select");input.id="picture-control-"+(++sequence);caption.htmlFor=input.id;wrap.className="cast-field";for(const [v,t]of choices)input.append(new Option(t,v));wrap.append(caption,input);parent.append(wrap);return input;}
const label=value=>value.replaceAll("-"," ");
const describe=controls=>[controls?.emotion?"emotion "+controls.emotion:"",controls?.intensity?"intensity "+controls.intensity:"",controls?.gestures?(controls.gestures.length?"gestures "+controls.gestures.map(label).join(", "):"no additional gestures"):""].filter(Boolean).join("; ")||"none";
export function pictureControlsEditor(parent,title,changed,inherit="No additional direction"){
  const panel=node("details");panel.append(node("summary",title));parent.append(panel);
  const emotion=select(panel,"Picture emotion",[["",inherit],...emotions.map(v=>[v,label(v)])]),intensity=select(panel,"Picture intensity",[["",inherit],...intensities.map(v=>[v,label(v)])]);
  const gestureMode=select(panel,"Picture gesture direction",[["",inherit],["none","Clear additional gestures"],["suggest","Suggest up to three gestures"]]),group=node("fieldset");group.append(node("legend","Gesture suggestions in order"));panel.append(group);
  const inputs=[1,2,3].map(i=>select(group,"Gesture "+i,[["","No gesture"],...gestures.map(v=>[v,label(v)])]));
  panel.append(node("p","These settings guide picture prompts. Intensity describes expression and movement; it is not a model strength slider. Gesture timing and acting accuracy must be judged in the result."));
  function update(){group.hidden=gestureMode.value!=="suggest";for(const input of inputs)input.disabled=group.hidden;}
  for(const input of [emotion,intensity,gestureMode,...inputs])input.addEventListener("change",()=>{update();changed();});
  update();return {read(){const result={};if(emotion.value)result.emotion=emotion.value;if(intensity.value)result.intensity=intensity.value;if(gestureMode.value){result.gestures=gestureMode.value==="none"?[]:inputs.map(e=>e.value).filter(Boolean);if(gestureMode.value==="suggest"&&!result.gestures.length)throw new Error("Choose a gesture or clear additional gestures.");if(new Set(result.gestures).size!==result.gestures.length)throw new Error("Choose each picture gesture only once.");}return Object.keys(result).length?result:undefined;},fill(value){emotion.value=value?.emotion??"";intensity.value=value?.intensity??"";gestureMode.value=value?.gestures?(value.gestures.length?"suggest":"none"):"";inputs.forEach((input,i)=>{input.value=value?.gestures?.[i]??"";});update();}};
}
export function pictureShotEditor(parent,changed){
  const panel=node("details");panel.append(node("summary","Character picture performances"));parent.append(panel);const content=node("div");panel.append(content);let entries=[],orphans=[];
  return {fill(settings,plan){entries=[];orphans=[];content.replaceChildren();const characters=plan?.pictureCharacters??[];
    content.append(node("p","Scene settings initialize each character. Override a field here or leave it inherited. Save the shot to bind these overrides to the scene you reviewed."));
    for(const c of characters){const card=node("article");card.className="cast-card";card.append(node("h4",c.name),node("p","Saved scene picture direction: "+describe(c.sceneControls)));const saved=settings?.picture?.find(v=>v.characterId===c.id);
      if(c.sceneStale)card.append(node("p","The saved scene intent is stale. Review it in the voice studio before rendering."));
      if(saved&&saved.baseRevision!==c.baseRevision)card.append(node("p","Character or scene context changed. Review the current scene settings above. Saving this shot rebinds your overrides to that context."));
      const editor=pictureControlsEditor(card,"Override "+c.name+" in this shot",changed,"Inherit scene direction");editor.fill(saved?.controls);content.append(card);entries.push({c,editor});}
    for(const saved of settings?.picture??[])if(!characters.some(c=>c.id===saved.characterId)){const row=node("article"),remove=node("button","Remove unavailable character override");remove.type="button";remove.className="secondary";row.append(node("p","A character from this saved override is no longer in the scene."),remove);content.append(row);const orphan={saved};orphans.push(orphan);remove.onclick=()=>{orphans=orphans.filter(v=>v!==orphan);row.remove();changed();};}
    if(!characters.length)content.append(node("p","Assign permitted fictional cast characters to this scene to direct their picture performance."));
  },read(){if(orphans.length)throw new Error("Remove the unavailable character overrides before saving.");const picture=entries.flatMap(({c,editor})=>{const controls=editor.read();return controls?[{characterId:c.id,baseRevision:c.baseRevision,controls}]:[];});return {picture:picture.length?picture:null};}};
}
export function showPictureReviews(parent,job){
  const renders=job.picturePerformances??[];if(!renders.length)return;const panel=node("details");panel.append(node("summary","Review retained picture performances"),node("p","These are the scene and shot settings used in this version's picture prompts. Review the video to judge emotion and gesture delivery. Later edits do not change this record."));parent.append(panel);
  for(let start=0;start<renders.length;start+=5){const section=node("details");section.append(node("summary","Shots "+(start+1)+"–"+Math.min(start+5,renders.length)));panel.append(section);
    for(const render of renders.slice(start,start+5)){const shot=node("details");shot.append(node("summary",render.shotId+" · scene "+render.intent.sceneNumber));for(const c of render.intent.characters)shot.append(node("p",c.name+": "+describe(c.controls)));section.append(shot);}
  }
}
