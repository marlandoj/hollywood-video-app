import {expect,test} from 'bun:test';
import {composePreviewFrame} from '../src/preview-composition.js';

test('dense picture overlaps consume each decoded source before requesting the next and apply opacity once per padded layer',async()=>{
  const painted=[],draws=[],context={canvas:{width:480,height:270},globalAlpha:1,save(){},restore(){},fillRect(){},drawImage(){painted.push(this.globalAlpha);}},surface={width:480,height:270,getContext:()=>layer},layer={fillRect(){},drawImage(image,...rectangle){expect(image.closed).toBe(false);draws.push({id:image.id,alpha:this.globalAlpha,rectangle});}};
  const source={id:'original',width:640,height:360},clips=Array.from({length:256},(_,i)=>({id:String(i).padStart(3,'0'),sourceId:source.id,lane:'picture',layer:0,at:0,from:i,frames:1,opacity:.5,crop:{x:160,y:0,width:320,height:360},envelope:{from:i,frames:1,fadeIn:0,fadeOut:0}}));let previous;
  await composePreviewFrame({sources:[source],clips},0,context,surface,async(_id,from)=>{if(previous){expect(draws.at(-1).id).toBe(previous.id);previous.closed=true;}previous={id:from,width:480,height:270,closed:false};return previous;});
  expect(draws).toHaveLength(256);expect(painted).toHaveLength(256);expect(draws.every(d=>d.alpha===1)).toBe(true);expect(painted.every(alpha=>alpha===127/255)).toBe(true);expect(draws[0].rectangle).toEqual([120,0,240,270,120,0,240,270]);
});

test('a failed source restores composition state and cannot return a partially completed frame',async()=>{
  let restored=0;const context={canvas:{width:2,height:2},save(){},restore(){restored++;},fillRect(){}},surface={width:2,height:2,getContext:()=>({})},clip={sourceId:'source',lane:'picture',at:0,from:0,frames:1,opacity:1,envelope:{from:0,frames:1,fadeIn:0,fadeOut:0}};
  await expect(composePreviewFrame({clips:[clip]},0,context,surface,async()=>{throw new Error('permission withdrawn');})).rejects.toThrow('permission withdrawn');expect(restored).toBe(1);
});
