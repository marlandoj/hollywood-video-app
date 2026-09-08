const failure=()=>new Error('The original picture changed or is unavailable. Reload the saved cut.');
const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
const pause=(signal)=>new Promise((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(signal.reason);},timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},1500);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});
export async function loadMaskSourceFrame(client,{saved,sourceId,sourceFrame,signal}){
  const source=saved.timeline.sources.find(item=>item.id===sourceId),history=saved.sequence.history.revision;if(!source||!Number.isSafeInteger(sourceFrame)||sourceFrame<0||sourceFrame>=source.frames)throw failure();
  const active=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(20*60*1000)]),path='/sequences/'+encodeURIComponent(saved.sequence.id)+'/sources/'+encodeURIComponent(sourceId)+'/frames/'+sourceFrame+'?historyRevision='+history;
  while(true){
    active.throwIfAborted();const response=await client.mediaRequest(path,{signal:active,credentials:'omit',redirect:'error',cache:'no-store'});
    if(response.status===202){const status=await response.json();if(status.state!=='preparing'||status.historyRevision!==history)throw failure();await pause(active);continue;}
    const hash=response.headers.get('x-hv-preview-sha256'),length=response.headers.get('content-length'),maximum=64*1024**2;
    if(!response.ok||response.headers.get('x-hv-history-revision')!==history||response.headers.get('content-type')!=='image/png'||!hash||!/^[a-f0-9]{64}$/.test(hash)||length!==null&&(!/^\d+$/.test(length)||Number(length)<57||Number(length)>maximum)||!response.body||response.headers.get('x-hv-source-id')!==sourceId||response.headers.get('x-hv-source-revision')!==source.revision||response.headers.get('x-hv-source-frame')!==String(sourceFrame)||Number(response.headers.get('x-hv-source-width'))!==source.width||Number(response.headers.get('x-hv-source-height'))!==source.height||!/^[a-f0-9]{64}$/.test(response.headers.get('x-hv-source-sha256')??'')){await response.body?.cancel();throw failure();}
    let buffer=new Uint8Array(length===null?4096:Number(length)),offset=0;const reader=response.body.getReader();
    try{while(true){active.throwIfAborted();const next=await reader.read();if(next.done)break;const total=offset+next.value.length;if(total>maximum||length!==null&&total>Number(length))throw failure();if(total>buffer.length){const grown=new Uint8Array(Math.min(maximum,Math.max(total,buffer.length*2)));grown.set(buffer.subarray(0,offset));buffer=grown;}buffer.set(next.value,offset);offset=total;}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    const bytes=buffer.subarray(0,offset);active.throwIfAborted();if(offset<57||length!==null&&offset!==Number(length)||await digest(bytes)!==hash||[137,80,78,71,13,10,26,10].some((value,index)=>bytes[index]!==value))throw failure();
    const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));if(active.aborted||bitmap.width!==source.width||bitmap.height!==source.height){bitmap.close();active.throwIfAborted();throw failure();}
    return {bitmap,width:source.width,height:source.height,sourceRevision:source.revision,sourceFrame,dispose:()=>bitmap.close()};
  }
}
