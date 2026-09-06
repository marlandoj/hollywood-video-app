/** Screen-space camera curve editor. Crop handles and keyboard controls share one selected keyframe. */
export function initCameraPath({parent,readCrop,showCrop,changed,canEdit,durationFrames}) {
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const button=(text,action)=>{const e=node("button",text);e.type="button";e.className="secondary";e.onclick=()=>{if(canEdit())action();};return e;};
  const group=node("details"),body=node("div"),status=node("p"),select=node("select"),time=node("input"),easing=node("select"),preview=node("details"),scrub=node("input"),readout=node("p");
  let keyframes=[],selected=0,base=null;
  group.className="camera-path-editor";group.append(node("summary","Timed camera framing"));
  group.append(node("p","Move and zoom a digital crop through the shot. The path uses the uncropped source and replaces the static crop during rendering. It does not create 3D perspective or move subjects. Frame anchors cannot be combined with this path."));
  const toggle=button("Add camera path",()=>{
    if(keyframes.length){keyframes=[];showCrop(base.crop,base.hasFraming);base=null;}
    else {base=structuredClone(readCrop());keyframes=[{...base.crop,at:0,easing:"smooth"},{...base.crop,at:10000,easing:"linear"}];selected=0;}
    render();changed();status.textContent=keyframes.length?"Path added to this draft. Choose a keyframe, then drag the viewfinder rectangle or use its position controls. Save shot direction to keep it.":"Path removed in this draft. The retained static crop is restored.";
  });
  function field(parent,input,label,id){const wrapper=node("div"),caption=node("label",label);wrapper.className="cast-field";input.id=id;caption.htmlFor=id;wrapper.append(caption,input);parent.append(wrapper);}
  field(body,select,"Camera keyframe","camera-keyframe");field(body,time,"Keyframe time in percent","camera-keyframe-time");time.type="number";time.min=0;time.max=100;time.step=.01;time.required=true;
  for(const [value,label]of [["linear","Linear"],["smooth","Smooth start and stop"]])easing.append(new Option(label,value));
  field(body,easing,"Motion to the next keyframe","camera-keyframe-easing");
  select.onchange=event=>{event.stopPropagation();if(!time.disabled&&!time.validity.valid){select.value=String(selected);status.textContent="Correct this keyframe time before selecting another keyframe.";return;}selected=Number(select.value);render();showSelected();};
  time.oninput=()=>{if(!canEdit()||!selected||selected===keyframes.length-1)return;const at=Math.round(Number(time.value)*100);
    if(time.value===""||!Number.isInteger(at)||at<=keyframes[selected-1].at||at>=keyframes[selected+1].at){status.textContent="Choose a time between the neighboring keyframes.";time.setCustomValidity(status.textContent);return;}
    time.setCustomValidity("");keyframes[selected].at=at;select.options[selected].textContent="Keyframe "+(selected+1)+" · "+at/100+"%";showSelected();changed();status.textContent="Keyframe time updated in this draft. Save shot direction to keep it.";};
  easing.onchange=()=>{if(!canEdit())return;keyframes[selected].easing=easing.value;changed();};
  const actions=node("div");actions.className="result-actions";
  const add=button("Insert keyframe after this one",()=>{const a=keyframes[selected],b=keyframes[selected+1];if(keyframes.length>=8||!b||b.at-a.at<2)return;
    const at=Math.floor((a.at+b.at)/2),crop=sample(at);keyframes.splice(++selected,0,{...crop,at,easing:a.easing});render();showSelected();changed();status.textContent="Intermediate keyframe added. Adjust its position and timing, then save shot direction.";});
  const remove=button("Remove this keyframe",()=>{if(!selected||selected===keyframes.length-1)return;keyframes.splice(selected,1);selected--;render();showSelected();changed();status.textContent="Intermediate keyframe removed from this draft.";});
  actions.append(add,remove);body.append(actions,node("p","First and last keyframes stay at 0% and 100%. Easing controls the interval after the selected keyframe. Times snap to output frames; closely spaced points may require a longer shot."));
  preview.append(node("summary","Preview camera path"));scrub.type="range";scrub.min=0;scrub.max=10000;scrub.step=1;field(preview,scrub,"Camera path preview position","camera-path-preview");preview.append(readout,node("p","Scrub this still to inspect framing. A new render can contain a different image or subject movement."));
  scrub.oninput=event=>{event.stopPropagation();const at=Number(scrub.value);showCrop(sample(at),true);describePreview(at);};scrub.onchange=event=>event.stopPropagation();
  body.append(preview);status.setAttribute("role","status");group.append(toggle,body,status);parent.append(group);
  function frames(){const count=Number(durationFrames());return Number.isInteger(count)&&count>=30&&count<=900?count:301;}
  function sample(at){const count=frames(),position=Math.round(at*(count-1)/10000),positions=keyframes.map(p=>Math.round(p.at*(count-1)/10000));let i=0;while(i<keyframes.length-2&&position>positions[i+1])i++;
    const a=keyframes[i],b=keyframes[i+1],t=Math.min(1,Math.max(0,(position-positions[i])/Math.max(1,positions[i+1]-positions[i]))),u=a.easing==="smooth"?t*t*(3-2*t):t;
    const size=Math.round(a.size+(b.size-a.size)*u);return {x:Math.min(10000-size,Math.round(a.x+(b.x-a.x)*u)),y:Math.min(10000-size,Math.round(a.y+(b.y-a.y)*u)),size};}
  function describePreview(at){const count=Number(durationFrames()),frame=Number.isInteger(count)&&count>=30?Math.round(at*(count-1)/10000):null;
    readout.textContent=(at/100).toFixed(2)+"% through the path"+(frame===null?" · normalized preview; automatic shot duration is set during rendering":" · output frame "+frame+" of "+(count-1));scrub.setAttribute("aria-valuetext",readout.textContent);}
  function showSelected(){if(!keyframes.length)return;const p=keyframes[selected];showCrop({x:p.x,y:p.y,size:p.size},true);scrub.value=p.at;describePreview(p.at);}
  function render(){body.hidden=!keyframes.length;time.required=keyframes.length>0;time.disabled=!keyframes.length;toggle.textContent=keyframes.length?"Remove camera path and restore static crop":"Add camera path";
    select.replaceChildren(...keyframes.map((p,i)=>new Option((i===0?"First":i===keyframes.length-1?"Last":"Keyframe "+(i+1))+" · "+(p.at/100)+"%",String(i))));select.value=String(selected);
    time.setCustomValidity("");if(!keyframes.length)return;const p=keyframes[selected];time.value=p.at/100;time.disabled=selected===0||selected===keyframes.length-1;easing.value=p.easing;easing.disabled=selected===keyframes.length-1;
    add.disabled=keyframes.length>=8||selected===keyframes.length-1||keyframes[selected+1].at-p.at<2;remove.disabled=selected===0||selected===keyframes.length-1;
    showSelected();}
  return {get enabled(){return keyframes.length>0;},get retained(){return base;},
    read:()=>{if(!time.disabled&&!time.validity.valid)throw new Error("Choose a camera keyframe time between its neighbors before saving or reloading.");return keyframes.length?{cameraPath:{mode:"screen-space",keyframes:structuredClone(keyframes)}}:{};},
    cropChanged(crop){if(!keyframes.length)return;Object.assign(keyframes[selected],crop);scrub.value=keyframes[selected].at;describePreview(keyframes[selected].at);},
    fill(values){keyframes=structuredClone(values.cameraPath?.keyframes??[]);selected=0;base=keyframes.length?structuredClone(readCrop()):null;status.textContent="";render();},
  };
}
