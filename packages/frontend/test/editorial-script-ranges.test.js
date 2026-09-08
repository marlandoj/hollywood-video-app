import {expect,test} from 'bun:test';
import {editorialScriptRanges} from '../src/editorial.js';

test('script outlines merge overlapping display intervals while retaining independent picture and sound lanes',()=>{
  const timeline={frames:100,clips:[{id:'p',sourceId:'s',lane:'picture',layer:0},{id:'q',sourceId:'s',lane:'picture',layer:0},{id:'a',sourceId:'s',lane:'dialogue',layer:0}]};
  const range=(clipId,lane,startFrame,endFrame)=>({clipId,sourceId:'s',lane,layer:0,startFrame,endFrame});
  const occurrences=[range('p','picture',20,30),range('q','picture',25,40),range('p','picture',20,30),range('a','dialogue',8,18),range('q','picture',40,41),range('q','picture',50,55)];
  const original=structuredClone(occurrences);
  expect(editorialScriptRanges(timeline,occurrences)).toEqual([{lane:'picture 0',at:20,frames:21},{lane:'picture 0',at:50,frames:5},{lane:'dialogue',at:8,frames:10}]);
  expect(occurrences).toEqual(original);
});

test('stale or foreign script occurrences cannot outline an unrelated current timeline',()=>{
  const timeline={frames:100,clips:[{id:'p',sourceId:'s',lane:'picture',layer:1}]},valid={clipId:'p',sourceId:'s',lane:'picture',layer:1,startFrame:0,endFrame:10};
  expect(editorialScriptRanges(timeline,[{...valid,clipId:'gone'},{...valid,sourceId:'other'},{...valid,lane:'dialogue'},{...valid,layer:0},{...valid,startFrame:-1},{...valid,endFrame:101},{...valid,endFrame:0},{...valid,startFrame:.5},valid])).toEqual([{lane:'picture 1',at:0,frames:10}]);
});
