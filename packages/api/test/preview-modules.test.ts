import {expect,test} from 'bun:test';
import {runInNewContext} from 'node:vm';
import {previewBrowserModule} from '../src/preview-modules';

test('fixed preview bundles resolve locally and worklet acknowledgements retain the individual request identity',async()=>{
  expect(await previewBrowserModule('/api/../../private')).toBeNull();
  const controller=await previewBrowserModule('/api/preview-controller.js'),worklet=await previewBrowserModule('/api/preview-worklet.js');
  expect(controller?.size).toBeGreaterThan(1000);expect(worklet?.size).toBeGreaterThan(1000);
  const source=await worklet!.text(),messages:unknown[]=[];let Processor:any;
  // AudioWorklet does not provide the window, document, TextEncoder or structuredClone globals.
  runInNewContext(source.replace(/export\s*\{[^}]*\};?\s*$/,''),{sampleRate:48000,currentFrame:0,AudioWorkletProcessor:class{port={postMessage:(message:unknown)=>messages.push(message),onmessage:null};},registerProcessor:(_name:string,value:unknown)=>{Processor=value;}});
  const processor=new Processor();for(const command of [{kind:'reset',epoch:1,requestId:7,frames:60,at:0},{kind:'play',epoch:1,requestId:8},{kind:'pause',epoch:1,requestId:9}])processor.port.onmessage({data:command});
  expect(messages).toEqual([{kind:'accepted',command:'reset',requestId:7,epoch:1,at:0},{kind:'accepted',command:'play',requestId:8,epoch:1,at:0},{kind:'accepted',command:'pause',requestId:9,epoch:1,at:0}]);
});
