import {editFail,editId,editRecord,type EditClip,type EditTimeline,type EditOperation} from './edit-timeline';
import {editCrossfadeWindow,editCrossfadeSourceRange} from './edit-crossfade';
import {editPhaseFrame} from './edit-time';

type Pair={left:EditClip;right:EditClip};
/** Caption timing follows paired sound handles; captions do not receive a visual dissolve. */
export function editTransitionPairs(left:EditClip[],right:EditClip[]):Pair[]{
  if(left.some(l=>right.some(r=>r.id===l.id))||left.length!==right.length)editFail('Choose adjacent clips with matching linked tracks.');
  const pairs=left.map(l=>{const matching=right.filter(r=>r.lane===l.lane&&r.layer===l.layer&&r.at===l.at+l.frames);if(matching.length!==1)editFail('Choose adjacent clips with matching linked tracks.');return {left:l,right:matching[0]!};}).filter(p=>p.left.lane!=='captions');
  if(!pairs.length)editFail('Crossfade picture or sound; linked captions follow the sound handles.');return pairs;
}
export function validateEditTransitions(t:Omit<EditTimeline,'revision'>):void{
  if(!Object.hasOwn(t,'transitions'))return;
  if(!Array.isArray(t.transitions)||!t.transitions.length||t.transitions.length>256)editFail('Omit empty transitions, or use up to 256 saved crossfades.');
  const ids=new Set<string>(),pairs=new Set<string>(),windows:{at:number;end:number;left:EditClip;right:EditClip}[]=[];
  for(const x of t.transitions){
    editRecord(x,['id','kind','leftId','rightId','frames','alignment']);editId(x.id);editId(x.leftId);editId(x.rightId);
    const left=t.clips.find(c=>c.id===x.leftId),right=t.clips.find(c=>c.id===x.rightId),key=x.leftId+':'+x.rightId;
    if(x.kind!=='crossfade'||!left||!right||left.lane==='captions')editFail('A crossfade must retain its adjacent picture or sound clips. Remove it before replacing the boundary.');
    if(ids.has(x.id)||pairs.has(key))editFail('Use one unique crossfade per track boundary.');ids.add(x.id);pairs.add(key);
    const w=editCrossfadeWindow(left,right,x.frames,x.alignment,t.frames),end=w.at+w.frames;
    editCrossfadeSourceRange(left,t.sources.find(s=>s.id===left.sourceId)!.frames,left.at,left.frames+w.after);
    editCrossfadeSourceRange(right,t.sources.find(s=>s.id===right.sourceId)!.frames,w.at,right.at+right.frames-w.at);
    // Replacing an adjoining fade must not change samples outside the crossfade window.
    if(left.envelope.from+left.envelope.frames===editPhaseFrame(left,left.at+left.frames)&&left.envelope.fadeOut>w.before||right.envelope.from===editPhaseFrame(right)&&right.envelope.fadeIn>w.after)editFail('Lengthen or realign the crossfade to cover the adjoining fades, or shorten those fades first.');
    if(left.lane==='picture'&&t.clips.some(c=>c.id!==left.id&&c.id!==right.id&&c.lane==='picture'&&c.layer===left.layer&&c.at<end&&c.at+c.frames>w.at))editFail('A third picture overlaps this crossfade on the same layer. Move it to another layer or shorten the transition.');
    for(const old of windows)if(w.at<old.end&&end>old.at&&(left.id===old.left.id||left.id===old.right.id||right.id===old.left.id||right.id===old.right.id||left.lane==='picture'&&old.left.lane==='picture'&&left.layer===old.left.layer))editFail('Crossfade windows on the same picture layer or clip overlap. Shorten or realign them.');
    windows.push({at:w.at,end,left,right});
  }
}
export function setEditCrossfade(t:EditTimeline,op:Extract<EditOperation,{kind:'crossfade'}>,pairs:Pair[]):void{
  editRecord(op.ids,pairs.map(p=>p.left.id));if(Object.keys(op.ids).length!==pairs.length)editFail('Give each crossfaded track a transition identity.');
  t.transitions??=[];
  for(const {left,right}of pairs){const id=editId(op.ids[left.id]),old=t.transitions.find(x=>x.leftId===left.id&&x.rightId===right.id);
    if(old&&old.id!==id||t.transitions.some(x=>x.id===id&&x!==old))editFail('Retain the saved transition identity when changing its duration or alignment.');
    const next={id,kind:'crossfade' as const,leftId:left.id,rightId:right.id,frames:op.frames,alignment:op.alignment};if(old)Object.assign(old,next);else t.transitions.push(next);
  }
}
export function removeEditCrossfade(t:EditTimeline,pairs:Pair[]):void{
  const matches=new Set(pairs.map(p=>p.left.id+':'+p.right.id)),remaining=t.transitions?.filter(x=>!matches.has(x.leftId+':'+x.rightId));
  if(!t.transitions||remaining!.length===t.transitions.length)editFail('Choose a boundary with a saved crossfade.');
  if(remaining!.length)t.transitions=remaining;else delete t.transitions;
}
