import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {loadMaskSourceFrame} from '../src/mask-source.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAJUlEQVR4nGP8y8Dwn4ECwEKJ5lEDIICFgULAMmoAw2gYMFAeBgCNPwI6gsWxsAAAAABJRU5ErkJggg==','base64');
const source={id:'original',revision:'a'.repeat(64),width:16,height:16,frames:90},saved={sequence:{id:'saved-cut',history:{revision:'b'.repeat(64)}},timeline:{sources:[source],clips:[{sourceId:source.id,at:0,from:30,frames:30}]}},args=frame=>({saved,sourceId:source.id,sourceFrame:frame});
function headers(frame=0){return {'content-type':'image/png','content-length':String(png.length),'x-hv-preview-sha256':createHash('sha256').update(png).digest('hex'),'x-hv-source-id':source.id,'x-hv-source-revision':source.revision,'x-hv-source-frame':String(frame),'x-hv-source-width':'16','x-hv-source-height':'16','x-hv-source-sha256':'c'.repeat(64),'x-hv-history-revision':saved.sequence.history.revision};}
function decoder(factory){const original=Object.getOwnPropertyDescriptor(globalThis,'createImageBitmap');globalThis.createImageBitmap=factory;return ()=>{if(original)Object.defineProperty(globalThis,'createImageBitmap',original);else delete globalThis.createImageBitmap;};}
const bitmap=(width=16,height=16)=>({width,height,closed:0,close(){this.closed++;}});

test('mask source requests bind exact frame zero and can read retained source handles outside the trimmed range',async()=>{
  const decoded=[],requests=[],restore=decoder(async blob=>{expect(blob.type).toBe('image/png');expect(Buffer.from(await blob.arrayBuffer())).toEqual(png);const value=bitmap();decoded.push(value);return value;});
  try{for(const frame of [0,89]){const result=await loadMaskSourceFrame({mediaRequest:async(path,options)=>{requests.push({path,options});return new Response(new Uint8Array(png),{headers:headers(frame)});}},args(frame));expect(result).toMatchObject({width:16,height:16,sourceRevision:source.revision,sourceFrame:frame});result.dispose();expect(decoded.at(-1).closed).toBe(1);}expect(requests.map(r=>r.path)).toEqual([0,89].map(frame=>'/sequences/saved-cut/sources/original/frames/'+frame+'?historyRevision='+saved.sequence.history.revision));expect(requests[0].options).toMatchObject({credentials:'omit',redirect:'error',cache:'no-store'});
    for(const frame of [-1,90,1.5])await expect(loadMaskSourceFrame({mediaRequest:()=>{throw new Error('Must not fetch');}},args(frame))).rejects.toThrow('changed');
  }finally{restore();}
});

test('mask source rejects changed source headers, missing zero frame, invalid PNG hash and truncated or excessive bytes before decoding',async()=>{
  let calls=0;const restore=decoder(async()=>{calls++;return bitmap();});try{
    for(const [key,value]of [['x-hv-history-revision','d'.repeat(64)],['x-hv-source-id','another'],['x-hv-source-revision','d'.repeat(64)],['x-hv-source-frame',null],['x-hv-source-frame','1'],['x-hv-source-width','18'],['x-hv-source-height','18'],['x-hv-source-sha256','invalid'],['content-type','image/jpeg'],['content-length',String(64*1024**2+1)],['x-hv-preview-sha256','e'.repeat(64)]]){const h=headers();if(value===null)delete h[key];else h[key]=value;await expect(loadMaskSourceFrame({mediaRequest:async()=>new Response(new Uint8Array(png),{headers:h})},args(0))).rejects.toThrow('changed');}
    for(const data of [png.subarray(0,-1),Buffer.concat([png,Buffer.of(1)])])await expect(loadMaskSourceFrame({mediaRequest:async()=>new Response(new Uint8Array(data),{headers:headers()})},args(0))).rejects.toThrow('changed');
    const invalid=Buffer.from(png);invalid[0]=0;const h=headers();h['x-hv-preview-sha256']=createHash('sha256').update(invalid).digest('hex');await expect(loadMaskSourceFrame({mediaRequest:async()=>new Response(new Uint8Array(invalid),{headers:h})},args(0))).rejects.toThrow('changed');expect(calls).toBe(0);
  }finally{restore();}
});

test('chunked mask sources without Content-Length authenticate the complete PNG before decoding',async()=>{
  const h=headers(89);delete h['content-length'];let pulls=0,offset=0,decoded=0;
  const stream=new ReadableStream({pull(target){pulls++;const end=Math.min(offset+17,png.length);target.enqueue(new Uint8Array(png.subarray(offset,end)));offset=end;if(offset===png.length)target.close();}},{highWaterMark:0});
  const restore=decoder(async blob=>{decoded++;expect(Buffer.from(await blob.arrayBuffer())).toEqual(png);return bitmap();});
  try{const result=await loadMaskSourceFrame({mediaRequest:async()=>new Response(stream,{headers:h})},args(89));expect(pulls).toBe(Math.ceil(png.length/17));expect(decoded).toBe(1);expect(result.sourceFrame).toBe(89);result.dispose();}finally{restore();}
});

test('chunked mask sources reject changed hashes, truncated PNGs and undersized bodies before decoding',async()=>{
  let decoded=0;const restore=decoder(async()=>{decoded++;return bitmap();});
  try{for(const [data,hash]of [[png,'d'.repeat(64)],[png.subarray(0,-1),headers()['x-hv-preview-sha256']],[png.subarray(0,56),createHash('sha256').update(png.subarray(0,56)).digest('hex')]]){
    const h={...headers(),'x-hv-preview-sha256':hash};delete h['content-length'];let offset=0;
    const stream=new ReadableStream({pull(target){const end=Math.min(offset+19,data.length);target.enqueue(new Uint8Array(data.subarray(offset,end)));offset=end;if(offset===data.length)target.close();}},{highWaterMark:0});
    await expect(loadMaskSourceFrame({mediaRequest:async()=>new Response(stream,{headers:h})},args(0))).rejects.toThrow('changed');
  }expect(decoded).toBe(0);}finally{restore();}
});

test('chunked mask sources stop and cancel as soon as streamed bytes exceed 64 MiB',async()=>{
  const h=headers();delete h['content-length'];const chunk=new Uint8Array(1024**2);let pulls=0,cancelled=false,decoded=0;
  const stream=new ReadableStream({pull(target){pulls++;target.enqueue(chunk);},cancel(){cancelled=true;}},{highWaterMark:0});
  const restore=decoder(async()=>{decoded++;return bitmap();});
  try{await expect(loadMaskSourceFrame({mediaRequest:async()=>new Response(stream,{headers:h})},args(0))).rejects.toThrow('changed');expect(pulls).toBe(65);expect(cancelled).toBe(true);expect(decoded).toBe(0);}finally{restore();}
});

test('stale saved-history admission fails without decoding a different version',async()=>{
  let decoded=0;const restore=decoder(async()=>{decoded++;return bitmap();});try{await expect(loadMaskSourceFrame({mediaRequest:async(path)=>{expect(path).toContain('historyRevision='+saved.sequence.history.revision);return Response.json({error:'The saved history changed.'},{status:409});}},args(0))).rejects.toThrow('changed');expect(decoded).toBe(0);}finally{restore();}
});

test('preparing source responses must retain the requested history before polling again',async()=>{
  for(const historyRevision of [undefined,'d'.repeat(64)]){let requests=0;await expect(loadMaskSourceFrame({mediaRequest:async()=>{requests++;return Response.json({state:'preparing',historyRevision},{status:202});}},args(0))).rejects.toThrow('changed');expect(requests).toBe(1);}
});

test('mask source abort closes a late decoded bitmap and dimension mismatch closes an unusable bitmap',async()=>{
  let release,started=false;const controller=new AbortController(),late=bitmap(),restore=decoder(async()=>{started=true;await new Promise(resolve=>{release=resolve;});return late;});
  try{const pending=loadMaskSourceFrame({mediaRequest:async()=>new Response(new Uint8Array(png),{headers:headers()})},{...args(0),signal:controller.signal});for(let i=0;i<50&&!started;i++)await Bun.sleep(1);expect(started).toBe(true);controller.abort(new Error('Owner changed the source frame'));release();await expect(pending).rejects.toThrow('Owner changed');expect(late.closed).toBe(1);}finally{restore();}
  const wrong=bitmap(18,16),restoreWrong=decoder(async()=>wrong);try{await expect(loadMaskSourceFrame({mediaRequest:async()=>new Response(new Uint8Array(png),{headers:headers()})},args(0))).rejects.toThrow('changed');expect(wrong.closed).toBe(1);}finally{restoreWrong();}
});

test('mask source abort cancels a partial body and preparing wait without further polling',async()=>{
  const controller=new AbortController();let cancelled=false,pulls=0;const stream=new ReadableStream({pull(target){pulls++;target.enqueue(new Uint8Array(png.subarray(0,20)));controller.abort(new Error('Stop source read'));},cancel(){cancelled=true;}},{highWaterMark:0});await expect(loadMaskSourceFrame({mediaRequest:async()=>new Response(stream,{headers:headers()})},{...args(0),signal:controller.signal})).rejects.toThrow('Stop source read');expect(pulls).toBe(1);expect(cancelled).toBe(true);
  const preparing=new AbortController();let requests=0;const pending=loadMaskSourceFrame({mediaRequest:async()=>{requests++;return Response.json({state:'preparing',historyRevision:saved.sequence.history.revision},{status:202});}},{...args(0),signal:preparing.signal});preparing.abort(new Error('Stop preparation'));await expect(pending).rejects.toThrow('Stop preparation');expect(requests).toBe(1);
});
