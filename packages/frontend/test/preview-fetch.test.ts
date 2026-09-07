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
