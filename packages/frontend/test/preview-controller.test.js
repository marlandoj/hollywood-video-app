import {expect,test} from 'bun:test';
import {EditorialPreview} from '../src/preview-controller.js';

const settle=async(predicate)=>{for(let i=0;i<100;i++){if(predicate())return;await Bun.sleep(1);}throw new Error('Preview fixture did not settle.');};
function harness(){
  const names=['window','document','AudioContext','AudioWorkletNode','requestAnimationFrame','cancelAnimationFrame','createImageBitmap'],saved=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)])),contexts=[],nodes=[],bitmaps=[],events=[],requests=[],media=[],animations=new Map();let serial=0,owner='first',allowSetup=true;
  const drawing={canvas:{width:2,height:2},save(){},restore(){},fillRect(){},drawImage(){}},canvas=()=>({width:2,height:2,getContext:()=>drawing});
  const doc=new EventTarget();Object.assign(doc,{hidden:false,createElement:canvas,querySelectorAll:()=>[]});
  Object.assign(globalThis,{window:new EventTarget(),document:doc,requestAnimationFrame:callback=>{const id=++serial;animations.set(id,callback);return id;},cancelAnimationFrame:id=>animations.delete(id),createImageBitmap:async()=>{const bitmap={closed:0,close(){this.closed++;}};bitmaps.push(bitmap);return bitmap;},AudioContext:class{sampleRate=48000;currentTime=0;destination={};closed=0;audioWorklet={addModule:async()=>{if(!allowSetup)await new Promise(resolve=>{this.releaseSetup=resolve;});}};constructor(){contexts.push(this);}async resume(){}async close(){this.closed++;}getOutputTimestamp(){return {contextTime:this.currentTime};}},AudioWorkletNode:class{constructor(){nodes.push(this);this.commands=[];this.port={postMessage:command=>{this.commands.push(command);queueMicrotask(()=>this.port.onmessage?.({data:{kind:'accepted',epoch:command.epoch,requestId:command.requestId}}));},close(){}};}connect(){}disconnect(){}}});
  const timeline={frames:660,revision:'b'.repeat(64),sources:[],clips:[]},state={timeline,sequence:{id:'sequence',history:{revision:'a'.repeat(64)}}};
  const preview=new EditorialPreview({context:drawing,surface:canvas(),current:()=>true,onFrame:()=>{},onState:value=>events.push(value),client:()=>{const captured=owner;return {request:async(path,options)=>{requests.push({owner:captured,path,...options});if(options.method==='DELETE')return {};return {state:'ready',historyRevision:state.sequence.history.revision,timelineRevision:timeline.revision,from:options.body.from,frames:options.body.frames,audio:{sourceKey:'c'.repeat(64)},engineVersion:'ffmpeg-sound-'+'d'.repeat(64),sources:[]};},mediaRequest:async(_path,options)=>{media.push(options);return new Promise((_,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});}};}});
  preview.bind(state);
  return {preview,contexts,nodes,events,requests,media,bitmaps,state,animations,setup(value){allowSetup=value;},owner(value){owner=value;},async close(){preview.dispose();await Bun.sleep(5);for(const [name,descriptor]of saved)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}};
}

test('Stop during worklet setup prevents a late module from creating a source or starting a request',async()=>{
  const f=harness();try{f.setup(false);f.preview.play();await settle(()=>Boolean(f.contexts[0]?.releaseSetup));f.preview.stop();f.contexts[0].releaseSetup();await Bun.sleep(5);expect(f.nodes).toHaveLength(0);expect(f.requests).toHaveLength(0);expect(f.contexts[0].closed).toBe(1);expect(f.preview.stats).toMatchObject({active:false,audioContext:false,windows:0,composedFrames:0});}finally{await f.close();}
});

test('rapid seeks abort old media, stay within two windows and release leases with their captured owner after rebinding',async()=>{
  const f=harness();try{
    for(const [index,frame]of [0,300,600,0].entries()){f.preview.seek(frame,false);await settle(()=>f.media.length===index+1);expect(f.preview.stats.windows).toBeLessThanOrEqual(2);}
    expect(f.media.slice(0,-1).every(item=>item.signal.aborted)).toBe(true);expect(f.nodes[0].commands.filter(c=>c.kind==='reset').map(c=>c.at)).toEqual([0,480000,960000,0]);
    f.owner('second');f.preview.bind({...f.state,sequence:{id:'another',history:{revision:'e'.repeat(64)}}});await settle(()=>f.requests.filter(r=>r.method==='DELETE').length===4);
    expect(f.requests.filter(r=>r.method==='DELETE').every(r=>r.owner==='first')).toBe(true);expect(f.media.every(item=>item.signal.aborted)).toBe(true);expect(f.bitmaps.every(bitmap=>bitmap.closed===1)).toBe(true);expect(f.preview.stats).toMatchObject({active:false,audioContext:false,windows:0,packets:0,images:0,composedFrames:0});
  }finally{await f.close();}
});

test('another audio owner or a hidden page stops preparation and closes every owned resource',async()=>{
  for(const reason of ['audio','hidden']){const f=harness();try{
    f.preview.seek(0,false);await settle(()=>f.media.length===1);
    if(reason==='audio')window.dispatchEvent(new CustomEvent('hv-audio-focus',{detail:{owner:Symbol('retained-line')}}));else{document.hidden=true;document.dispatchEvent(new Event('visibilitychange'));}
    await settle(()=>f.requests.some(request=>request.method==='DELETE'));expect(f.media[0].signal.aborted).toBe(true);expect(f.contexts[0].closed).toBe(1);expect(f.preview.stats).toMatchObject({active:false,audioContext:false,windows:0,composedFrames:0});
  }finally{await f.close();}}
});
