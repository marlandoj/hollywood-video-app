import {expect,test} from 'bun:test';
import {editCrossfadeAudio,editCrossfadePicture,editCrossfadeSourceRange,editCrossfadeWindow} from '../src/edit-crossfade';
import type {EditClip} from '../src/edit-timeline';
const clip=(id:string,at:number,from:number):EditClip=>({id,sourceId:'retained',lane:'picture',layer:0,link:null,at,from,frames:30,gainDb:0,opacity:1,crop:null,envelope:{from,frames:30,fadeIn:0,fadeOut:0}});
test('crossfade alignment derives odd-duration handles without changing clip timing',()=>{
  const left=clip('left',10,20),right=clip('right',40,30),before=JSON.stringify([left,right]);
  expect(editCrossfadeWindow(left,right,7,'center',90)).toEqual({at:37,frames:7,cut:40,before:3,after:4});
  expect(editCrossfadeWindow(left,right,7,'start',90)).toMatchObject({at:40,before:0,after:7});expect(editCrossfadeWindow(left,right,7,'end',90)).toMatchObject({at:33,before:7,after:0});
  expect(editCrossfadeSourceRange(left,100,10,34)).toEqual({first:32000,end:86400,last:86399,firstFrame:20,lastFrame:53});
  expect(editCrossfadeSourceRange(right,100,37,33)).toEqual({first:43200,end:96000,last:95999,firstFrame:27,lastFrame:59});expect(JSON.stringify([left,right])).toBe(before);
});
test('crossfades refuse missing handles and ambiguous or oversized boundaries',()=>{
  const left=clip('left',0,0),right=clip('right',30,0);
  expect(()=>editCrossfadeWindow(left,{...right,at:31},4,'center',60)).toThrow('adjacent');expect(()=>editCrossfadeWindow(left,{...right,layer:1},4,'center',60)).toThrow('same track');
  expect(()=>editCrossfadeWindow(left,right,61,'center',60)).toThrow();expect(()=>editCrossfadeWindow(left,right,31,'end',60)).toThrow('Shorten');
  expect(()=>editCrossfadeSourceRange(left,30,0,31)).toThrow('handles');expect(()=>editCrossfadeSourceRange(right,60,29,31)).toThrow('handles');
});
test('borrowed ramp and freeze handles use the original integrated source clock',()=>{
  const ramp={...clip('ramp',20,20),timing:{from:20,offset:0,points:[{frame:0,rate:1000},{frame:30,rate:3000}]}};
  const range=editCrossfadeSourceRange(ramp,100,18,36);expect(range.first).toBe(18*1600);expect(range.end).toBe(92*1600);expect(range.firstFrame).toBe(18);expect(range.lastFrame).toBe(89);
  const held={...clip('held',20,99),timing:{from:99,offset:0,points:[{frame:0,rate:0},{frame:30,rate:0}]}};expect(editCrossfadeSourceRange(held,100,10,60)).toEqual({first:99*1600,end:99*1600,last:99*1600,firstFrame:99,lastFrame:99});
  expect(()=>editCrossfadeSourceRange({...ramp,timing:{...ramp.timing,from:0}},100,18,36)).toThrow('handles');
});
test('dissolves retain brightness and partially transparent backgrounds within Q8 rounding',()=>{
  expect(editCrossfadePicture(1,1,0)).toEqual({outgoing:255,incoming:0});expect(editCrossfadePicture(1,1,.5)).toEqual({outgoing:255,incoming:127});expect(editCrossfadePicture(1,1,1)).toEqual({outgoing:0,incoming:255});
  for(const a of [0,.1,.5,.9,1])for(const b of [0,.1,.5,.9,1])for(let frame=0;frame<=30;frame++){const u=frame/30,weights=editCrossfadePicture(a,b,u),lower=weights.outgoing/255,upper=weights.incoming/255;expect(Math.abs(lower*(1-upper)-a*(1-u))).toBeLessThan(2/255);expect(Math.abs(upper-b*u)).toBeLessThan(1/255+1e-12);expect(Math.abs((1-lower)*(1-upper)-(1-a*(1-u)-b*u))).toBeLessThan(2/255);}
});
test('linear audio weights are complementary at sample boundaries and reject invalid addresses',()=>{
  for(const samples of [1600,4800,11200,96000])for(const at of [0,1,Math.floor(samples/2),samples-1,samples]){const weights=editCrossfadeAudio(at,samples);expect(weights.incoming+weights.outgoing).toBe(1048576);expect(weights.incoming).toBe(Math.round(at/samples*1048576));}
  expect(editCrossfadeAudio(0,1600)).toEqual({outgoing:1048576,incoming:0});expect(editCrossfadeAudio(1600,1600)).toEqual({outgoing:0,incoming:1048576});expect(()=>editCrossfadeAudio(-1,1600)).toThrow();expect(()=>editCrossfadeAudio(1601,1600)).toThrow();expect(()=>editCrossfadePicture(1,1,NaN)).toThrow();
});
