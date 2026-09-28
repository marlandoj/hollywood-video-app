/** Owner-only image bytes; editing the anchor list remains a draft until direction is saved. */
export function initFrameAnchors({parent,request,image,context,changed,locked,tell}) {
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const button=(text,action)=>{const e=node("button",text);e.type="button";e.className="secondary";e.onclick=action;return e;};
  let frames=[],catalog=[],generation=0;const urls=new Set();
  const intro=node("p","Add up to five images, starting with a first frame. Other anchors can mark the last frame or intermediate times. Previews dissolve between your images and hold the final image. Use Automatic or Static storyboard motion. The viewfinder crop applies to every image; captions are added afterward."),list=node("div"),fallback=node("input"),fallbackLabel=node("label"),upload=node("details");
  fallback.type="checkbox";fallback.id="anchor-fallback";fallbackLabel.className="attestation";fallbackLabel.htmlFor=fallback.id;
  fallbackLabel.append(fallback,document.createTextNode("Allow a storyboard of these images when a final video provider cannot use these anchors"));
  fallback.onchange=()=>changed();
  const disclosure=node("p","Final video requires a configured provider that supports these anchor times. With fallback enabled, a final may use still-image dissolves with no generated subject motion. Cast reference images are not reapplied to this storyboard; update the anchors when a character changes. Native results may differ from the supplied images.");
  const add=button("Add frame anchor",()=>{if(frames.length>=5)return;const available=frames.length?([10000,5000,2500,7500].find(at=>!frames.some(f=>f.at===at))??5000):0;frames.push({at:available,asset:null});frames.sort((a,b)=>a.at-b.at);changed();render();});
  upload.append(node("summary","Upload a private anchor image"));
  const file=node("input"),label=node("input"),attested=node("input");file.type="file";file.accept="image/png,image/jpeg";file.id="anchor-file";label.id="anchor-label";label.maxLength=120;label.placeholder="For example: opening at the gate";attested.type="checkbox";attested.id="anchor-attested";
  for(const [input,text]of [[file,"PNG or JPEG image"],[label,"Image label"]]){const wrapper=node("div"),caption=node("label",text);wrapper.className="cast-field";caption.htmlFor=input.id;wrapper.append(caption,input);upload.append(wrapper);}
  const consent=node("label");consent.className="attestation";consent.htmlFor=attested.id;consent.append(attested,document.createTextNode("I have permission to use this image and share it with the selected rendering provider"));upload.append(consent);
  upload.append(button("Store anchor image",async()=>{
    if(!file.files?.length)return tell("Choose a PNG or JPEG image first.",true);
    if(!attested.checked)return tell("Confirm permission to use this image before uploading.",true);
    const current=context();if(!current?.shot?.sourceHash)return tell("Reload and review the current source shot before uploading.",true);
    tell("Uploading private anchor image…");
    try{await locked(async()=>{
      const result=await request(`/${current.shot.source.id}/anchors?maxShots=${current.state.maxShots}&label=${encodeURIComponent(label.value.trim()||"Frame anchor")}`,{method:"POST",body:file.files[0],headers:{"content-type":file.files[0].type,"x-hv-reference-attested":"true","x-hv-direction-version":String(current.state.direction.version),"x-hv-script-version":String(current.state.scriptVersion),"x-hv-source-hash":current.shot.sourceHash}});
      catalog.push(result.asset);current.state.anchorAssets=catalog.slice();
      const empty=frames.find(f=>!f.asset);if(empty){empty.asset=result.asset;changed();}
      else if(!frames.length){frames=[{at:0,asset:result.asset}];changed();}
      file.value="";label.value="";attested.checked=false;
    });render();tell("Private image stored. Choose its anchor time, then save shot direction.");}
    catch(error){tell(error.message||"Could not store the image. Your shot draft is still here.",true);}
  }),node("p","Uploads are normalized to PNG, up to 1024 pixels per side. A project retains up to 96 images across cast references and frame anchors, including unused uploads and historical revisions."));
  parent.append(intro,list,add,fallbackLabel,disclosure,upload);
  /** One anchor's thumbnail, drawn into its own holder; a newer render or choice makes an older load moot. */
  function thumbnail(holder,frame,revision){
    const asked=holder.asked=(holder.asked??0)+1;holder.replaceChildren();if(!frame.asset)return;
    const figure=node("figure"),img=node("img");figure.className="anchor-thumbnail";img.alt=frame.asset.source?.label||"Frame anchor";figure.append(img);holder.append(figure);
    image(frame.asset.id).then(blob=>{if(generation!==revision||holder.asked!==asked)return;const url=URL.createObjectURL(blob);urls.add(url);img.src=url;}).catch(()=>{if(generation===revision&&holder.asked===asked)figure.append(node("p","Image unavailable. Reload or choose another image."));});
  }
  function render(){
    const revision=++generation;for(const url of urls)URL.revokeObjectURL(url);urls.clear();list.replaceChildren();add.disabled=frames.length>=5;
    for(const [index,frame]of frames.entries()){
      const row=node("fieldset"),legend=node("legend",frame.at===0?"First frame":frame.at===10000?"Last frame":"Intermediate frame");row.append(legend);row.className="anchor-row";
      const time=node("input");time.type="number";time.min=0;time.max=100;time.step=.01;time.required=true;time.value=String(frame.at/100);time.disabled=index===0;time.id=`anchor-time-${index}`;
      const caption=node("label","Anchor time (%)");caption.htmlFor=time.id;row.append(caption,time);time.oninput=()=>{frame.at=Math.round(Number(time.value)*100);changed();};
      const select=node("select"),selectLabel=node("label","Private image");select.id=`anchor-image-${index}`;selectLabel.htmlFor=select.id;select.required=true;select.append(new Option("Choose an image", ""));
      const shot=context()?.shot?.source.id,available=catalog.filter(asset=>asset.source?.shotId===shot||asset.id===frame.asset?.id);
      if(frame.asset&&!available.some(asset=>asset.id===frame.asset.id))available.push(frame.asset);
      for(const asset of available)select.append(new Option(asset.source?.label||"Private image",asset.id));select.value=frame.asset?.id??"";
      // HV-039-13: choosing an image changes this row's thumbnail and nothing else. It used to rebuild
      // every row, destroying the list being used: focus fell to the page body, and where arrow keys
      // on a closed list change it (Windows), a keyboard user lost the list at the first arrow.
      const holder=node("div");select.onchange=()=>{frame.asset=available.find(asset=>asset.id===select.value)??null;changed();thumbnail(holder,frame,revision);};
      row.append(selectLabel,select,holder);thumbnail(holder,frame,revision);
      const remove=button("Remove anchor "+(index+1),()=>{if(index===0&&frames.length>1)return tell("Remove the later anchors before removing the first frame.",true);frames.splice(index,1);changed();render();
        // The pressed button went with its row: focus the anchor that took its place, or the one
        // before it, or Add frame anchor when none are left.
        const rows=[...list.children],next=rows[Math.min(index,rows.length-1)];(next?next.querySelector("select"):add).focus();});
      row.append(remove);list.append(row);
    }
  }
  return {read:()=>frames.length?{frameAnchors:{frames:structuredClone(frames).sort((a,b)=>a.at-b.at),fallback:fallback.checked?"storyboard":"stop"}}:{},
    fill(values,state){frames=structuredClone(values.frameAnchors?.frames??[]);catalog=structuredClone(state.anchorAssets??[]);fallback.checked=values.frameAnchors?.fallback==="storyboard";file.value="";label.value="";attested.checked=false;render();}};
}
