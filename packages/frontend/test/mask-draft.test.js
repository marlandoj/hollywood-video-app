import {expect,test} from 'bun:test';
import {newMask,setMaskKey,deleteMaskKey,editPolygonTopology,reorderMask,maskGeometryAt,maskDraftRecord,inspectMaskDraft} from '../src/mask-draft.js';
import {validateEditComposite} from '../../planner/src/edit-composite';
const source={id:'source',revision:'a'.repeat(64),frames:90,width:320,height:180},saved={sequence:{id:'sequence',history:{revision:'b'.repeat(64)}},timeline:{sources:[source]}},clip={id:'foreground',sourceId:source.id};
test('polygon vertex insertion preserves the authored path at every key and interpolation between keys',()=>{
  let n=0;const original=newMask('polygon',source,0,()=>String(++n)),moved=structuredClone(original.keyframes[0].geometry);for(const p of moved.points){p.xQ16+=4000;p.yQ16+=8000;}
  const animated=setMaskKey(original,10,moved),before=structuredClone(animated),inserted=editPolygonTopology(animated,animated.keyframes[0].geometry.points[0].id,'insert','midpoint');
  expect(animated).toEqual(before);expect(inserted.keyframes.map(k=>k.geometry.points.map(p=>p.id))).toEqual([['1','midpoint','2','3','4'],['1','midpoint','2','3','4']]);
  const middle=maskGeometryAt(inserted,5).points;expect(middle[1]).toEqual({id:'midpoint',xQ16:34768,yQ16:20384});expect(middle.filter(p=>p.id!=='midpoint')).toEqual(maskGeometryAt(animated,5).points);
  expect(validateEditComposite({schema:'hv-edit-composite/1',masks:[inserted]},source,0)).toBe(10);expect(editPolygonTopology(inserted,'midpoint','remove')).toEqual(animated);
});
test('source-frame keys update atomically and retain hold behavior and source binding through edits',()=>{
  const mask=newMask('rectangle',source,10,()=> 'mask'),end={...mask.keyframes[0].geometry,xQ16:40000},animated=setMaskKey(mask,30,end,'hold'),updated=setMaskKey(animated,10,mask.keyframes[0].geometry,'hold');
  expect(updated.keyframes.map(k=>k.sourceFrame)).toEqual([10,30]);expect(maskGeometryAt(updated,20)).toEqual(mask.keyframes[0].geometry);expect(maskGeometryAt(updated,89)).toEqual(end);expect(updated.sourceRevision).toBe(source.revision);
  expect(deleteMaskKey(updated,30)).toEqual({...mask,keyframes:[{...mask.keyframes[0],interpolation:'hold'}]});expect(()=>deleteMaskKey(mask,10)).toThrow('at least one');
});
test('reordering starts a valid stack without silently changing later replacement masks',()=>{
  const a=newMask('rectangle',source,0,()=> 'a'),b={...newMask('ellipse',source,0,()=> 'b'),combine:'subtract'},masks=[a,b],moved=reorderMask(masks,'b',-1);
  expect(moved.map(m=>[m.id,m.combine])).toEqual([['b','replace'],['a','replace']]);expect(masks[1].combine).toBe('subtract');expect(validateEditComposite({schema:'hv-edit-composite/1',masks:moved},source,0)).toBe(8);
});
test('recovered mask drafts distinguish current revisions, stale histories, and replaced originals without mutation',()=>{
  const composite={schema:'hv-edit-composite/1',masks:[newMask('ellipse',source,20,()=> 'mask')]},record=maskDraftRecord(saved,clip,composite,20,'mask',null),original=structuredClone(record);
  expect(inspectMaskDraft(record,saved,clip)).toBe('current');expect(inspectMaskDraft(record,{...saved,sequence:{...saved.sequence,history:{revision:'c'.repeat(64)}}},clip)).toBe('stale');
  expect(inspectMaskDraft(record,{...saved,timeline:{sources:[{...source,revision:'d'.repeat(64)}]}},clip)).toBe('source-changed');expect(inspectMaskDraft(record,saved,{...clip,id:'other'})).toBe('invalid');expect(record).toEqual(original);composite.masks[0].label='Later mutation';expect(record.composite.masks[0].label).toBe('Ellipse mask');
});
