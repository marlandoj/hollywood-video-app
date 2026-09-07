import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {speechWavHeader} from "../../generator/src/speech";
import {createSpeechPlayer,fetchSpeechLine,speechLineBuffer} from "../src/speech-player.js";
import {describeLineDelivery} from "../src/performances.js";

const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
function fixture(){
  const samples=[99,100,-32768,-1,0,32767,100,99],pcm=Buffer.alloc(samples.length*2);samples.forEach((v,i)=>pcm.writeInt16LE(v,i*2));
  const wav=Buffer.concat([speechWavHeader(samples.length),pcm]),report={sampleRate:22050,totalSamples:samples.length},line={startSample:2,endSample:6,pcmSha256:hash(pcm.subarray(4,12))},calls=[];
  const fetcher=async(url,options)=>{calls.push({url,options});const [,a,b]=/bytes=(\d+)-(\d+)/.exec(options.headers.Range),start=Number(a),end=Number(b);
    return new Response(wav.subarray(start,end+1),{status:206,headers:{"content-range":`bytes ${start}-${end}/${wav.length}`,"content-length":String(end-start+1)}});};
  return {wav,report,line,calls,fetcher};
}
function context(){
  const nodes=[],buffers=[],ctx={closed:0,destination:{},async resume(){},async close(){ctx.closed++;},createBuffer(channels,length,sampleRate){const data=new Float32Array(length),b={channels,length,sampleRate,getChannelData:()=>data};buffers.push(b);return b;},
    createBufferSource(){const source={starts:0,stops:0,disconnected:0,buffer:null,onended:null,connect(){},disconnect(){source.disconnected++;},start(){source.starts++;},stop(){source.stops++;}};nodes.push(source);return source;}};
  return {ctx,nodes,buffers};
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test("a retained line fetches only its header and exact PCM window, then converts signed samples at the original rate",async()=>{
  const f=fixture(),pcm=await fetchSpeechLine("/private.wav",f.report,f.line,undefined,f.fetcher);
  expect(f.calls.map(c=>c.options.headers.Range)).toEqual(["bytes=0-43","bytes=48-55"]);
  expect(f.calls.every(c=>c.options.credentials==="omit"&&c.options.redirect==="error"&&c.options.cache==="no-store")).toBe(true);
  expect(Buffer.from(pcm)).toEqual(f.wav.subarray(48,56));const c=context(),buffer=speechLineBuffer(c.ctx,pcm,22050);
  expect([buffer.channels,buffer.length,buffer.sampleRate]).toEqual([1,4,22050]);expect([...buffer.getChannelData(0)]).toEqual([-1,-1/32768,0,32767/32768]);
});
test("invalid bounds or a changed WAV header fail before fetching a line",async()=>{
  for(const patch of [{startSample:-1},{endSample:9},{endSample:2},{startSample:.5},{pcmSha256:"bad"}]){const f=fixture();await expect(fetchSpeechLine("/a",f.report,{...f.line,...patch},undefined,f.fetcher)).rejects.toThrow();expect(f.calls).toHaveLength(0);}
  for(const offset of [0,4,8,16,20,22,24,28,32,34,36,40]){const f=fixture();f.wav[offset]^=1;await expect(fetchSpeechLine("/a",f.report,f.line,undefined,f.fetcher)).rejects.toThrow();expect(f.calls).toHaveLength(1);}
});
test("unbounded, wrong-range, truncated and oversized responses are refused and cancelled",async()=>{
  for(const mode of ["whole","range","total","length","truncated","oversized"]){const f=fixture();let cancelled=false;const response=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(mode==="oversized"?45:mode==="truncated"?43:44));if(mode==="truncated")c.close();},cancel(){cancelled=true;}}),{status:mode==="whole"?200:206,headers:{"content-range":mode==="range"?"bytes 1-44/60":mode==="total"?"bytes 0-43/61":"bytes 0-43/60","content-length":mode==="length"?"60":"44"}});
    await expect(fetchSpeechLine("/a",f.report,f.line,undefined,async()=>response)).rejects.toThrow();if(mode!=="truncated")expect(cancelled).toBe(true);
  }
});
test("a changed PCM window is refused even with the original header and byte counts",async()=>{
  const f=fixture();f.wav[50]^=1;await expect(fetchSpeechLine("/a",f.report,f.line,undefined,f.fetcher)).rejects.toThrow();expect(f.calls).toHaveLength(2);
});
test("chunked range responses can omit Content-Length but must still contain exactly the requested samples",async()=>{
  const f=fixture(),fetcher=async(url,options)=>{const response=await f.fetcher(url,options);response.headers.delete("content-length");return response;};
  expect(Buffer.from(await fetchSpeechLine("/a",f.report,f.line,undefined,fetcher))).toEqual(f.wav.subarray(48,56));
});
test("Stop aborts a pending load and its late response cannot begin playback",async()=>{
  const c=context(),load=deferred(),states=[];let signal;const player=createSpeechPlayer({createContext:()=>c.ctx,load:async(_u,_r,_l,s)=>{signal=s;return load.promise;}});
  const playing=player.play({url:"/a",report:{sampleRate:22050},line:{},onState:s=>states.push(s)});await Promise.resolve();player.stop();expect(signal.aborted).toBe(true);load.resolve(new Uint8Array(4));await playing;
  expect(states).toEqual(["loading","stopped"]);expect(c.nodes).toHaveLength(0);expect(c.ctx.closed).toBe(1);
});
test("another line stops the current source and natural completion releases its buffer and context",async()=>{
  const all=[],states=[[],[]],player=createSpeechPlayer({createContext:()=>{const c=context();all.push(c);return c.ctx;},load:async()=>new Uint8Array(4)});
  const play=i=>player.play({url:"/a",report:{sampleRate:22050},line:{},onState:s=>states[i].push(s)});
  await play(0);const stale=all[0].nodes[0].onended;await play(1);stale();expect(states[0]).toEqual(["loading","playing","stopped"]);expect(all[0].nodes[0].buffer).toBeNull();expect(all[0].ctx.closed).toBe(1);
  all[1].nodes[0].onended();expect(states[1]).toEqual(["loading","playing","finished"]);expect(all[1].ctx.closed).toBe(1);expect(all[1].nodes[0].buffer).toBeNull();player.stop();expect(all[1].ctx.closed).toBe(1);
});
test("failed or stopped context resume cannot leak a context or start a deferred read",async()=>{
  const c=context(),resume=deferred(),states=[];c.ctx.resume=()=>resume.promise;let loads=0;const player=createSpeechPlayer({createContext:()=>c.ctx,load:async()=>{loads++;return new Uint8Array(4);}});
  const task=player.play({url:"/a",report:{sampleRate:22050},line:{},onState:s=>states.push(s)});player.stop();resume.reject(new Error("closed"));await task;expect(loads).toBe(0);expect(c.ctx.closed).toBe(1);expect(states).toEqual(["loading","stopped"]);
});
test("retained Azure descriptions use the saved style and intensity; other voice controls remain explicit",()=>{
  const voice={voice:"en-us+f3",rateWpm:110,pitch:45,level:95};expect(describeLineDelivery({voice})).toBe("en-us+f3 · 110 words/min · pitch 45 · level 95");
  const take={policy:{label:"Jane"},line:{profile:{provider:"azure",controls:{emotion:"neutral",style:"whispering",intensity:.7,speed:.9,volume:1}}}};
  expect(describeLineDelivery({voice,audition:{source:{take}}})).toBe("Jane · whispering · intensity 0.7 · speed 0.9 · volume 1 · retained audition");
});
