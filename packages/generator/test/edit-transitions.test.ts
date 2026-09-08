import {expect,test} from 'bun:test';
import {contentHash} from '../src/capabilities';
import {applyEditOperation,editTimeline,validateEditTimeline,editCaptionCues,type EditClip,type EditTimeline} from '../../planner/src/edit-timeline';
import {createEditHistory,appendEdit,moveEditCursor,editHistoryState} from '../../planner/src/edit-history';
import {EditTime} from '../../planner/src/edit-time';
import {editRenderClips,editRenderGainQ20} from '../../planner/src/edit-transition-render';
import {previewPicture,previewRequests,PreviewAudioRenderer} from '../../planner/src/edit-preview-render';
import {editConformRecipe} from '../src/edit-conform';
import {editPictureRecipe,pictureSpans,editPictureSpanClips} from '../src/edit-picture';

export function transitionFixture():EditTimeline{
  const clips:EditClip[]=[];for(const [group,at,from]of [['left',0,20],['right',40,80]] as const)for(const lane of ['picture','mix','captions'] as const)clips.push({id:group+'-'+lane,sourceId:'original',lane,layer:0,link:group,at,from,frames:40,gainDb:0,opacity:1,crop:null,envelope:{from,frames:40,fadeIn:0,fadeOut:0}});
  return editTimeline({schema:'hv-edit-timeline/1',width:64,height:48,frames:80,sources:[{id:'original',revision:contentHash('original'),label:'Retained original',frames:160,width:64,height:48,audio:['mix'],captions:[{id:'line',start:76*1600,end:86*1600,text:'Incoming line'}],voices:[{id:'line',start:76*1600,end:86*1600,lane:'dialogue'}],unmeasuredAudio:false}],clips,markers:[]});
}
export const crossfadeOperation={kind:'crossfade' as const,leftId:'left-picture',rightId:'right-picture',linked:true,frames:10,alignment:'center' as const,ids:{'left-picture':'dissolve','left-mix':'audio-fade'}};
export const crossfadedFixture=()=>applyEditOperation(transitionFixture(),crossfadeOperation);
test('crossfades edit linked tracks atomically and removal restores the exact original timeline and recipes',()=>{
  const original=transitionFixture(),before=contentHash(original),t=applyEditOperation(original,crossfadeOperation);
  expect(t.clips).toEqual(original.clips);expect(contentHash(original)).toBe(before);expect(t.transitions).toHaveLength(2);expect(validateEditTimeline(t)).toEqual(t);
  expect(editConformRecipe(original).schema).toBe('hv-edit-conform-recipe/2');expect(editPictureRecipe(original).schema).toBe('hv-edit-picture/2');expect(editConformRecipe(t).schema).toBe('hv-edit-conform-recipe/4');
  const edited=applyEditOperation(t,{...crossfadeOperation,frames:7,alignment:'end'});expect(edited.transitions!.every(x=>x.frames===7&&x.alignment==='end')).toBe(true);
  expect(applyEditOperation(edited,{kind:'remove-crossfade',leftId:'left-picture',rightId:'right-picture',linked:true})).toEqual(original);
  expect(()=>applyEditOperation(t,{...crossfadeOperation,ids:{'left-picture':'new','left-mix':'audio-fade'}})).toThrow('Retain');
  expect(()=>applyEditOperation(t,{...crossfadeOperation,ids:{'left-picture':'same','left-mix':'same'}})).toThrow('identity');expect(contentHash(original)).toBe(before);
});
test('saved crossfade boundaries survive roll, split and history branches; invalid edits retain the saved cut',()=>{
  const t=crossfadedFixture(),rolled=applyEditOperation(t,{kind:'roll',leftId:'left-picture',rightId:'right-picture',linked:true,delta:3});expect(editRenderClips(rolled).find(c=>c.id==='right-picture')!.at).toBe(38);
  const split=applyEditOperation(t,{kind:'split',clipId:'left-picture',linked:true,at:15,rightIds:{'left-picture':'tail-picture','left-mix':'tail-mix','left-captions':'tail-captions'},rightLink:'tail'});expect(split.transitions!.map(x=>x.leftId).sort()).toEqual(['tail-mix','tail-picture']);
  const deleted=applyEditOperation(t,{kind:'delete',clipId:'right-picture',linked:true,ripple:false});expect(deleted.transitions).toBeUndefined();
  expect(()=>applyEditOperation(t,{kind:'move',clipId:'right-picture',linked:true,at:39})).toThrow('adjacent');expect(()=>applyEditOperation(t,{kind:'slip',clipId:'right-picture',linked:true,delta:-80})).toThrow('handles');
  let history=createEditHistory('sequence',transitionFixture());history=appendEdit(history,crossfadeOperation,'Crossfade picture and sound',history.revision,1);const saved=history.revision;
  history=moveEditCursor(history,0,'undo','Restore hard cut',history.revision,2);expect(editHistoryState(history).timeline).toEqual(transitionFixture());history=appendEdit(history,{...crossfadeOperation,frames:8},'Shorter alternate',history.revision,3);history=moveEditCursor(history,1,'branch','Return to original dissolve',history.revision,4);expect(editHistoryState(history).timeline).toEqual(t);expect(history.revision).not.toBe(saved);
});
test('validation refuses forged transitions, absent handles, covered fades and ambiguous picture layers',()=>{
  const original=transitionFixture(),{revision:_revision,...data}=original;
  for(const transitions of [[],null,[{id:'x',kind:'unknown',leftId:'left-picture',rightId:'right-picture',frames:10,alignment:'center'}],[{id:'x',kind:'crossfade',leftId:'missing',rightId:'right-picture',frames:10,alignment:'center'}]])expect(()=>editTimeline({...data,transitions} as never)).toThrow();
  let faded=applyEditOperation(original,{kind:'settings',clipId:'left-picture',gainDb:0,opacity:.5,crop:null,fadeIn:3,fadeOut:8});expect(()=>applyEditOperation(faded,crossfadeOperation)).toThrow('adjoining fades');faded=applyEditOperation(faded,{...crossfadeOperation,frames:16});expect(editRenderClips(faded).find(c=>c.id==='left-picture')!.envelope).toMatchObject({fadeIn:3,fadeOut:0});
  const third={...original.clips[0]!,id:'third',link:null,at:36,frames:8};expect(()=>applyEditOperation(applyEditOperation(original,{kind:'insert',clips:[third]}),crossfadeOperation)).toThrow('third picture');expect(()=>applyEditOperation(applyEditOperation(original,{kind:'insert',clips:[{...third,layer:1}]}),crossfadeOperation)).not.toThrow();
});
test('derived handles preserve every original source clock and add linked caption coverage',()=>{
  const original=transitionFixture(),t=crossfadedFixture(),rendered=editRenderClips(t);
  expect(rendered.find(c=>c.id==='left-picture')).toMatchObject({at:0,from:20,frames:45});expect(rendered.find(c=>c.id==='right-picture')).toMatchObject({at:35,from:75,frames:45});
  for(const c of original.clips){const expanded=rendered.find(r=>r.id===c.id)!;for(let at=c.at*1600;at<(c.at+c.frames)*1600;at+=997){expect(new EditTime(expanded).source(at)).toBe(new EditTime(c).source(at));expect(new EditTime(expanded).phase(at)).toBe(new EditTime(c).phase(at));}}
  expect(editCaptionCues(original)[0]!.start).toBe(40*1600);expect(editCaptionCues(t)[0]!.start).toBe(36*1600);expect(t.clips).toEqual(original.clips);
  const ramp={...t.clips.find(c=>c.id==='right-picture')!,timing:{from:80,offset:0,points:[{frame:0,rate:500},{frame:40,rate:1500}]}};
  const {revision:_revision,...data}=original;data.clips=data.clips.map(c=>c.link==='right'?{...c,timing:structuredClone(ramp.timing)}:c);const retimed=applyEditOperation(editTimeline(data),crossfadeOperation),after=editRenderClips(retimed).find(c=>c.id===ramp.id)!;
  expect(after.from).toBe(77);for(let at=35*1600;at<80*1600;at+=991){expect(new EditTime(after).source(at)).toBe(new EditTime(ramp).source(at));expect(new EditTime(after).phase(at)).toBe(new EditTime(ramp).phase(at));}
});
test('picture preview and span planning retain both sources across the cut, including partial opacity',()=>{
  const original=transitionFixture(),t=crossfadedFixture();expect(previewPicture(t,34).map(p=>[p.clip.id,p.sourceFrame,p.alpha])).toEqual([['left-picture',54,255]]);expect(previewPicture(t,40).map(p=>[p.clip.id,p.sourceFrame,p.alpha])).toEqual([['left-picture',60,255],['right-picture',80,127]]);expect(previewPicture(t,45).map(p=>[p.clip.id,p.sourceFrame,p.alpha])).toEqual([['right-picture',85,255]]);
  expect(pictureSpans(t).map(s=>[s.at,s.frames])).toEqual([[0,35],[35,10],[45,35]]);expect(previewRequests(t,35,10).flatMap(r=>r.pictureFrames??[])).toContain(64);
  const partial=applyEditOperation(applyEditOperation(original,{kind:'settings',clipId:'left-picture',gainDb:0,opacity:.5,crop:null,fadeIn:0,fadeOut:0}),{kind:'settings',clipId:'right-picture',gainDb:0,opacity:.5,crop:null,fadeIn:0,fadeOut:0});expect(previewPicture(applyEditOperation(partial,crossfadeOperation),40).map(p=>p.alpha)).toEqual([85,63]);
});
test('sample-addressed linear audio stays at unity and untouched blocks keep exact PCM',()=>{
  const t=crossfadedFixture(),clips=editRenderClips(t).filter(c=>c.lane==='mix'),source=Buffer.alloc(60*1600*6);for(let i=0;i<60*1600*2;i++)source.writeIntLE(1234567,i*3,3);
  const renderer=new PreviewAudioRenderer(t.clips,4096,t.sources,t.transitions),left=new Float32Array(4096),right=new Float32Array(4096);
  for(const at of [0,34*1600,35*1600,40*1600,45*1600,70*1600]){expect(renderer.render(at,left,right,()=>source)).toBe(true);for(let i=0;i<left.length;i+=17){expect(Math.round(left[i]!*8388608)).toBe(1234567);expect(left[i]).toBe(right[i]);}}
  for(let at=35*1600;at<45*1600;at+=23)expect(clips.reduce((sum,c)=>sum+editRenderGainQ20(c,new EditTime(c).phase(at),1048576,at),0)).toBe(1048576);
  expect(renderer.render(40*1600,left,right,()=>undefined)).toBe(false);expect(left.every(x=>x===0)).toBe(true);
});
test('extended clip ordering and opacity extrema cannot hide a needed background',()=>{
  const original=transitionFixture(),{revision:_revision,...data}=original;
  data.clips=data.clips.map(c=>c.lane==='picture'?{...c,link:null,id:c.at===0?'z-outgoing':'a-incoming'}:c);
  const long=applyEditOperation(editTimeline(data),{...crossfadeOperation,leftId:'z-outgoing',rightId:'a-incoming',linked:false,frames:40,alignment:'end',ids:{'z-outgoing':'dissolve'}});expect(previewPicture(long,20).map(p=>[p.clip.id,p.alpha])).toEqual([['z-outgoing',255],['a-incoming',127]]);
  data.clips=data.clips.map(c=>c.lane==='picture'?{...c,layer:1,...(c.id==='a-incoming'?{envelope:{from:70,frames:50,fadeIn:12,fadeOut:0}}:{})}:c);data.clips.push({...original.clips[0]!,id:'background',link:null,at:0,from:0,frames:80,envelope:{from:0,frames:80,fadeIn:0,fadeOut:0}});
  const t=applyEditOperation(editTimeline(data),{...crossfadeOperation,leftId:'z-outgoing',rightId:'a-incoming',linked:false,ids:{'z-outgoing':'dissolve'}}),span=pictureSpans(t).find(s=>s.at===35)!;
  expect(previewPicture(t,35).map(p=>p.clip.id)).not.toContain('background');expect(previewPicture(t,44).map(p=>p.clip.id)).not.toContain('background');expect(previewPicture(t,38).map(p=>p.clip.id)).toContain('background');expect(editPictureSpanClips(span,t.sources).map(c=>c.id)).toEqual(['background','z-outgoing','a-incoming']);
});
test('two transitions cannot claim the same borrowed window and outside fades remain unchanged',()=>{
  const t=crossfadedFixture(),split=applyEditOperation(t,{kind:'split',clipId:'right-picture',linked:true,at:55,rightIds:{'right-picture':'last-picture','right-mix':'last-mix','right-captions':'last-captions'},rightLink:'last'});
  expect(()=>applyEditOperation(split,{...crossfadeOperation,leftId:'right-picture',rightId:'last-picture',frames:22,ids:{'right-picture':'second-picture','right-mix':'second-mix'}})).toThrow('overlap');
  const original=applyEditOperation(transitionFixture(),{kind:'settings',clipId:'left-mix',gainDb:-3,opacity:1,crop:null,fadeIn:6,fadeOut:5}),rendered=editRenderClips(applyEditOperation(original,crossfadeOperation)),before=original.clips.find(c=>c.id==='left-mix')!,after=rendered.find(c=>c.id===before.id)!;
  for(let at=0;at<35*1600;at+=197)expect(editRenderGainQ20(after,new EditTime(after).phase(at),741455,at)).toBe(editRenderGainQ20(before,new EditTime(before).phase(at),741455,at));
});
