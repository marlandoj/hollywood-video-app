const integer=(raw,label,min,max)=>{if(typeof raw!=='string'||!/^\d+$/.test(raw.trim()))throw new Error(label+' must be a whole frame.');const value=Number(raw);if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(label+' must be between '+min+' and '+max+'.');return value;};
export const livingScriptSameClock=mapping=>Boolean(mapping&&mapping.before.frames===mapping.after.frames&&mapping.before.shotOrder.length===mapping.after.shotOrder.length&&mapping.before.shotOrder.every((id,i)=>id===mapping.after.shotOrder[i])&&mapping.before.assembly.mode===mapping.after.assembly.mode&&mapping.before.assembly.overlapFrames===mapping.after.assembly.overlapFrames&&mapping.shots.every(shot=>shot.before&&shot.after&&shot.before.startSample===shot.after.startSample&&shot.before.endSample===shot.after.endSample));

/** Suggestions retain complete source clocks only when measured source shot boundaries agree.
 * They remain explicit draft choices; the server executes and reviews every admitted operation. */
export function livingScriptRecutRows(detail,impact,{suggest=false}={}){
  const timeline=detail.parent,oldId=detail.sourceMap.before.sourceId,related=new Set(impact.relatedSourceIds),seen=new Set(),sameClock=livingScriptSameClock(detail.sourceMap),rows=[];
  for(const clip of timeline.clips){if(!related.has(clip.sourceId)||seen.has(clip.id))continue;const peers=clip.link?timeline.clips.filter(item=>item.link===clip.link):[clip],homogeneous=peers.every(item=>item.sourceId===clip.sourceId),group=homogeneous?peers:[clip];for(const item of group)seen.add(item.id);
    const masks=group.some(item=>item.composite?.masks?.length),selected=clip.sourceId===oldId,automatic=suggest&&selected&&homogeneous&&sameClock;
    rows.push({id:crypto.randomUUID(),clipId:clip.id,clipIds:group.map(item=>item.id),lane:group.length>1?'Linked '+group.map(item=>item.lane+(item.lane==='picture'?' '+item.layer:'')).join(', '):clip.lane+(clip.lane==='picture'?' '+clip.layer:''),sourceId:clip.sourceId,
      action:automatic?'replace':'unresolved',from:automatic?String(clip.from):'',frames:String(clip.frames),at:String(clip.at),originalAt:clip.at,linked:homogeneous&&Boolean(clip.link),unlink:false,requiresUnlink:!homogeneous&&Boolean(clip.link),timing:'preserve',ripple:false,maskAction:masks?'choose':'',hasMasks:masks,related:!selected,
      notes:[...(impact.clips.find(item=>item.clip.id===clip.id)?.reviewReasons??[]),...(!homogeneous?['This linked group includes another source. Explicitly unlink this clip before mapping it independently.']:[]),...(!sameClock?['Actual source timing changed. Enter and review the revised source in-frame for this retained range.']:[])]});
  }return rows;
}
export function livingScriptRecutOperations(rows,detail,{duration=''}={}){
  if(!Array.isArray(rows)||!rows.length||rows.length>999)throw new Error('Review every original-source clip before creating the revised cut.');const operations=[],ids=new Set(),generated=detail.generated.id;
  const frames=duration===''?null:integer(duration,'Revised cut length',1,108000);if(frames!==null&&frames>detail.parent.frames)operations.push({kind:'duration',frames});
  for(const row of rows){if(ids.has(row.clipId))throw new Error('Each retained clip must have one explicit mapping.');ids.add(row.clipId);const clip=detail.parent.clips.find(item=>item.id===row.clipId);if(!clip)throw new Error('A mapped clip is no longer in the frozen parent.');
    if(row.action==='unresolved')throw new Error('Choose replacement or removal for '+row.lane+'.');if(row.requiresUnlink&&!row.unlink)throw new Error('Confirm independent mapping for this mixed-source linked clip.');if(row.unlink)operations.push({kind:'unlink',clipId:row.clipId});
    if(row.action==='delete'){operations.push({kind:'delete',clipId:row.clipId,linked:row.unlink?false:Boolean(row.linked),ripple:Boolean(row.ripple)});continue;}
    if(row.action!=='replace'||!['preserve','normal'].includes(row.timing))throw new Error('Choose a supported clip mapping and speed treatment.');
    if(row.related)throw new Error('This clip contains later dialogue or sound work. Explicitly remove it, or preserve and map that work in the original editor before proposing a recut.');
    if(row.hasMasks&&!['remove','rebind'].includes(row.maskAction))throw new Error('Choose whether to remove or rebind the source masks for '+row.lane+'.');
    const operation={kind:'replace',clipId:row.clipId,linked:row.unlink?false:Boolean(row.linked),sourceId:generated,from:integer(row.from,'Revised source in-frame',0,detail.generated.frames-1),frames:integer(row.frames,'Output clip length',1,108000),timing:row.timing,ripple:Boolean(row.ripple)};
    if(row.hasMasks)operation.maskAction=row.maskAction;operations.push(operation);const at=integer(row.at,'Output start frame',0,107999);if(at!==row.originalAt)operations.push({kind:'move',clipId:row.clipId,linked:operation.linked,at});
  }
  if(!operations.some(operation=>operation.kind==='replace'))throw new Error('Retain at least one clip from the actual revised film.');if(frames!==null&&frames<detail.parent.frames)operations.push({kind:'duration',frames});if(operations.length>999)throw new Error('This recut exceeds 999 reviewed operations.');return operations;
}
