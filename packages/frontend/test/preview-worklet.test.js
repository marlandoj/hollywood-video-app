import {expect,test} from "bun:test";
import {PreviewPcmTransport} from "../src/preview-worklet.js";
const pcm=(from,frames=60)=>{const bytes=new Uint8Array(frames*1600*6);for(let i=0;i<frames*1600;i++){const n=(i+from*1600)%8388607,j=i*6;bytes[j]=n&255;bytes[j+1]=(n>>8)&255;bytes[j+2]=(n>>16)&255;bytes[j+3]=0;bytes[j+4]=0;bytes[j+5]=128;}return bytes;};
test("transport holds the source clock on missing picture or sound and never exposes half a crossing block",()=>{
  const messages=[],t=new PreviewPcmTransport(m=>messages.push(m)),left=new Float32Array(128),right=new Float32Array(128);
  t.message({kind:"reset",epoch:1,frames:127,at:95950});t.message({kind:"page",epoch:1,from:0,pcm:pcm(0)});t.message({kind:"play",epoch:1});t.render(left,right,0);expect(t.at).toBe(95950);expect(left.every(n=>n===0)).toBe(true);
  t.message({kind:"picture",epoch:1,through:127});t.render(left,right,128);expect(t.at).toBe(95950);expect([...left,...right].every(n=>n===0)).toBe(true);
  t.message({kind:"page",epoch:1,from:60,pcm:pcm(60)});t.render(left,right,256);expect(t.at).toBe(96078);for(let i=0;i<128;i++){expect(left[i]).toBe((95950+i)/8388608);expect(right[i]).toBe(-1);}expect(t.pages.size).toBe(1);
  t.message({kind:"pause",epoch:1});t.render(left,right,384);expect(t.at).toBe(96078);expect(left.every(n=>n===0)).toBe(true);expect(messages.map(m=>m.state)).toEqual(["buffering","playing","paused"]);
});
test("transport rejects stale generations, limits lookahead, clears on stop and preserves final partial audio",()=>{
  const messages=[],t=new PreviewPcmTransport(m=>messages.push(m)),left=new Float32Array(511),right=new Float32Array(511);
  t.message({kind:"reset",epoch:1,frames:600,at:0});for(const from of [0,60,120,180,240])t.message({kind:"page",epoch:1,from,pcm:pcm(from)});expect(t.pages.size).toBe(3);
  t.message({kind:"reset",epoch:2,frames:127,at:127*1600-11});t.message({kind:"page",epoch:1,from:0,pcm:pcm(0)});t.message({kind:"play",epoch:1});expect(t.pages.size).toBe(0);expect(t.playing).toBe(false);
  t.message({kind:"page",epoch:2,from:120,pcm:pcm(120,7)});t.message({kind:"picture",epoch:2,through:127});t.message({kind:"play",epoch:2});t.render(left,right,1000);expect(t.at).toBe(127*1600);expect(messages.at(-1)).toMatchObject({state:"ended",contextFrame:1011});expect(left.subarray(11).every(n=>n===0)).toBe(true);for(let i=0;i<11;i++)expect(left[i]).toBe((127*1600-11+i)/8388608);
  t.message({kind:"stop",epoch:2});expect(t.pages.size).toBe(0);expect(t.playing).toBe(false);
});
