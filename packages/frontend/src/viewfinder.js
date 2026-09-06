/** Crop the retained source in the browser; the renderer applies the same saved rectangle. */
export function initViewfinder({parent,assetUrl,direction,applyDirection,changed,canEdit}) {
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const details=title=>{const e=node("details");e.append(node("summary",title));return e;};
  const button=(label,action)=>{const e=node("button",label);e.type="button";e.className="secondary";e.onclick=action;return e;};
  let defaults=null,opticsDefaults=null,presets=[],crop={x:0,y:0,size:10000},hasFraming=false,hasOptics=false,drag=null;
  const group=node("fieldset"),sourceLabel=node("p"),empty=node("p"),source=node("figure"),stage=node("div"),image=node("img"),box=node("div"),output=node("figure"),screen=node("div"),framed=node("img"),readout=node("p"),status=node("p");
  group.append(node("legend","Storyboard viewfinder"));sourceLabel.className="viewfinder-source";
  stage.className="viewfinder-source-stage";image.alt="Uncropped storyboard source";image.draggable=false;box.className="viewfinder-crop";box.setAttribute("aria-hidden","true");
  stage.append(image,box);source.append(stage,node("figcaption","Drag the rectangle to frame the shot, or use the position controls below."));
  screen.className="viewfinder-screen";framed.alt="Framed storyboard preview";framed.draggable=false;screen.append(framed);output.append(screen,node("figcaption","Framed still before storyboard motion and captions"));
  const figures=node("div");figures.className="viewfinder-figures";figures.append(output,source);
  group.append(sourceLabel,empty,figures,readout);const controls=new Map(),labels=new Map();
  for(const [key,label,min,max]of [["size","Frame width and height",2500,10000],["x","Horizontal crop position",0,0],["y","Vertical crop position",0,0]]){
    const wrapper=node("div"),caption=node("label"),input=node("input");wrapper.className="cast-field";input.id="viewfinder-"+key;caption.htmlFor=input.id;input.type="range";input.min=min;input.max=max;input.step=1;
    controls.set(key,input);labels.set(key,{caption,label});input.oninput=()=>setCrop(key,Number(input.value));
    input.onkeydown=event=>{const sign=["ArrowRight","ArrowUp"].includes(event.key)?1:["ArrowLeft","ArrowDown"].includes(event.key)?-1:0;if(!sign)return;event.preventDefault();setCrop(key,Math.max(Number(input.min),Math.min(Number(input.max),crop[key]+sign*(event.shiftKey?1000:100))));};
    wrapper.append(caption,input);group.append(wrapper);
  }
  group.append(button("Reset to full frame",()=>{if(!canEdit())return;crop={...defaults};hasFraming=false;refresh();changed();status.textContent="Full frame restored in this draft. Save shot direction to keep it.";}),
    node("p","The saved crop is applied to each new render and resized to its output dimensions. Zooming retains fewer source pixels. Lens settings guide generation; they do not change perspective or depth of field in this still."));
  const camera=details("Camera presets and modeled optics"),preset=node("select"),presetLabel=node("label","Camera preset"),presetNote=node("p"),sensor=details("Edit modeled sensor and look"),opticsInputs=new Map(),fov=node("p");
  preset.id="viewfinder-preset";presetLabel.htmlFor=preset.id;const presetField=node("div");presetField.className="cast-field";presetField.append(presetLabel,preset);camera.append(presetField,presetNote);
  preset.onchange=()=>{presetNote.textContent=presets.find(value=>value.id===preset.value)?.description??"Choose a starting point, then edit its settings.";};
  camera.append(button("Apply camera preset to draft",()=>{if(!canEdit())return;const value=presets.find(value=>value.id===preset.value);if(!value){status.textContent="Choose a camera preset to apply.";return;}
    applyDirection(value.settings);fillOptics(value.settings.optics);hasOptics=true;refresh();changed();status.textContent=value.name+" applied to this draft’s focal length, lens type, movement intent and modeled optics. Save shot direction to keep it.";}));
  for(const [key,label,min,max]of [["sensorWidthMm","Modeled sensor width in mm",1,100],["sensorHeightMm","Modeled sensor height in mm",1,100],["squeeze","Modeled lens squeeze",1,2]]){
    const wrapper=node("div"),caption=node("label",label),input=node("input");wrapper.className="cast-field";input.id="viewfinder-"+key;caption.htmlFor=input.id;input.type="number";input.min=min;input.max=max;input.step="any";input.required=true;
    input.oninput=()=>{hasOptics=true;refresh();};wrapper.append(caption,input);sensor.append(wrapper);opticsInputs.set(key,input);
  }
  const lookField=node("div"),lookLabel=node("label","Camera look intent"),look=node("textarea");lookField.className="cast-field";look.id="viewfinder-look";lookLabel.htmlFor=look.id;look.rows=3;look.maxLength=400;look.oninput=()=>{hasOptics=true;};lookField.append(lookLabel,look);sensor.append(lookField);opticsInputs.set("look",look);
  sensor.append(button("Reset modeled optics",()=>{if(!canEdit())return;fillOptics(opticsDefaults);hasOptics=false;refresh();changed();status.textContent="Modeled optics reset in this draft; the focal length and crop are kept.";}));
  camera.append(fov,sensor,node("p","This field-of-view estimate uses rays through a modeled sensor at infinity focus. Squeeze expands its horizontal model. It does not measure the generated image or simulate lens distortion, bokeh or anamorphic de-squeezing. Set focal length under Composition and lens intent."));
  status.setAttribute("role","status");parent.append(group,camera,status);
  function getOptics(){return Object.fromEntries([...opticsInputs].map(([key,input])=>[key,key==="look"?input.value:Number(input.value)]));}
  function fillOptics(value){for(const [key,input]of opticsInputs)input.value=value[key];}
  function setCrop(key,value){if(!canEdit())return;if(key==="size"){
      const centerX=crop.x+crop.size/2,centerY=crop.y+crop.size/2;crop={size:value,x:Math.round(Math.max(0,Math.min(10000-value,centerX-value/2))),y:Math.round(Math.max(0,Math.min(10000-value,centerY-value/2)))};
    }else crop={...crop,[key]:value};hasFraming=crop.size<10000;refresh();changed();}
  function refresh(){
    for(const [key,input]of controls){input.max=key==="size"?10000:10000-crop.size;input.value=crop[key];const value=String(Number((crop[key]/100).toFixed(2)));labels.get(key).caption.textContent=labels.get(key).label+" · "+value+"%";input.setAttribute("aria-valuetext",value+" percent");}
    Object.assign(box.style,{left:crop.x/100+"%",top:crop.y/100+"%",width:crop.size/100+"%",height:crop.size/100+"%"});
    Object.assign(framed.style,{left:-crop.x/crop.size*100+"%",top:-crop.y/crop.size*100+"%",width:10000/crop.size*100+"%"});
    readout.textContent=(10000/crop.size).toFixed(2)+"× digital zoom · "+(crop.size**2/1000000).toFixed(1)+"% of source pixels retained";
    const optics=getOptics(),lens=Number(direction().lensMm);if(!Number.isFinite(lens)||lens<8||lens>1000||![optics.sensorWidthMm,optics.sensorHeightMm].every(n=>Number.isFinite(n)&&n>=1&&n<=100)||!Number.isFinite(optics.squeeze)||optics.squeeze<1||optics.squeeze>2){fov.textContent="Enter valid sensor dimensions and a focal length to calculate the modeled field of view.";return;}
    const angle=(dimension,start)=>(Math.atan(dimension*((start+crop.size)/10000-.5)/lens)-Math.atan(dimension*(start/10000-.5)/lens))*180/Math.PI;
    fov.textContent="Modeled angular field of view with this crop: "+angle(optics.sensorWidthMm*optics.squeeze,crop.x).toFixed(1)+"° horizontal × "+angle(optics.sensorHeightMm,crop.y).toFixed(1)+"° vertical.";
  }
  function point(event){const rect=stage.getBoundingClientRect();return {x:(event.clientX-rect.left)/rect.width*10000,y:(event.clientY-rect.top)/rect.height*10000};}
  stage.onpointerdown=event=>{if(!canEdit()||event.button!==0||!image.complete||!image.naturalWidth)return;const p=point(event),inside=p.x>=crop.x&&p.x<=crop.x+crop.size&&p.y>=crop.y&&p.y<=crop.y+crop.size;
    drag={id:event.pointerId,x:inside?p.x-crop.x:crop.size/2,y:inside?p.y-crop.y:crop.size/2};stage.setPointerCapture(event.pointerId);move(event);};
  function move(event){if(!drag||drag.id!==event.pointerId||!canEdit())return;const p=point(event);crop={...crop,x:Math.round(Math.max(0,Math.min(10000-crop.size,p.x-drag.x))),y:Math.round(Math.max(0,Math.min(10000-crop.size,p.y-drag.y)))};hasFraming=crop.size<10000;refresh();changed();}
  stage.onpointermove=move;stage.onpointerup=stage.onpointercancel=()=>{drag=null;};
  image.onload=()=>{screen.style.aspectRatio=String(image.naturalWidth/image.naturalHeight);};
  image.onerror=()=>{figures.hidden=true;empty.hidden=false;empty.textContent="The source image could not be loaded. Reload the shot plan to refresh its link. Your crop stays in this draft.";};
  return {refresh,read:()=>({...hasFraming?{framing:{...crop}}:{},...hasOptics?{optics:getOptics()}:{}}),
    fill(values,state,shotId){defaults=state.framingDefaults;opticsDefaults=state.opticsDefaults;presets=state.cameraPresets;crop={...(values.framing??defaults)};hasFraming=Boolean(values.framing);hasOptics=Boolean(values.optics);fillOptics(values.optics??opticsDefaults);drag=null;
      preset.replaceChildren(new Option("Choose a camera preset",""));for(const value of presets)preset.append(new Option(value.name,value.id));presetNote.textContent="Presets copy editable settings into this draft.";status.textContent="";
      const latest=state.viewfinderSources.find(value=>value.shotId===shotId);figures.hidden=!latest;empty.hidden=Boolean(latest);sourceLabel.textContent=latest?"Storyboard from direction version "+latest.directionVersion+". Matches the current shot and cast. New generation may change the image.":"No matching storyboard source yet.";sourceLabel.dataset.sourceJobId=latest?.jobId??"";
      empty.textContent="Create a storyboard preview to frame this shot visually. You can still set its crop below. The source must match the current screenplay shot and cast.";
      if(latest){image.src=assetUrl(latest.url);framed.src=image.src;}else {image.removeAttribute("src");framed.removeAttribute("src");}refresh();}
  };
}
