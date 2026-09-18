/** Creator review of generated sheets; image adoption is always an explicit cast edit. */
export function characterSheets({character,snapshot,scenes,request,prepareGeneration,mutate,dirty,alive,assetUrl}) {
  const node=(tag,text)=>{const value=document.createElement(tag);if(text!==undefined)value.textContent=text;return value;};
  const panel=node("details"),summary=node("summary","Generate character sheets"),form=node("div"),history=node("div"),status=node("p");
  panel.setAttribute("name","character-sheet-panels");status.setAttribute("role","status");status.className="status";
  const kind=node("select"),seed=node("input"),scene=node("select"),submit=node("button","Generate character sheet"),refresh=node("button","Refresh sheets");
  submit.type="button";refresh.type="button";submit.className=refresh.className="secondary";
  for(const [value,label]of [["turnaround","Turnaround — 4 views"],["expressions","Expressions — 6 views"],["wardrobe","Wardrobe — default and scene costumes"],["lighting","Lighting — 4 views"],["adult-ages","Adult age variants — 3 views"]])kind.append(new Option(label,value));
  seed.type="number";seed.min="0";seed.max="2147483647";seed.step="1";seed.value="7000";
  scene.append(new Option("Whole project","project"));for(const value of scenes)scene.append(new Option(value.number+". "+value.heading,String(value.number)));
  if(character.permission.scope==="scenes")scene.value=String(character.permission.sceneNumbers[0] ?? "project");
  for(const [control,label,key]of [[kind,"Sheet type","kind"],[seed,"Generation seed","seed"],[scene,"Sheet scene scope","scene"]]) {
    control.id="sheet-"+key+"-"+character.id;const caption=node("label",label);caption.htmlFor=control.id;const wrapper=node("div");wrapper.className="cast-field";wrapper.append(caption,control);form.append(wrapper);
  }
  const note=node("p","Views keep the chosen seed and current references. Review the results for identity and costume consistency before using a view as a reference. Sheets do not approve a film render.");note.className="environment";
  const actions=node("div");actions.className="result-actions";actions.append(submit,refresh);panel.append(summary,note,form,actions,status,history);
  let stopped=false,timer,loading=false,submitting=false,reloadPending=false;
  const reviews=new Map();
  const active=()=>!stopped&&alive();
  const message=(text,error=false)=>{status.textContent=text;status.dataset.state=error?"error":"success";};
  const base="/"+character.id+"/sheets";
  async function load() {
    clearTimeout(timer);if(!active() || !panel.open)return;if(loading){reloadPending=true;return;}
    loading=true;
    try {
      const result=await request(base);if(!active())return;
      history.replaceChildren();let pending=false;
      for(const [index,job]of result.jobs.entries()) {
        const reviewed=reviews.get(job.id)??{views:new Set(),replace:false};reviews.set(job.id,reviewed);
        const details=node("details"),label=node("summary",job.characterSheet.kind+" · cast "+job.castingVersion+" · seed "+job.characterSheet.seed+" · "+job.status);
        details.append(label);details.open=index===0&&job.status==="done";history.append(details);
        if(["queued","running"].includes(job.status)) {
          pending=true;details.append(node("p",job.checkpointShots+" of "+job.characterSheet.views.length+" views complete."));continue;
        }
        if(job.status!=="done") {details.append(node("p",job.failureReason||job.cancelReason||"Sheet generation did not finish. Review the cast and try again."));continue;}
        // HV-029-04: a finished sheet whose character permission has since
        // been withdrawn is served without its media. Saying so is the whole
        // point of the refusal; reading `job.output` first is a crash.
        if(!job.output) {details.append(node("p",job.mediaUnavailable||"This sheet is no longer available."));continue;}
        const downloads=node("div");downloads.className="result-actions";
        for(const [text,path]of [["Download sheet PNG",job.output.sheetUrl],["View sheet provenance",job.output.manifestUrl]])if(path) {
          const link=node("a",text);link.href=assetUrl(path);link.className="secondary";if(text==="Download sheet PNG")link.download="character-sheet.png";downloads.append(link);
        }
        details.append(downloads);
        const gallery=node("div");gallery.className="cast-reference-list";details.append(gallery);
        const selections=[];
        for(const frame of job.storyboard) {
          const figure=node("figure"),image=node("img"),caption=node("figcaption",frame.caption),review=node("label"),check=node("input");
          image.src=assetUrl(frame.url);image.alt=frame.caption;image.loading="lazy";check.type="checkbox";review.className="attestation";
          check.checked=reviewed.views.has(frame.shotId);check.onchange=()=>{if(check.checked)reviewed.views.add(frame.shotId);else reviewed.views.delete(frame.shotId);};
          review.append(check,node("span","Use "+frame.caption+": I reviewed this view and permit its use as a reference for my original fictional character."));
          selections.push({id:frame.shotId,check});figure.append(image,caption,review);gallery.append(figure);
        }
        const replacement=node("label"),replace=node("input"),adopt=node("button","Use selected views as references");replace.type="checkbox";replacement.className="attestation";
        replace.checked=reviewed.replace;replace.onchange=()=>{reviewed.replace=replace.checked;};
        replacement.append(replace,node("span","Replace the current reference set with these views. Previous references remain in cast history."));adopt.type="button";adopt.className="secondary";
        adopt.disabled=job.castingVersion!==snapshot.version || job.castingRevision!==snapshot.revision;
        adopt.onclick=async()=>{
          if(dirty())return message("Save or cancel the open character edit first.",true);
          const viewIds=selections.filter(value=>value.check.checked).map(value=>value.id);
          if(!viewIds.length || viewIds.length+(replace.checked?0:character.references?.length??0)>4)return message("Review and select up to four views. Replace existing references if the combined set would exceed four.",true);
          await mutate(()=>request(base+"/"+job.id+"/adopt",{method:"POST",body:{viewIds,replaceExisting:replace.checked,expectedVersion:snapshot.version,attested:true}}));
        };
        details.append(replacement,adopt);
        if(job.castingVersion!==snapshot.version)details.append(node("p","This sheet belongs to an earlier cast. Generate a new sheet before adopting a view."));
      }
      if(!result.jobs.length)history.append(node("p","No sheets generated for this character yet."));
      if(pending)timer=setTimeout(load,5000);
    } catch(error) {if(active())message(error.message||"Could not load character sheets. Use Refresh sheets to retry.",true);}
    finally {loading=false;if(reloadPending){reloadPending=false;void load();}}
  }
  submit.onclick=async()=>{
    if(submitting || !active())return;
    if(dirty())return message("Save or cancel the open character edit first.",true);
    const chosenSeed=Number(seed.value);if(seed.value==="" || !Number.isSafeInteger(chosenSeed) || chosenSeed<0 || chosenSeed>2147483647)return message("Choose a whole-number seed from 0 to 2147483647.",true);
    submitting=true;submit.disabled=true;message("Submitting character sheet…");
    try {
      await prepareGeneration();if(!active())return;
      await request(base,{method:"POST",body:{generationApproved:true,expectedVersion:snapshot.version,idempotencyKey:crypto.randomUUID(),settings:{kind:kind.value,seed:chosenSeed,sceneNumber:scene.value==="project"?null:Number(scene.value)}}});
      message("Sheet queued. Review its generated views when they are ready.");await load();
    } catch(error) {if(active())message(error.message||"Character sheet generation could not start.",true);}
    finally {submitting=false;if(active())submit.disabled=false;}
  };
  refresh.onclick=load;panel.addEventListener("toggle",()=>{if(panel.open)void load();else clearTimeout(timer);});
  return {panel,dispose(){stopped=true;clearTimeout(timer);}};
}
