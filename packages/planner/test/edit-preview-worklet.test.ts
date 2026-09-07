import {expect,test} from "bun:test";
import {runInNewContext} from "node:vm";
import {fileURLToPath} from "node:url";
import type {EditClip} from "../src/edit-timeline";
test("the browser audio bundle loads and mixes in an isolated worklet-like global without TextEncoder or structuredClone",async()=>{
  const built=await Bun.build({entrypoints:[fileURLToPath(new URL("../src/edit-preview-render.ts",import.meta.url))],target:"browser",format:"cjs"});expect(built.success).toBe(true);expect(built.outputs.length).toBe(1);
  const module={exports:{} as typeof import("../src/edit-preview-render")};runInNewContext(await built.outputs[0]!.text(),{module,exports:module.exports},{timeout:2000});
  const clip:EditClip={id:"voice",sourceId:"original",lane:"dialogue",layer:0,link:null,at:0,from:0,frames:1,gainDb:0,opacity:1,crop:null,envelope:{from:0,frames:1,fadeIn:0,fadeOut:0}},renderer=new module.exports.PreviewAudioRenderer([clip]),pcm=new Uint8Array(1600*6);pcm.set([0,0,128,255,255,127]);clip.envelope.fadeIn=1;clip.frames=0;
  const left=new Float32Array(128),right=new Float32Array(128);expect(renderer.render(0,left,right,()=>pcm)).toBe(true);expect(left[0]).toBe(-1);expect(right[0]).toBe(8388607/8388608);expect(left.subarray(1).every(n=>n===0)).toBe(true);
});
