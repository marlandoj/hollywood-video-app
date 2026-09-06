/** Explicit actor sharing. All shared text uses DOM properties; keys stay in fragments/headers. */
const node=(tag,text)=>{const value=document.createElement(tag);if(text!==undefined)value.textContent=text;return value;};
const button=(text,action)=>{const value=node("button",text);value.type="button";value.className="secondary";value.onclick=action;return value;};
const group=(title)=>{const value=node("details");value.append(node("summary",title));return value;};
const status=()=>{const value=node("p");value.className="status";value.setAttribute("role","status");return value;};
const tell=(element,text,error=false)=>{element.textContent=text;element.dataset.state=error?"error":"success";};
const field=(container,label,value="",tag="input")=>{const wrapper=node("div"),input=node(tag),caption=node("label",label);input.id="actor-field-"+crypto.randomUUID();caption.htmlFor=input.id;input.value=value;wrapper.className="cast-field";wrapper.append(caption,input);container.append(wrapper);return input;};
const attestation=(container,text)=>{const label=node("label"),input=node("input");label.className="attestation";input.type="checkbox";label.append(input,node("span",text));container.append(label);return input;};
const actorLink=token=>location.href.split("#")[0]+"#/actor/"+encodeURIComponent(token);
function shareToken(input) {
  const value=input.trim();let token=value;
  if(value.includes("://")) {const url=new URL(value);if(url.origin!==location.origin || !url.hash.startsWith("#/actor/"))throw new Error("Paste an actor share link from this studio.");token=decodeURIComponent(url.hash.slice(8));}
  if(token.length>2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))throw new Error("Paste a valid actor share link.");return token;
}
function actorPreview(character,image) {
  const panel=node("div"),urls=new Set();let stopped=false;
  panel.append(node("h3",character.name),node("p",character.appearance||"No appearance description saved."));
  for(const [title,fields]of [["Identity details",[["aliases","Other names"],["ageRange","Age range"],["ethnicity","Ethnicity"],["body","Body"],["hairMakeup","Hair and makeup"]]],
    ["Performance and continuity",[["expressions","Expressions"],["movement","Movement"],["relationships","Relationships"],["arcNotes","Character arc"],["prohibitedChanges","Traits to preserve"]]]]) {
    const detail=group(title);for(const [key,label]of fields){const value=Array.isArray(character[key])?character[key].join(", "):character[key];if(value)detail.append(node("p",label+": "+value));}panel.append(detail);
  }
  const costumes=group("Wardrobe and costume presets");
  for(const value of character.wardrobe)costumes.append(node("p",(value.sceneNumber===null?"Default":"Source scene "+value.sceneNumber+" — "+(character.sceneBindings.find(binding=>binding.sceneNumber===value.sceneNumber)?.heading??""))+": "+value.description));
  for(const preset of character.costumePresets??[])costumes.append(node("p",preset.name+": "+preset.description));panel.append(costumes);
  const pictures=group("Reference images · "+(character.references?.length??0)),gallery=node("div");gallery.className="cast-reference-list";pictures.append(gallery);panel.append(pictures);let loaded=false;
  pictures.addEventListener("toggle",async()=>{
    if(!pictures.open || loaded || stopped)return;loaded=true;
    for(const url of urls)URL.revokeObjectURL(url);urls.clear();gallery.replaceChildren();
    try {for(const [index,asset]of (character.references??[]).entries()) {const blob=await image(asset.id);if(stopped)return;const url=URL.createObjectURL(blob);urls.add(url);const figure=node("figure"),img=node("img");img.src=url;img.alt=character.name+" reference "+(index+1);figure.append(img,node("figcaption","Reference "+(index+1)));gallery.append(figure);}}
    catch(error){if(!stopped){gallery.append(node("p",error.message||"Could not load actor reference images."));loaded=false;}}
  });
  return {panel,dispose(){stopped=true;for(const url of urls)URL.revokeObjectURL(url);urls.clear();}};
}
export function actorSharePanel({character,snapshot,request,image,dirty,alive}) {
  const panel=group("Share actor across projects"),message=status(),history=node("div");let stopped=false,pending=false,preview;
  const active=()=>!stopped&&alive(),base="/"+character.id+"/shares";
  panel.append(node("p","A share link reveals this saved actor's directions and reference images. Anyone with the link can view and copy them for up to seven days. Revocation stops future access; copies already imported into other projects remain independent."));
  const approved=attestation(panel,"I may share this original fictional actor's directions and reference images for copying into other projects.");
  const create=button("Create actor share link",async()=>{
    if(pending||!active())return;if(dirty())return tell(message,"Save or cancel the open character edit first.",true);
    if(!approved.checked)return tell(message,"Confirm that you may share these actor directions and images.",true);
    pending=true;create.disabled=true;tell(message,"Creating actor share…");
    try{await request(base,{method:"POST",body:{expectedVersion:snapshot.version,attested:true}});if(active()){approved.checked=false;tell(message,"Actor share ready. Copy its link below.");await load();}}
    catch(error){if(active())tell(message,error.message||"Could not share this actor.",true);}finally{pending=false;if(active())create.disabled=!shareable;}
  });
  const shareable=character.permission.status==="permitted"&&character.permission.scope==="project"&&(!character.permission.expiresAt||Date.parse(character.permission.expiresAt)>Date.now());create.disabled=!shareable;
  if(!shareable)panel.append(node("p","Set current project-wide permission before creating an actor share."));panel.append(create,message,history);
  async function load(){
    try{const result=await request(base);if(!active())return;history.replaceChildren();
      for(const share of result.shares.slice().reverse()) {const entry=group("Shared "+new Date(share.createdAt).toLocaleString()+" · "+(share.revokedAt?"revoked":Date.parse(share.expiresAt)<=Date.now()?"expired":"expires "+new Date(share.expiresAt).toLocaleString()));entry.open=!share.revokedAt&&Boolean(share.token);history.append(entry);
        if(share.token){const link=field(entry,"Actor share link",actorLink(share.token),"textarea");link.readOnly=true;link.rows=3;
          const actions=node("div");actions.className="result-actions";actions.append(button("Copy actor share link",async()=>{try{await navigator.clipboard.writeText(link.value);tell(message,"Actor share link copied.");}catch{link.select();tell(message,"Select and copy the actor share link above.");}}),button("Revoke actor share",async()=>{
            if(dirty()||pending)return tell(message,"Finish the open edit or share action first.",true);pending=true;
            try{await request(base+"/"+share.id+"/revoke",{method:"POST",body:{}});if(active()){tell(message,"Share revoked. Previously imported copies remain in their projects.");await load();}}
            catch(error){if(active())tell(message,error.message||"Could not revoke this share.",true);}finally{pending=false;}
          }));entry.append(actions);
        }
      }
      if(!result.shares.length)history.append(node("p","No actor share links for this character."));
    }catch(error){if(active())tell(message,error.message||"Could not load actor shares.",true);}
  }
  panel.addEventListener("toggle",()=>{if(panel.open&&active()){if(!preview){preview=actorPreview(character,image);panel.insertBefore(preview.panel,approved.parentElement);}void load();}});
  return {panel,dispose(){stopped=true;preview?.dispose();}};
}
export function actorImportPanel({snapshot,request,sharedRequest,sharedImage,mutate,dirty,alive}) {
  const panel=group("Import a shared actor"),message=status(),content=node("div");let preview,stopped=false,pending=false;
  panel.append(node("p","Paste a share link to review one actor. Import copies its images into this project, preserves scene costumes as presets, and requires fresh generation permission."));
  const input=field(panel,"Actor share link to import","","textarea");input.maxLength=4096;input.rows=3;
  input.addEventListener("input",()=>{preview?.dispose();content.replaceChildren();tell(message,"Review this link before importing its actor.");});
  const inspect=button("Review shared actor",async()=>{
    if(pending||stopped||!alive())return;if(dirty())return tell(message,"Save or cancel the open character edit first.",true);
    pending=true;inspect.disabled=true;input.disabled=true;preview?.dispose();content.replaceChildren();tell(message,"Loading shared actor…");
    try{const token=shareToken(input.value),{share}=await sharedRequest(token);if(stopped||!alive())return;if(share.projectId===snapshot.projectId)throw new Error("Import this actor into a different project.");
      preview=actorPreview(share.character,id=>sharedImage(token,id));content.append(preview.panel,node("p","This shared revision expires "+new Date(share.expiresAt).toLocaleString()+"."));
      const name=field(content,"Imported character name",share.character.name),aliases=field(content,"Imported aliases (commas)",share.character.aliases.join(", "));name.maxLength=80;aliases.maxLength=650;
      const approved=attestation(content,"I reviewed this actor and want to copy its directions and images into this project. I will set generation permission separately.");
      content.append(button("Import actor into this project",async()=>{
        if(stopped||!alive())return;if(dirty())return tell(message,"Save or cancel the open character edit first.",true);if(!approved.checked)return tell(message,"Review the actor and confirm the import first.",true);
        await mutate(()=>request("/import",{method:"POST",body:{shareToken:token,expectedVersion:snapshot.version,attested:true,name:name.value,aliases:aliases.value.split(",").map(value=>value.trim()).filter(Boolean)}}));
      }));tell(message,"Shared actor loaded. Review its directions and reference images before importing.");
    }catch(error){if(!stopped&&alive())tell(message,error.message||"Could not load this actor share.",true);}finally{pending=false;if(!stopped){inspect.disabled=false;input.disabled=false;}}
  });panel.append(inspect,message,content);return {panel,dispose(){stopped=true;preview?.dispose();}};
}
export function costumePresetPanel({character,snapshot,scenes,scriptVersion,request,mutate,prepare,dirty}) {
  const panel=group("Shared costume presets · "+character.costumePresets.length),message=status(),select=field(panel,"Costume preset","","select"),description=node("p"),scene=field(panel,"Apply costume to","","select");
  for(const [index,preset]of character.costumePresets.entries())select.append(new Option(preset.name,String(index)));
  scene.append(new Option("Default wardrobe","default"));for(const value of scenes)scene.append(new Option(value.number+". "+value.heading,String(value.number)));
  const show=()=>{description.textContent=character.costumePresets[Number(select.value)]?.description??"";};select.onchange=show;show();
  const actions=node("div");actions.className="result-actions";
  const update=async action=>{if(dirty())return tell(message,"Save or cancel the open character edit first.",true);await mutate(async()=>{
    if(action==="apply")await prepare();return request("/"+character.id+"/costume-presets",{method:"POST",body:{action,index:Number(select.value),sceneNumber:scene.value==="default"?null:Number(scene.value),expectedVersion:snapshot.version,expectedScriptVersion:scriptVersion}});
  });};
  actions.append(button("Apply costume preset",()=>update("apply")),button("Remove costume preset",()=>update("remove")));
  panel.append(description,node("p","Source scene numbers are retained in the preset names. Choose where a costume applies in this screenplay. Removed presets remain in cast history."),actions,message);return panel;
}
export async function showSharedActor({container,token,sharedRequest,sharedImage,createProject,importActor,projectLink}) {
  container.replaceChildren(node("h1","Shared actor"));const message=status(),content=node("div");container.append(message,content);let preview,pending=false,project;
  window.addEventListener("pagehide",()=>preview?.dispose(),{once:true});tell(message,"Loading shared actor…");
  try{const {share}=await sharedRequest(token);preview=actorPreview(share.character,id=>sharedImage(token,id));content.append(preview.panel,node("p","This link shares one saved actor revision and expires "+new Date(share.expiresAt).toLocaleString()+". Use it in a new project below, or paste this link into an existing project's cast import control."));
    const approved=attestation(content,"I reviewed this actor and want to copy its directions and images into a new project. I will set generation permission separately.");
    const start=button("Start a project with this actor",async()=>{
      if(pending)return;if(!approved.checked)return tell(message,"Review the actor and confirm the import first.",true);pending=true;start.disabled=true;tell(message,"Copying actor into a new project…");
      try{if(!project){project=await createProject();const recovery=node("a","Open the new project");recovery.href=projectLink(project.token);content.append(recovery);}
        await importActor(project,token,share.character);location.assign(projectLink(project.token));
      }catch(error){tell(message,error.message||"Could not import the actor. You can open the new project to check its cast.",true);pending=false;start.disabled=false;}
    });content.append(start);tell(message,"Review this actor's directions and images. Imported actors require fresh generation permission.");
  }catch(error){tell(message,error.message||"This actor share is unavailable.",true);}
}
