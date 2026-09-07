import {decodePreviewPage,PREVIEW_MAX_BYTES} from '../../planner/src/edit-preview-protocol';
const unavailable=()=>new Error('Preview media changed or is unavailable. Prepare the current saved cut again.');
/** The controller bounds callers and supplies cancellation/deadlines. Content-Length is optional. */
export async function fetchPreviewPacket(url,expected,fetcher,signal){
  signal?.throwIfAborted();const response=await fetcher(url,{signal,credentials:'omit',redirect:'error',cache:'no-store'});
  const hash=response.headers.get('x-hv-preview-sha256'),length=response.headers.get('content-length');
  if(!response.ok||response.headers.get('content-type')!=='application/vnd.hollywood-video.preview'||!hash||!/^[a-f0-9]{64}$/.test(hash)||length!==null&&(!/^\d+$/.test(length)||Number(length)<12||Number(length)>PREVIEW_MAX_BYTES)||!response.body){await response.body?.cancel();throw unavailable();}
  const reader=response.body.getReader();let buffer=new Uint8Array(length===null?4096:Number(length)),size=0;
  try{
    while(true){signal?.throwIfAborted();const next=await reader.read();if(next.done)break;const total=size+next.value.byteLength;if(total>PREVIEW_MAX_BYTES||length!==null&&total>Number(length))throw unavailable();
      if(total>buffer.byteLength){const grown=new Uint8Array(Math.min(PREVIEW_MAX_BYTES,Math.max(total,buffer.byteLength*2)));grown.set(buffer.subarray(0,size));buffer=grown;}buffer.set(next.value,size);size=total;
    }
    signal?.throwIfAborted();if(length!==null&&size!==Number(length))throw unavailable();const packet=buffer.subarray(0,size),page=await decodePreviewPage(packet,{sourceKey:expected.sourceKey,from:expected.from,sha256:hash});signal?.throwIfAborted();
    for(const key of ['sourceId','sourceRevision','engineVersion','sourceFrames','from','frames','width','height','includePicture'])if(page.header[key]!==expected[key])throw unavailable();
    if(JSON.stringify(page.header.audioLanes)!==JSON.stringify(expected.audioLanes)||JSON.stringify(page.header.pictureFrames)!==JSON.stringify(expected.pictureFrames))throw unavailable();return {page,bytes:buffer.byteLength};
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
