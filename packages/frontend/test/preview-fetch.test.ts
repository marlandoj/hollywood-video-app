import {expect,test} from 'bun:test';
import {fetchPreviewPacket} from '../src/preview-fetch.js';
import {encodePreviewPage,previewDigest,PREVIEW_MAX_BYTES,type PreviewPageIdentity} from '../../planner/src/edit-preview-protocol';
const expected:PreviewPageIdentity={sourceKey:'a'.repeat(64),sourceId:'timeline-audio',sourceRevision:'b'.repeat(64),engineVersion:'ffmpeg-sound-'+'c'.repeat(64),sourceFrames:2,from:0,frames:2,width:2,height:2,includePicture:false,audioLanes:['mix']};
async function packet(){const bytes=await encodePreviewPage(expected,[],[{lane:'mix',data:new Uint8Array(2*1600*6)}]);return {bytes,headers:{'content-type':'application/vnd.hollywood-video.preview','x-hv-preview-sha256':await previewDigest(bytes)}};}
test('bounded preview fetch authenticates chunked bodies without Content-Length and enforces the full requested identity',async()=>{
  const {bytes,headers}=await packet();let at=0;const response=()=>new Response(new ReadableStream({pull(c){if(at===bytes.length){c.close();return;}const end=Math.min(at+7,bytes.length);c.enqueue(bytes.slice(at,end));at=end;}}),{headers});
  const decoded=await fetchPreviewPacket('http://fixture',expected,async()=>response());expect(decoded.page.audio.mix?.length).toBe(2*1600*6);expect(decoded.bytes).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
  await expect(fetchPreviewPacket('http://fixture',{...expected,sourceRevision:'d'.repeat(64)},async()=>new Response(new Uint8Array(bytes),{headers}))).rejects.toThrow('changed');
  await expect(fetchPreviewPacket('http://fixture',expected,async()=>new Response(new Uint8Array(bytes),{headers:{...headers,'content-length':String(bytes.length+1)}}))).rejects.toThrow('changed');
  const changed=bytes.slice();changed[changed.length-1]=1;await expect(fetchPreviewPacket('http://fixture',expected,async()=>new Response(changed,{headers}))).rejects.toThrow('checksum');
});
test('bounded preview fetch cancels oversized or rejected streams before accumulating more bytes',async()=>{
  const {headers}=await packet();let cancelled=false,pulls=0;const stream=new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(1024**2));},cancel(){cancelled=true;}},{highWaterMark:0});
  await expect(fetchPreviewPacket('http://fixture',expected,async()=>new Response(stream,{headers}))).rejects.toThrow('changed');expect(cancelled).toBe(true);expect(pulls).toBe(17);
  let read=false,closed=false;const forbidden=new ReadableStream({pull(){read=true;},cancel(){closed=true;}},{highWaterMark:0});await expect(fetchPreviewPacket('http://fixture',expected,async()=>new Response(forbidden,{status:401}))).rejects.toThrow('changed');expect(read).toBe(false);expect(closed).toBe(true);
});

test('source facts bind native PNG encoding even when a substituted legacy page is correctly resealed',async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8y8Dwn4GBgYEFRIAwAB8HAgKLXcS/AAAAAElFTkSuQmCC','base64'),jpeg=Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAE1/f//Z','base64');
  const legacy:PreviewPageIdentity={...expected,sourceId:'graphic',includePicture:true,audioLanes:[],pictureFrames:[0]},native:PreviewPageIdentity={...legacy,pictureEncoding:'png-rgba'};
  const fetcher=async(identity:PreviewPageIdentity,data:Uint8Array)=>{const bytes=await encodePreviewPage(identity,[{frame:0,sourceSha256:'d'.repeat(64),data}],[]);return async()=>new Response(new Uint8Array(bytes),{headers:{'content-type':'application/vnd.hollywood-video.preview','x-hv-preview-sha256':await previewDigest(bytes)}});};
  expect((await fetchPreviewPacket('http://fixture',native,await fetcher(native,png))).page.header.pictureEncoding).toBe('png-rgba');
  await expect(fetchPreviewPacket('http://fixture',native,await fetcher(legacy,jpeg))).rejects.toThrow('changed');
  await expect(fetchPreviewPacket('http://fixture',legacy,await fetcher(native,png))).rejects.toThrow('changed');
});

test('timeline picture fetch binds the expected composition purpose even when all remaining identity fields agree',async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8y8Dwn4GBgYEFRIAwAB8HAgKLXcS/AAAAAElFTkSuQmCC','base64'),composite:PreviewPageIdentity={...expected,sourceId:'timeline-picture',includePicture:true,audioLanes:[],pictureFrames:[0],pictureEncoding:'png-rgba',picturePurpose:'timeline-composite'},bytes=await encodePreviewPage(composite,[{frame:0,sourceSha256:'d'.repeat(64),data:png}],[]),headers={'content-type':'application/vnd.hollywood-video.preview','x-hv-preview-sha256':await previewDigest(bytes)},fetcher=async()=>new Response(new Uint8Array(bytes),{headers});
  expect((await fetchPreviewPacket('http://fixture',composite,fetcher)).page.header.schema).toBe('hv-edit-preview-page/3');
  const {picturePurpose:_purpose,...withoutPurpose}=composite;await expect(fetchPreviewPacket('http://fixture',withoutPurpose,fetcher)).rejects.toThrow('changed');
  await expect(fetchPreviewPacket('http://fixture',{...composite,picturePurpose:'original'} as unknown as PreviewPageIdentity,fetcher)).rejects.toThrow('changed');
});
