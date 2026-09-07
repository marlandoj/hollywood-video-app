/** Bounded stereo transport. Missing picture or audio holds the source sample clock. */
const PAGE_FRAMES=60,SAMPLES_PER_FRAME=1600,PAGE_SAMPLES=PAGE_FRAMES*SAMPLES_PER_FRAME;
const integer=(n,lo,hi)=>Number.isSafeInteger(n)&&n>=lo&&n<=hi;
function sample(pcm,index){const n=pcm[index]+pcm[index+1]*256+pcm[index+2]*65536;return (n>=8388608?n-16777216:n)/8388608;}
export class PreviewPcmTransport {
  constructor(notify){this.notify=notify;this.epoch=0;this.frames=0;this.at=0;this.through=0;this.coverage=[0,0];this.streams=1;this.listening=0;this.playing=false;this.pages=new Map();this.alternatePages=new Map();this.state="stopped";this.last=-Infinity;}
  message(message){
    const m=message;
    if(!m||typeof m!=="object")throw new Error("Invalid preview transport message.");
    if(m.kind==="reset"){
      if(!integer(m.epoch,this.epoch+1,Number.MAX_SAFE_INTEGER)||!integer(m.frames,1,108000)||!integer(m.at,0,m.frames*SAMPLES_PER_FRAME)||!integer(m.streams??1,1,2))throw new Error("Invalid preview transport position.");
      this.epoch=m.epoch;this.frames=m.frames;this.at=m.at;this.through=m.at;this.coverage=[m.at,m.at];this.streams=m.streams??1;this.listening=0;this.playing=false;this.pages.clear();this.alternatePages.clear();this.state="paused";this.last=-Infinity;return;
    }
    if(m.epoch!==this.epoch)return;
    if(m.kind==="page"){
      const first=Math.floor(this.at/PAGE_SAMPLES)*PAGE_FRAMES,stream=m.stream??0;
      if(!integer(stream,0,this.streams-1)||!integer(m.from,0,this.frames-1)||m.from%PAGE_FRAMES||!(m.pcm instanceof Uint8Array)||m.pcm.byteLength!==Math.min(PAGE_FRAMES,this.frames-m.from)*SAMPLES_PER_FRAME*6)throw new Error("Preview transport samples changed.");
      // Obsolete or excessively speculative pages cannot occupy the audio thread.
      if(m.from<first||m.from>first+2*PAGE_FRAMES)return;
      (stream===0?this.pages:this.alternatePages).set(m.from,m.pcm);return;
    }
    if(m.kind==="picture"){
      const stream=m.stream??0;if(!integer(stream,0,this.streams-1)||!integer(m.through,Math.floor(this.at/SAMPLES_PER_FRAME),this.frames))throw new Error("Invalid preview picture coverage.");
      this.coverage[stream]=m.through*SAMPLES_PER_FRAME;this.through=this.streams===2?Math.min(...this.coverage):this.coverage[0];return;
    }
    if(m.kind==="listen"){if(!integer(m.stream,0,this.streams-1))throw new Error("Choose an available comparison soundtrack.");this.listening=m.stream;return;}
    if(m.kind==="play"){this.playing=true;return;}
    if(m.kind==="pause"){this.playing=false;return;}
    if(m.kind==="stop"){this.playing=false;this.pages.clear();this.alternatePages.clear();this.through=this.at;this.coverage=[this.at,this.at];this.state="stopped";return;}
    throw new Error("Unknown preview transport message.");
  }
  report(state,clockFrame,force=false){if(force||state!==this.state||clockFrame-this.last>=960){this.state=state;this.last=clockFrame;this.notify({epoch:this.epoch,state,at:this.at,contextFrame:clockFrame,pages:this.pages.size+this.alternatePages.size});}}
  render(left,right,clockFrame){
    if(!integer(left.length,1,32768)||right.length!==left.length||!integer(clockFrame,0,Number.MAX_SAFE_INTEGER))throw new Error("Invalid preview output block.");
    left.fill(0);right.fill(0);
    if(!this.playing){this.report(["stopped","ended"].includes(this.state)?this.state:"paused",clockFrame);return;}
    const count=Math.min(left.length,this.frames*SAMPLES_PER_FRAME-this.at);
    if(!count){this.playing=false;this.report("ended",clockFrame);return;}
    if(this.at+count>this.through){this.report("buffering",clockFrame);return;}
    for(let cursor=this.at;cursor<this.at+count;){const from=Math.floor(cursor/PAGE_SAMPLES)*PAGE_FRAMES;if(!this.pages.has(from)||this.streams===2&&!this.alternatePages.has(from)){this.report("buffering",clockFrame);return;}cursor=Math.min(this.at+count,(from+PAGE_FRAMES)*SAMPLES_PER_FRAME);}
    this.report("playing",clockFrame);
    let cursor=this.at;const selected=this.listening===0?this.pages:this.alternatePages;
    for(let i=0;i<count;i++,cursor++){const from=Math.floor(cursor/PAGE_SAMPLES)*PAGE_FRAMES,pcm=selected.get(from),offset=(cursor-from*SAMPLES_PER_FRAME)*6;left[i]=sample(pcm,offset);right[i]=sample(pcm,offset+3);}
    this.at+=count;
    for(const from of this.pages.keys())if((from+PAGE_FRAMES)*SAMPLES_PER_FRAME<=this.at)this.pages.delete(from);
    if(this.streams===2)for(const from of this.alternatePages.keys())if((from+PAGE_FRAMES)*SAMPLES_PER_FRAME<=this.at)this.alternatePages.delete(from);
    if(this.at===this.frames*SAMPLES_PER_FRAME){this.playing=false;this.pages.clear();this.alternatePages.clear();this.report("ended",clockFrame+count,true);}
  }
}
if(typeof registerProcessor==="function"){
  class HollywoodPreviewProcessor extends AudioWorkletProcessor {
    constructor(){super();if(sampleRate!==48000)throw new Error("Preview requires a 48 kHz audio context.");this.transport=new PreviewPcmTransport(message=>this.port.postMessage(message));this.failed=false;this.port.onmessage=event=>{try{this.transport.message(event.data);this.port.postMessage({kind:"accepted",command:event.data.kind,requestId:event.data.requestId,epoch:this.transport.epoch,at:this.transport.at});}catch{this.failed=true;this.port.postMessage({epoch:this.transport.epoch,state:"error",error:"Preview audio changed. Prepare the current cut again."});}};}
    process(_inputs,outputs){const channels=outputs[0];if(this.failed||!channels||channels.length!==2){for(const channel of channels??[])channel.fill(0);return !this.failed;}try{this.transport.render(channels[0],channels[1],currentFrame);return true;}catch{for(const channel of channels)channel.fill(0);this.port.postMessage({epoch:this.transport.epoch,state:"error",error:"Preview audio stopped. Prepare the current cut again."});return false;}}
  }
  registerProcessor("hollywood-preview",HollywoodPreviewProcessor);
}
