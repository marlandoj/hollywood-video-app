import {whileBusy} from './busy.js';
const names={title:'Title','lower-third':'Lower third',credits:'Credits',slate:'Slate',watermark:'Watermark',kinetic:'Kinetic text'};
const plain=plan=>{const {revision:_revision,...data}=plan;return structuredClone(data);};
export function initGraphicStudio({parent,request,projectId,assetUrl,canEdit,onUnavailable}){
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;},actions=()=>{const e=node('div');e.className='result-actions';return e;};
  const panel=node('section'),status=node('p'),recovery=node('fieldset'),navigation=node('fieldset'),editor=node('fieldset'),renders=node('fieldset'),preview=node('div');panel.className='motion-workbench graphic-studio';panel.hidden=true;for(const e of [recovery,navigation,editor,renders])e.className='graphic-section';status.className='status';status.setAttribute('role','status');panel.append(node('h2','Titles and graphics'),node('p','Save a graphic, render its animation, and inspect the retained frames.'),status,recovery,navigation,editor,renders,preview);parent.append(panel);
  let active=null,index=null,current=null,draft=null,dirty=false,busy=false,pending=null,watchTimer=null,viewEpoch=0,selectedRender=null,saveButton=null,renderButton=null,availabilityButton=null,stopPreview=()=>{};
  const tell=(text,error=false)=>{status.textContent=text;status.dataset.state=error?'error':'success';};
  function syncControls(){for(const group of [navigation,editor,renders])group.disabled=busy||Boolean(pending);recovery.disabled=busy;if(saveButton){saveButton.disabled=!dirty;saveButton.className=dirty?'':'secondary';}if(renderButton){renderButton.disabled=dirty;renderButton.className=dirty?'secondary':'';}if(availabilityButton)availabilityButton.className=!current?.available&&!dirty?'':'secondary';if(index)panel.dataset.ready='true';}
  function changed(){dirty=true;syncControls();}
  function cancelView(){viewEpoch++;clearTimeout(watchTimer);stopPreview();preview.replaceChildren();}
  function remember(value){pending=value;try{const key='hv-graphic-request:'+active;if(value)localStorage.setItem(key,JSON.stringify(value));else localStorage.removeItem(key);}catch{/* The same request remains recoverable while this editor stays open. */}drawRecovery();syncControls();}
  function clean(){if(dirty)throw new Error('Save or discard these fields before switching graphics.');if(pending)throw new Error('Resolve the pending request before making another change.');}
  async function run(action){if(busy)return;if(active!==projectId()){tell('The open project changed. Reopen titles and graphics.',true);return;}busy=true;syncControls();try{await whileBusy(panel,action);}catch(error){tell(error.message||'The request could not finish. Your draft is retained.',true);}finally{busy=false;syncControls();}}
  const button=(label,action,primary=false)=>{const e=node('button',label);e.type='button';e.className=primary?'':'secondary';e.onclick=()=>run(action);return e;};
  const field=(box,label,tag,value,type)=>{const wrap=node('label',label),e=node(tag);wrap.className='cast-field';if(type)e.type=type;e.value=value??'';wrap.append(e);box.append(wrap);e.oninput=changed;return e;};
  const select=(box,label,values,value)=>{const e=field(box,label,'select',value);for(const [id,name]of values){const option=node('option',name);option.value=id;e.append(option);}e.value=value;return e;};
  const number=e=>{const n=Number(e.value);if(e.value.trim()===''||!Number.isFinite(n))throw new Error('Enter a number in every timing and layout field.');return n;};
  function details(box,label){const e=node('details');e.append(node('summary',label));box.append(e);return e;}
  async function refresh(){index=await request('');if(current&&!dirty&&!pending){const latest=index.graphics.find(g=>g.spec.id===current.spec.id);if(latest&&(latest.spec.revision!==current.spec.revision||latest.available!==current.available))load(latest);}drawNavigation();drawRenders();}
  function drawNavigation(){navigation.replaceChildren();const pick=select(navigation,'Saved graphic',index.graphics.map(g=>[g.spec.id,g.spec.label+(g.available?'':' · hidden')]),current?.spec.id??index.graphics[0]?.spec.id??'');pick.oninput=null;
    const row=actions(),openButton=button('Open graphic',()=>{clean();const found=index.graphics.find(g=>g.spec.id===pick.value);if(!found)throw new Error('Choose a saved graphic.');load(found);});openButton.disabled=!index.graphics.length;
    row.append(openButton,button('Refresh',async()=>{clean();await refresh();tell('Saved graphics and render status refreshed.');}),button('Close graphics',()=>{clean();cancelView();panel.hidden=true;/* HV-039-16: closing returns focus to the control that opened the panel; hiding the panel with focus inside it left focus on the page body. */if(opener?.isConnected&&!opener.disabled)opener.focus();}));navigation.append(row);
    const box=details(navigation,'Create another graphic');box.open=!draft;const kind=select(box,'New graphic type',Object.entries(names),'title');kind.oninput=null;
    box.append(button('Create graphic',()=>{clean();cancelView();current=null;selectedRender=null;draft={id:crypto.randomUUID(),label:names[kind.value],plan:plain(index.defaults.find(p=>p.kind===kind.value))};dirty=true;drawEditor();drawNavigation();drawRenders();tell('New graphic. Edit its text and save to prepare a render.');},!draft));
  }
  function load(saved){cancelView();if(current?.spec.id!==saved.spec.id)selectedRender=null;current=saved;draft={id:saved.spec.id,label:saved.spec.label,plan:plain(saved.spec.plan)};dirty=false;drawEditor();drawNavigation();drawRenders();tell(saved.available?'Saved graphic loaded. Review it and render the animation.':'This graphic is hidden. Restore it to render or view retained frames.');}
  function drawEditor(){editor.replaceChildren();saveButton=renderButton=availabilityButton=null;if(!draft){syncControls();return;}const p=draft.plan;editor.append(node('h3',names[p.kind]));const label=field(editor,'Graphic name','input',draft.label,'text'),text=field(editor,p.kind==='credits'?'Credit heading':'Main text','textarea',p.text),secondary=field(editor,'Secondary text','textarea',p.secondary),timing=details(editor,'Timing and animation');
    const frames=field(timing,'Duration in frames (30 frames per second)','input',p.frames,'number'),enter=field(timing,'Entrance frames','input',p.enterFrames,'number'),exit=field(timing,'Exit frames','input',p.exitFrames,'number');frames.min='2';frames.max='18000';enter.min=exit.min='0';
    const layout=details(editor,'Layout and color'),width=field(layout,'Width in pixels','input',p.width,'number'),height=field(layout,'Height in pixels','input',p.height,'number'),fontSize=field(layout,'Text size in pixels','input',p.fontSize,'number'),margin=field(layout,'Safe margin in pixels','input',p.margin,'number'),align=select(layout,'Alignment',[['left','Left'],['center','Center'],['right','Right']],p.align),color=field(layout,'Text color','input',p.color,'color'),accent=field(layout,'Accent color','input',p.accent,'color'),transparent=field(layout,'Transparent background','input','','checkbox'),background=field(layout,'Background color','input',p.background??'#111318','color');transparent.checked=p.background===null;background.disabled=transparent.checked;transparent.oninput=()=>{changed();background.disabled=transparent.checked;};
    // HV-039-23: each credit row is a group named by its number, and its Remove button says which row. `run` locks the
    // editor while it works, so focus moves once it is done: after a removal to the row that took its place (or the one
    // before it, or Add credit), after an addition to the new row's Role.
    const credits=[];if(p.kind==='credits'){const box=details(editor,'Credit rows');box.open=true;const rows=node('div');box.append(rows);let addCredit=null;
      const number=()=>credits.forEach((c,i)=>{c.legend.textContent='Credit '+(i+1);c.remove.textContent='Remove credit '+(i+1);});
      const add=(credit={role:'',name:''})=>{if(credits.length>=200)throw new Error('Use up to 200 credit rows.');const row=node('fieldset'),legend=node('legend');row.append(legend);
        const role=field(row,'Role','input',credit.role,'text'),name=field(row,'Name','input',credit.name,'text'),remove=button('',()=>{}),record={role,name,row,legend,remove};let next=null;
        remove.onclick=()=>run(()=>{const at=credits.indexOf(record);credits.splice(at,1);row.remove();number();changed();next=(credits[at]??credits[at-1])?.role??addCredit;}).then(()=>next?.focus());
        row.append(remove);credits.push(record);rows.append(row);number();return record;};
      for(const credit of p.credits)add(credit);let added=null;addCredit=button('Add credit',()=>{});
      addCredit.onclick=()=>{added=null;return run(()=>{added=add();changed();}).then(()=>added?.role.focus());};box.append(addCredit);}
    const read=()=>({id:draft.id,label:label.value,plan:{...p,text:text.value,secondary:secondary.value,frames:number(frames),enterFrames:number(enter),exitFrames:number(exit),width:number(width),height:number(height),fontSize:number(fontSize),margin:number(margin),align:align.value,color:color.value,accent:accent.value,background:transparent.checked?null:background.value,credits:p.kind==='credits'?credits.map(c=>({role:c.role.value,name:c.name.value})):[]}});
    const row=actions();saveButton=button('Save graphic',async()=>{if(pending)throw new Error('Recover the pending request before saving new fields.');draft=read();remember({kind:'save',id:draft.id,body:{expectedVersion:index.library.version,change:{kind:'save',...draft}}});await recover();},dirty);row.append(saveButton,button('Discard unsaved fields',()=>{if(pending)throw new Error('Resolve the pending save before discarding fields.');dirty=false;if(current)load(current);else{draft=null;drawEditor();drawNavigation();}}));
    if(current){availabilityButton=button(current.available?'Hide graphic':'Restore graphic',async()=>{clean();remember({kind:'availability',id:current.spec.id,body:{expectedVersion:index.library.version,change:{kind:'availability',id:current.spec.id,available:!current.available}}});await recover();});row.append(availabilityButton);}editor.append(row);
    if(current?.available){const renderBox=details(editor,'Render the saved graphic');renderBox.open=!dirty;renderBox.append(node('p','Rendering uses the saved text and timing. It has no provider charge. Unsaved fields must be saved or discarded first.'));const approved=field(renderBox,'I reviewed this saved graphic','input','','checkbox');approved.oninput=null;renderButton=button('Render saved graphic',async()=>{clean();if(!approved.checked)throw new Error('Review the saved graphic and check its approval before rendering.');remember({kind:'render',id:current.spec.id,body:{idempotencyKey:crypto.randomUUID(),specRevision:current.spec.revision,generationApproved:true}});await recover();});renderBox.append(renderButton);}syncControls();
  }
  function drawRecovery(){
    recovery.replaceChildren();if(!pending)return;
    recovery.append(node('p',pending.rejected?'The server rejected this request. Return to your draft to correct it or review the latest saved version.':'A request is saved on this device. Your fields are protected until its outcome is recovered.'),button('Recover request',recover,!pending.rejected));
    if(pending.rejected)recovery.append(button('Return to draft',async()=>{
      await refresh();current=index.graphics.find(g=>g.spec.id===pending.id)??null;const wasSave=pending.kind==='save';remember(null);
      if(wasSave){drawEditor();if(current){const box=details(editor,'Current saved graphic — compare before saving');box.open=true;const p=current.spec.plan;box.append(node('p',current.spec.label+' · '+(current.available?'available':'hidden')),node('p',p.text),node('p',p.secondary),node('p',p.frames+' frames; entrance '+p.enterFrames+'; exit '+p.exitFrames),node('p',p.width+' × '+p.height+'; text size '+p.fontSize+'; safe margin '+p.margin+'; '+p.align+' alignment'),node('p','Text '+p.color+'; accent '+p.accent+'; background '+(p.background??'transparent')));for(const c of p.credits)box.append(node('p',c.role+' — '+c.name));}}
      else if(current)load(current);else{draft=null;dirty=false;drawEditor();}
      tell('Saved state refreshed; draft fields retained. Review the current saved version before saving over it, or discard to load it.');drawNavigation();drawRenders();
    },true));
  }
  async function recover(){try{await submitPending();}catch(error){if(pending&&error.status>=400&&error.status<500&&![408,429].includes(error.status))remember({...pending,rejected:true});throw error;}}
  async function submitPending(){if(!pending)return;const saved=pending;if(saved.kind==='render'){const result=await request('/'+encodeURIComponent(saved.id)+'/renders',{method:'POST',body:saved.body});remember(null);selectedRender=result.jobId;await refresh();tell('Render request recovered. Follow its progress below, then inspect the completed frames.');return;}
    const result=await request('',{method:'PUT',body:saved.body});remember(null);dirty=false;index={...index,library:result.library,graphics:result.graphics};const actual=result.graphics.find(g=>g.spec.id===saved.id);if(actual)load(actual);await refresh();tell(actual?.available?'Graphic saved. Review it and render the animation.':'Graphic hidden. Its frames are unavailable until you restore it.');
  }
  function watch(){
    clearTimeout(watchTimer);const jobs=index.jobs.filter(j=>current&&j.spec.id===current.spec.id&&['queued','running'].includes(j.status));
    if(!jobs.length||panel.hidden)return;const epoch=viewEpoch;
    watchTimer=setTimeout(async()=>{if(panel.hidden||active!==projectId()||epoch!==viewEpoch)return;if(busy){watch();return;}
      try{const updates=await Promise.all(jobs.map(j=>request('/jobs/'+encodeURIComponent(j.id))));if(panel.hidden||active!==projectId()||epoch!==viewEpoch)return;for(const job of updates){const i=index.jobs.findIndex(j=>j.id===job.id);if(i>=0)index.jobs[i]=job;}drawRenders();}
      catch(error){if(epoch===viewEpoch&&!panel.hidden)tell(error.message+' Use Refresh to retry the status check.',true);}
    },1500);
  }
  /**
   * HV-039-07: the "Rendered versions" box is built once for a set of renders and updated in place
   * after that. It used to be rebuilt on every 1.5-second status poll while a render ran. That
   * destroyed the Version list and the Inspect button under the keyboard, so focus fell to the page
   * body. It also closed an open Version list mid-choice, and re-inserted a live region that a screen
   * reader announced every time, whether or not anything had changed.
   */
  let rendersView=null;
  const renderLabel=j=>(j.spec.label||'Graphic')+' · '+j.status+' · '+(j.completedAt?new Date(j.completedAt).toLocaleString():j.id.slice(0,8));
  function drawRenders(){
    const relevant=index.jobs.filter(j=>current&&j.spec.id===current.spec.id);if(!relevant.length){renders.replaceChildren();rendersView=null;clearTimeout(watchTimer);return;}
    if(!relevant.some(j=>j.id===selectedRender))selectedRender=relevant.at(-1).id;
    const key=relevant.map(j=>j.id).join(' ');
    if(rendersView?.key===key&&rendersView.box.parentElement===renders){
      // Same renders, newer status: only words that changed are written, so nothing is announced twice.
      rendersView.relevant=relevant;
      for(const option of rendersView.pick.children){const j=relevant.find(j=>j.id===option.value),text=renderLabel(j);if(option.textContent!==text)option.textContent=text;}
      rendersView.describe();watch();return;
    }
    renders.replaceChildren();
    const box=details(renders,'Rendered versions');box.open=true;
    const pick=select(box,'Version',relevant.map(j=>[j.id,renderLabel(j)]),selectedRender);pick.oninput=null;
    const state=node('p');state.setAttribute('role','status');box.append(state);
    const inspect=button('Inspect retained frames',async()=>{const job=await request('/jobs/'+encodeURIComponent(pick.value));if(!job.output)throw new Error(job.unavailable||'This graphic has no completed render yet.');show(job);});
    const view={key,box,pick,relevant,describe(){const j=view.relevant.find(j=>j.id===pick.value);selectedRender=j.id;const text=j.unavailable||j.failureReason||(j.status==='running'?(j.progress?.phase||'Starting')+' · '+(j.progress?.capturedFrames||0)+' / '+j.totalFrames+' captured frames; '+j.retainedFrames+' retained':j.status==='done'?'Ready. Inspect the animation or download the retained master.':j.status);if(state.textContent!==text)state.textContent=text;}};
    rendersView=view;pick.onchange=()=>view.describe();view.describe();box.append(inspect);watch();
  }
  function show(job){
    stopPreview();preview.replaceChildren();let serial=0,timer=null,deadline=null,playing=false;
    const info=node('p'),image=node('img'),play=node('button','Play frames');play.type='button';play.className='secondary';image.alt='Rendered '+job.spec.label;
    preview.append(node('h3',job.spec.label+' · retained render'));
    const slider=field(preview,'Frame','input',0,'range');slider.min='0';slider.max=String(job.output.frames-1);slider.step='1';
    const position=field(preview,'Go to frame (starting at 1)','input',1,'number');position.min='1';position.max=String(job.output.frames);
    function stop(){serial++;clearTimeout(timer);clearTimeout(deadline);playing=false;play.textContent='Play frames';}
    stopPreview=()=>{stop();image.onload=image.onerror=null;image.removeAttribute('src');};
    function showFrame(frame){
      const token=++serial;clearTimeout(deadline);slider.value=String(frame);position.value=String(frame+1);info.textContent='Loading frame '+(frame+1)+' of '+job.output.frames;
      const failed=()=>{if(token!==serial)return;stop();image.hidden=true;info.textContent='Frame unavailable. Refresh this version to check its current access.';};
      image.onload=()=>{if(token!==serial||panel.hidden||active!==projectId())return;clearTimeout(deadline);image.hidden=false;info.textContent='Frame '+(frame+1)+' of '+job.output.frames;if(playing&&frame+1<job.output.frames)timer=setTimeout(()=>showFrame(frame+1),1000/30);else if(playing){stop();info.textContent+=' · Playback finished';}};
      image.onerror=failed;deadline=setTimeout(failed,15000);image.src=assetUrl(job.output.framesUrl+String(frame).padStart(6,'0')+'.png');
    }
    slider.oninput=()=>{stop();showFrame(Number(slider.value));};
    position.oninput=()=>{stop();const frame=Number(position.value);if(Number.isInteger(frame)&&frame>=1&&frame<=job.output.frames)showFrame(frame-1);};
    play.onclick=()=>{if(playing){stop();info.textContent='Paused at frame '+position.value+' of '+job.output.frames;return;}playing=true;play.textContent='Pause frames';showFrame(Number(slider.value)>=job.output.frames-1?0:Number(slider.value));};
    preview.append(play,node('p','Frame playback waits for each retained image and may run slower than the 30 fps master.'),info,image);
    const row=actions();for(const [label,path]of [['Download alpha master',job.output.masterUrl],['Download render receipt',job.output.manifestUrl]]){const a=node('a',label);a.href=assetUrl(path);a.className='button-link';row.append(a);}preview.append(row);showFrame(0);
  }
  let opener=null;
  async function open(){
    if(!panel.contains(document.activeElement))opener=document.activeElement;
    if(busy)return;if(!canEdit()){const message='Create or reopen a project, and save or discard other open edits before opening graphics.';if(onUnavailable)onUnavailable(message);else tell(message,true);return;}
    if(active===projectId()&&(dirty||pending)){panel.hidden=false;tell(pending?'Recover the pending request to continue.':'Your unsaved graphic fields are still open.');return;}
    cancelView();if(active!==projectId()){current=null;draft=null;dirty=false;selectedRender=null;editor.replaceChildren();}active=projectId();panel.hidden=false;
    await run(async()=>{
      try{pending=JSON.parse(localStorage.getItem('hv-graphic-request:'+active)||'null');if(pending&&(!['save','availability','render'].includes(pending.kind)||typeof pending.id!=='string'||!pending.body))pending=null;}catch{pending=null;}
      await refresh();
      if(pending?.kind==='save'){const change=pending.body.change;if(change?.kind==='save'&&change.id===pending.id&&names[change.plan?.kind]){draft={id:change.id,label:change.label,plan:structuredClone(change.plan)};dirty=true;current=index.graphics.find(g=>g.spec.id===pending.id)??null;drawEditor();drawNavigation();}}
      drawRecovery();if(!pending&&!current&&index.graphics.length)load(index.graphics[0]);else tell(pending?'Recover the pending request to continue. Your saved request and fields are retained on this device.':current?'Saved graphic loaded. Review it and render the animation.':'Choose a saved graphic or create a new one.');
    });
  }
  window.addEventListener('pagehide',cancelView);window.addEventListener('hashchange',cancelView);
  return {open,get unsaved(){return dirty||busy||Boolean(pending);}};
}
