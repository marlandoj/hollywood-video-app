/** Retained speech is canonical mono PCM16. Fetch and verify only the chosen line. */
const MAX_LINE_SAMPLES=22050*600;
const unavailable=()=>new Error("This line's audio is unavailable or changed. Reload the result and try again.");
async function readRange(url,start,end,total,signal,fetcher){
  const response=await fetcher(url,{credentials:"omit",redirect:"error",cache:"no-store",signal,headers:{Range:`bytes=${start}-${end}`}});
  const size=end-start+1,length=response.headers.get("content-length");
  if(response.status!==206||response.headers.get("content-range")!==`bytes ${start}-${end}/${total}`||length!==null&&Number(length)!==size||!response.body){
    await response.body?.cancel();throw unavailable();
  }
  const reader=response.body.getReader(),bytes=new Uint8Array(size);let offset=0;
  try{while(true){signal?.throwIfAborted();const next=await reader.read();if(next.done)break;if(offset+next.value.length>size)throw unavailable();bytes.set(next.value,offset);offset+=next.value.length;}
    if(offset!==size)throw unavailable();return bytes;
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function fetchSpeechLine(url,report,line,signal,fetcher=fetch){
  const {sampleRate,totalSamples}=report,{startSample,endSample,pcmSha256}=line;
  if(sampleRate!==22050||!Number.isSafeInteger(totalSamples)||totalSamples<1||totalSamples*2>0xffffffff-36||!Number.isSafeInteger(startSample)||!Number.isSafeInteger(endSample)||startSample<0||endSample<=startSample||endSample>totalSamples||endSample-startSample>MAX_LINE_SAMPLES||!/^[a-f0-9]{64}$/.test(pcmSha256))throw unavailable();
  const total=44+totalSamples*2,header=await readRange(url,0,43,total,signal,fetcher),view=new DataView(header.buffer);
  const text=(from,to)=>String.fromCharCode(...header.subarray(from,to));
  if(text(0,4)!=="RIFF"||view.getUint32(4,true)!==total-8||text(8,16)!=="WAVEfmt "||view.getUint32(16,true)!==16||view.getUint16(20,true)!==1||view.getUint16(22,true)!==1||view.getUint32(24,true)!==sampleRate||view.getUint32(28,true)!==sampleRate*2||view.getUint16(32,true)!==2||view.getUint16(34,true)!==16||text(36,40)!=="data"||view.getUint32(40,true)!==totalSamples*2)throw unavailable();
  const pcm=await readRange(url,44+startSample*2,44+endSample*2-1,total,signal,fetcher);
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",pcm)),b=>b.toString(16).padStart(2,"0")).join("");
  signal?.throwIfAborted();if(digest!==pcmSha256)throw unavailable();return pcm;
}
export function speechLineBuffer(context,pcm,sampleRate){
  const buffer=context.createBuffer(1,pcm.length/2,sampleRate),channel=buffer.getChannelData(0),view=new DataView(pcm.buffer,pcm.byteOffset,pcm.byteLength);
  for(let i=0;i<channel.length;i++)channel[i]=view.getInt16(i*2,true)/32768;
  return buffer;
}
/** One active line, no retained decoded tracks, and no late playback after Stop. */
export function createSpeechPlayer({createContext=()=>new AudioContext(),load=fetchSpeechLine}={}){
  let active=null;
  function finish(run,state){
    if(active!==run)return;active=null;clearTimeout(run.timer);run.controller.abort();
    if(run.source){run.source.onended=null;try{run.source.stop();}catch{}run.source.disconnect();run.source.buffer=null;run.source=null;}
    if(run.context)void run.context.close().catch(()=>{});run.onState(state);
  }
  return {stop(){if(active)finish(active,"stopped");},async play({url,report,line,onState}){
    if(active)finish(active,"stopped");const run={controller:new AbortController(),context:null,source:null,onState,timer:null};active=run;run.timer=setTimeout(()=>finish(run,"unavailable"),60000);onState("loading");
    try{run.context=createContext();await run.context.resume();if(active!==run)return;
      const pcm=await load(url,report,line,run.controller.signal);if(active!==run)return;
      run.source=run.context.createBufferSource();run.source.buffer=speechLineBuffer(run.context,pcm,report.sampleRate);run.source.connect(run.context.destination);
      run.source.onended=()=>finish(run,"finished");run.source.start();clearTimeout(run.timer);onState("playing");
    }catch{if(active===run)finish(run,"unavailable");}
  }};
}
