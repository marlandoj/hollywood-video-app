import {expect,test} from 'bun:test';
import {EditorialPreview} from '../src/preview-controller.js';
import {PreviewPcmTransport} from '../src/preview-worklet.js';
import {encodePreviewPage,previewDigest} from '../../planner/src/edit-preview-protocol';

const settle=async(predicate)=>{for(let i=0;i<100;i++){if(predicate())return;await Bun.sleep(1);}throw new Error('Preview fixture did not settle.');};
function harness({comparison=false,loaded=false,deferB=false,deferListen=false,deferDeletes=false}={}){
  const names=['window','document','AudioContext','AudioWorkletNode','requestAnimationFrame','cancelAnimationFrame','createImageBitmap'],saved=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)])),contexts=[],nodes=[],bitmaps=[],events=[],requests=[],media=[],animations=new Map(),gates=[],acks=[],deletes=[],draws=[[],[]];let serial=0,owner='first',allowSetup=true;
  const drawing={canvas:{width:2,height:2},save(){},restore(){},fillRect(){},drawImage(bitmap){draws[0].push(bitmap);}},drawingB={...drawing,drawImage(bitmap){draws[1].push(bitmap);}},canvas=()=>({width:2,height:2,getContext:()=>drawing});
  const doc=new EventTarget();Object.assign(doc,{hidden:false,createElement:canvas,querySelectorAll:()=>[]});
  Object.assign(globalThis,{window:new EventTarget(),document:doc,requestAnimationFrame:callback=>{const id=++serial;animations.set(id,callback);return id;},cancelAnimationFrame:id=>animations.delete(id),createImageBitmap:async()=>{const bitmap={closed:0,close(){this.closed++;}};bitmaps.push(bitmap);return bitmap;},AudioContext:class{sampleRate=48000;currentTime=0;destination={};closed=0;audioWorklet={addModule:async()=>{if(!allowSetup)await new Promise(resolve=>{this.releaseSetup=resolve;});}};constructor(){contexts.push(this);}async resume(){}async close(){this.closed++;}getOutputTimestamp(){return {contextTime:this.currentTime};}},AudioWorkletNode:class{constructor(){nodes.push(this);this.commands=[];this.transport=new PreviewPcmTransport(message=>this.port.onmessage?.({data:message}));this.port={postMessage:command=>{this.commands.push(command);this.transport.message(command);const ack=()=>this.port.onmessage?.({data:{kind:'accepted',epoch:command.epoch,requestId:command.requestId}});if(command.kind==='listen'&&deferListen)acks.push(ack);else queueMicrotask(ack);},close(){}};}connect(){}disconnect(){}}});
  const timeline={frames:comparison?125:660,revision:'b'.repeat(64),sources:[],clips:[]},state={timeline,sequence:{id:'sequence',history:{revision:'a'.repeat(64)}},...(comparison?{jobId:'version-a',outputRevision:'1'.repeat(64)}:{})},alternate={timeline:{...timeline,frames:65,revision:'e'.repeat(64)},sequence:{id:'sequence',history:{revision:'f'.repeat(64)}},jobId:'version-b',outputRevision:'2'.repeat(64)},engineVersion='ffmpeg-sound-'+'d'.repeat(64);
  const preview=new EditorialPreview({context:drawing,surface:canvas(),...(comparison?{contexts:[drawing,drawingB],surfaces:[canvas(),canvas()]}:{}),current:()=>true,onFrame:()=>{},onState:value=>events.push(value),client:()=>{const captured=owner;return {request:async(path,options)=>{requests.push({owner:captured,path,...options});if(options.method==='DELETE'){if(deferDeletes)await new Promise(resolve=>deletes.push(resolve));return {};}const cut=path.includes('/version-b/')?alternate:state;return {state:'ready',historyRevision:cut.sequence.history.revision,outputRevision:cut.outputRevision,timelineRevision:cut.timeline.revision,from:options.body.from,frames:options.body.frames,audio:{sourceKey:'c'.repeat(64)},engineVersion,sources:[]};},mediaRequest:async(path,options)=>{media.push({path,...options});const other=path.includes('/version-b/');if(!loaded||other&&deferB)await new Promise((resolve,reject)=>{gates.push(resolve);options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});options.signal.throwIfAborted();const cut=other?alternate:state,from=Number(path.match(/audio\/(\d+)/)[1]),frames=Math.min(60,cut.timeline.frames-from),pcm=new Uint8Array(frames*1600*6);for(let i=2;i<pcm.length;i+=3)pcm[i]=other?32:16;const packet=await encodePreviewPage({sourceKey:'c'.repeat(64),sourceId:'timeline-audio',sourceRevision:cut.timeline.revision,engineVersion,sourceFrames:cut.timeline.frames,from,frames,width:2,height:2,includePicture:false,audioLanes:['mix']},[],[{lane:'mix',data:pcm}]);return new Response(packet,{headers:{'content-type':'application/vnd.hollywood-video.preview','x-hv-preview-sha256':await previewDigest(packet)}});}};}});
  preview.bind(comparison?[state,alternate]:state);
  return {preview,contexts,nodes,events,requests,media,bitmaps,state,alternate,animations,draws,release(){deferB=false;for(const resolve of gates.splice(0))resolve();},releaseDeletes(){deferDeletes=false;for(const done of deletes.splice(0))done();},releaseListen(){deferListen=false;for(const ack of acks.splice(0))ack();},render(count=128){const left=new Float32Array(count),right=new Float32Array(count),context=contexts.at(-1);nodes.at(-1).transport.render(left,right,Math.round(context.currentTime*48000));context.currentTime+=count/48000;return left;},tick(){for(const [id,callback]of Array.from(animations.entries())){animations.delete(id);callback();}},setup(value){allowSetup=value;},owner(value){owner=value;},async close(){preview.dispose();await Bun.sleep(5);for(const [name,descriptor]of saved)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}};
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

test('comparison uses one context and waits for both sides, then switches the audible stream without seeking',async()=>{
  const f=harness({comparison:true,loaded:true,deferB:true});try{
    f.preview.play();await settle(()=>f.nodes[0]?.commands.some(c=>c.kind==='page'&&c.stream===0)&&f.media.length===2);
    expect(f.contexts).toHaveLength(1);expect(f.preview.stats).toMatchObject({streams:2,windows:2,audioContext:true});expect(f.nodes[0].commands.find(c=>c.kind==='reset')).toMatchObject({streams:2,frames:125,at:0});
    expect(f.render().every(value=>value===0)).toBe(true);expect(f.nodes[0].transport.at).toBe(0);
    f.release();await settle(()=>f.nodes[0].transport.through>=9*1600);
    expect(f.render()[0]).toBe(.125);const at=f.nodes[0].transport.at;
    f.preview.listen(1);expect(f.render()[0]).toBe(.25);expect(f.nodes[0].transport.at).toBe(at+128);expect(f.nodes[0].commands.filter(c=>c.kind==='reset')).toHaveLength(1);
    f.preview.pause();expect(f.render().every(value=>value===0)).toBe(true);expect(f.nodes[0].transport.at).toBe(at+128);
    expect(f.requests.filter(r=>r.method==='POST').map(r=>r.body.outputRevision).sort()).toEqual(['1'.repeat(64),'2'.repeat(64)]);
  }finally{await f.close();}
});

test('unequal cuts hold the final picture and pad only the shorter soundtrack with silence at shared sample addresses',async()=>{
  const f=harness({comparison:true,loaded:true});try{
    f.preview.listen(1);f.preview.seek(64,true);await settle(()=>f.nodes[0]?.transport.through>=73*1600);
    const pages=f.nodes[0].commands.filter(c=>c.kind==='page'&&c.from===60),short=pages.find(c=>c.stream===1).pcm,long=pages.find(c=>c.stream===0).pcm;
    expect(short.length).toBe(60*1600*6);expect(short[5*1600*6-1]).toBe(32);expect(short.subarray(5*1600*6).every(value=>value===0)).toBe(true);expect(long.at(-1)).toBe(16);
    expect(f.render(1600).every(value=>value===.25)).toBe(true);f.tick();const held=f.draws[1].at(-1);expect(held).toBeDefined();expect(f.preview.position).toBe(65);
    expect(f.render(1600).every(value=>value===0)).toBe(true);f.tick();expect(f.preview.position).toBe(66);expect(f.draws[1].at(-1)).toBe(held);expect(f.draws[0].at(-1)).not.toBe(f.draws[0].at(-2));
    f.preview.seek(120,false);await settle(()=>f.nodes[0].commands.some(c=>c.kind==='page'&&c.stream===1&&c.from===120));const tail=f.nodes[0].commands.find(c=>c.kind==='page'&&c.stream===1&&c.from===120).pcm;expect(tail.length).toBe(5*1600*6);expect(tail.every(value=>value===0)).toBe(true);expect(f.media.some(item=>item.path.includes('/version-b/')&&item.path.includes('/audio/120?'))).toBe(false);
  }finally{await f.close();}
});

test('rebinding a comparison aborts both stale sides and releases version leases with captured revisions and owner',async()=>{
  const f=harness({comparison:true});try{
    f.preview.seek(0,false);await settle(()=>f.media.length===2);f.owner('second');f.preview.bind({...f.state,jobId:'version-c',outputRevision:'3'.repeat(64)});
    await settle(()=>f.requests.filter(r=>r.method==='DELETE').length===2);expect(f.media.every(item=>item.signal.aborted)).toBe(true);expect(f.requests.filter(r=>r.method==='DELETE').map(r=>[r.owner,new URL(r.path,'http://fixture').searchParams.get('outputRevision')]).sort()).toEqual([['first','1'.repeat(64)],['first','2'.repeat(64)]]);
    expect(f.bitmaps.every(bitmap=>bitmap.closed===1)).toBe(true);expect(f.preview.stats).toMatchObject({streams:1,active:false,windows:0,packets:0,images:0,composedFrames:0});expect(f.contexts[0].closed).toBe(1);
  }finally{await f.close();}
});

test('a soundtrack choice made during worklet initialization remains selected when playback becomes ready',async()=>{
  const f=harness({comparison:true,loaded:true,deferListen:true});try{
    f.preview.play();await settle(()=>f.nodes[0]?.commands.some(command=>command.kind==='listen'));f.preview.listen(1);f.releaseListen();await settle(()=>f.nodes[0].transport.through>=9*1600);
    expect(f.nodes[0].commands.filter(command=>command.kind==='listen').map(command=>command.stream)).toEqual([0,1]);expect(f.render()[0]).toBe(.25);
  }finally{await f.close();}
});

test('seeking in another preview waits for comparison leases to be released before admitting new media',async()=>{
  const f=harness({comparison:true,deferDeletes:true});let other;const admitted=[];try{
    f.preview.seek(0,false);await settle(()=>f.media.length===2);const surface=document.createElement('canvas');other=new EditorialPreview({context:surface.getContext('2d'),surface,current:()=>true,client:()=>({request:async(path,options)=>{if(options.method==='DELETE')return {};admitted.push(path);throw new Error('Admission fixture complete');}}),onFrame:()=>{},onState:()=>{}});other.bind(f.state);other.seek(0,false);
    await settle(()=>f.requests.filter(request=>request.method==='DELETE').length===2);await Bun.sleep(5);expect(admitted).toHaveLength(0);expect(f.preview.stats).toMatchObject({active:false,audioContext:false,windows:0,composedFrames:0});expect(f.media.every(item=>item.signal.aborted)).toBe(true);
    f.releaseDeletes();await settle(()=>admitted.length===1);other.dispose();expect(f.contexts.every(context=>context.closed===1)).toBe(true);
  }finally{f.releaseDeletes();other?.dispose();await f.close();}
});

test('a replacement view waits for leases from a disposed comparison before admitting new media',async()=>{
  const f=harness({comparison:true,deferDeletes:true});let other;const admitted=[];try{
    f.preview.seek(0,false);await settle(()=>f.media.length===2);f.preview.dispose();const surface=document.createElement('canvas');other=new EditorialPreview({context:surface.getContext('2d'),surface,current:()=>true,client:()=>({request:async(path,options)=>{if(options.method==='DELETE')return {};admitted.push(path);throw new Error('Admission fixture complete');}}),onFrame:()=>{},onState:()=>{}});other.bind(f.state);other.seek(0,false);
    await settle(()=>f.requests.filter(request=>request.method==='DELETE').length===2);await Bun.sleep(5);expect(admitted).toHaveLength(0);expect(f.preview.stats).toMatchObject({active:false,audioContext:false,windows:0,composedFrames:0});expect(f.media.every(item=>item.signal.aborted)).toBe(true);
    f.releaseDeletes();await settle(()=>admitted.length===1);other.dispose();expect(f.contexts.every(context=>context.closed===1)).toBe(true);
  }finally{f.releaseDeletes();other?.dispose();await f.close();}
});
