const changed=()=>new Error('The saved screenplay navigation changed. Reload the saved cut and try again.');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const list=value=>Array.isArray(value);
const strings=value=>list(value)&&value.every(item=>typeof item==='string');
const address=value=>Number.isSafeInteger(value)&&value>=0;
const phase=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&Number.isSafeInteger(value*65536);
export const scriptEntryKey=(sourceId,entryId)=>JSON.stringify([sourceId,entryId]);
export function scriptSavedIdentity(saved){return saved?.sequence?.id&&saved?.sequence?.history?.revision&&saved?.timeline?.revision?JSON.stringify([saved.sequence.id,saved.sequence.history.revision,saved.timeline.revision]):null;}

/** Check the owner response's saved binding before its text or intervals reach the panel. */
export function validateScriptNavigation(value,saved){
  if(!value||value.schema!=='hv-edit-script-navigation/1'||value.sequenceId!==saved.sequence.id||value.historyRevision!==saved.sequence.history.revision||value.timelineRevision!==saved.timeline.revision||!hash(value.revision)||!strings(value.warnings)||!list(value.sources)||value.sources.length>16||!list(value.occurrences)||value.occurrences.length>100000)throw changed();
  if(new TextEncoder().encode(JSON.stringify(value)).length>8*1024**2)throw new Error('This screenplay navigation exceeds the supported size.');
  const sources=new Map(),entries=new Set(),clips=new Map(saved.timeline.clips.map(clip=>[clip.id,clip])),ids=new Set();
  for(const source of value.sources){const facts=saved.timeline.sources.find(item=>item.id===source.sourceId);if(!facts||sources.has(source.sourceId)||source.schema!=='hv-edit-script-source/1'||source.sourceRevision!==facts.revision||!hash(source.receiptRevision)||!hash(source.revision)||source.scriptRevision!==null&&!hash(source.scriptRevision)||source.scriptText!==null&&typeof source.scriptText!=='string'||typeof source.label!=='string'||typeof source.language!=='string'||!strings(source.warnings)||!list(source.entries)||source.entries.length>16384)throw changed();sources.set(source.sourceId,source);
    for(const entry of source.entries){const key=scriptEntryKey(source.sourceId,entry.id);if(typeof entry.id!=='string'||!entry.id||entries.has(key)||!['scene','action','dialogue','transition','narration'].includes(entry.kind)||typeof entry.text!=='string'||entry.character!==undefined&&typeof entry.character!=='string'||entry.performedText!==undefined&&typeof entry.performedText!=='string'||entry.unavailableReason!==undefined&&typeof entry.unavailableReason!=='string'||entry.sceneIndex!==null&&!address(entry.sceneIndex)||entry.startLine!==null&&(!address(entry.startLine)||entry.startLine===0)||entry.endLine!==null&&(!address(entry.endLine)||entry.endLine<entry.startLine)||!list(entry.windows))throw changed();entries.add(key);
      for(const window of entry.windows)if(!address(window.startSample)||!address(window.endSample)||window.startSample>=window.endSample||!list(window.lanes)||!['measured-speech','shot-coverage'].includes(window.evidence))throw changed();
    }
  }
  for(const item of value.occurrences){const clip=clips.get(item.clipId);if(typeof item.id!=='string'||ids.has(item.id)||!entries.has(scriptEntryKey(item.sourceId,item.entryId))||!clip||clip.sourceId!==item.sourceId||clip.lane!==item.lane||clip.layer!==item.layer||!address(item.startSample)||!address(item.endSample)||item.startSample>=item.endSample||item.endSample>saved.timeline.frames*1600||!address(item.startFrame)||!address(item.endFrame)||item.startFrame>=item.endFrame||item.endFrame>saved.timeline.frames||item.startFrame!==Math.floor(item.startSample/1600)||item.endFrame!==Math.ceil(item.endSample/1600)||!phase(item.sourceStartSample)||!phase(item.sourceEndSample)||item.sourceStartSample>item.sourceEndSample||item.sourceEndSample>saved.timeline.sources.find(source=>source.id===item.sourceId).frames*1600||!['measured-speech','shot-coverage'].includes(item.evidence)||typeof item.held!=='boolean'||typeof item.transition!=='boolean'||typeof item.muted!=='boolean')throw changed();ids.add(item.id);}
  return value;
}

/** Response state is separate from DOM so cancellation and stale identities remain testable. */
export function createScriptNavigationState({request,current,onChange}){
  let saved=null,identity=null,epoch=0,controller=null,disposed=false,state={status:'empty',data:null,error:null};
  const emit=()=>onChange(state),update=value=>{state={...state,...value};emit();};
  function cancel(){epoch++;controller?.abort();controller=null;if(state.status==='loading')update({status:state.data?'ready':'cancelled',error:null});}
  return {
    get state(){return state;},
    bind(value){const next=scriptSavedIdentity(value);if(next===identity)return false;cancel();saved=value;identity=next;update({status:next?'idle':'empty',data:null,error:null});return true;},
    async load(){if(disposed||!saved)return;const opened=scriptSavedIdentity(current());if(opened!==identity){update({status:'stale',data:null,error:changed().message});return;}cancel();const attempt=++epoch,bound=identity,snapshot=saved,active=new AbortController();controller=active;update({status:'loading',data:null,error:null});
      try{const data=await request('/sequences/'+encodeURIComponent(snapshot.sequence.id)+'/script?historyRevision='+encodeURIComponent(snapshot.sequence.history.revision),{signal:active.signal});if(disposed||attempt!==epoch||active.signal.aborted)return;if(bound!==scriptSavedIdentity(current()))throw changed();validateScriptNavigation(data,snapshot);controller=null;update({status:'ready',data,error:null});}
      catch(error){if(disposed||attempt!==epoch||active.signal.aborted)return;controller=null;update({status:'error',data:null,error:error?.message??'Screenplay navigation could not load. Try again.'});}
    },cancel,
    dispose(){disposed=true;epoch++;controller?.abort();controller=null;},
  };
}

function intervalTree(items,start=0,end=items.length){if(start>=end)return null;const middle=(start+end)>>>1,left=intervalTree(items,start,middle),right=intervalTree(items,middle+1,end),item=items[middle];return {item,left,right,maxEnd:Math.max(item.endFrame,left?.maxEnd??0,right?.maxEnd??0)};}
export function buildScriptNavigationIndex(data){
  const entries=new Map(),byEntry=new Map(),bySource=new Map(),trees=new Map();
  for(const source of data.sources)for(const entry of source.entries)entries.set(scriptEntryKey(source.sourceId,entry.id),{source,entry,search:[entry.text,entry.performedText??'',entry.character??''].join('\n').toLocaleLowerCase()});
  for(const occurrence of data.occurrences){const key=scriptEntryKey(occurrence.sourceId,occurrence.entryId);if(!byEntry.has(key))byEntry.set(key,[]);byEntry.get(key).push(occurrence);if(!bySource.has(occurrence.sourceId))bySource.set(occurrence.sourceId,[]);bySource.get(occurrence.sourceId).push(occurrence);}
  const order=(a,b)=>a.startFrame-b.startFrame||a.endFrame-b.endFrame||a.lane.localeCompare(b.lane)||a.layer-b.layer||a.id.localeCompare(b.id);for(const [key,items]of byEntry){const spoken=['dialogue','narration'].includes(entries.get(key)?.entry.kind);items.sort((a,b)=>(spoken?Number(a.evidence!=='measured-speech')-Number(b.evidence!=='measured-speech'):0)||order(a,b));}for(const [sourceId,items]of bySource){items.sort(order);trees.set(sourceId,intervalTree(items));}
  return {entries,byEntry,active(sourceId,frame,lane='all'){const result=[],pending=[trees.get(sourceId)];while(pending.length){const node=pending.pop();if(!node||node.maxEnd<=frame)continue;if(node.left?.maxEnd>frame)pending.push(node.left);if(node.item.startFrame<=frame){if(node.item.endFrame>frame&&(lane==='all'||node.item.lane===lane))result.push(node.item);if(node.right?.maxEnd>frame)pending.push(node.right);}}return result.sort(order);}};
}
