import {EditTime} from "./edit-time";
import type {EditClip} from "./edit-timeline";
import {editGainScale} from "./edit-sampling";
import {editRenderGainQ20} from "./edit-transition-render";

export const EDIT_AUDIO_BLOCK=4096;
/** Half-open original sample range, including bounded interpolation/filter support. */
export function editAudioRange(time:EditTime,start:number,end:number,sourceSamples:number):{start:number;end:number}{
  const radius=Math.ceil(16*Math.max(1,time.maximumRate));
  return {start:Math.max(0,Math.floor(time.source(start))-radius),end:Math.min(sourceSamples,Math.floor(time.source(end-1))+radius+1)};
}
/** Shared stereo varispeed kernel. Holds are silent; downsampling suppresses frequencies above local Nyquist. */
export function addRetimeAudio(clip:EditClip,time:EditTime,start:number,end:number,output:Float64Array,outputAt:number,sourceSamples:number,read:(sample:number,channel:0|1)=>number,scale=editGainScale(clip)):void{
  for(let at=start;at<end;at++){
    const speed=time.speed(at);if(speed===0)continue;
    const position=time.source(at),gain=editRenderGainQ20(clip,time.phase(at),scale,at)/1048576,index=(at-outputAt)*2;
    if(speed<=1&&Number.isInteger(position)){if(position>=0&&position<sourceSamples){output[index]!+=read(position,0)*gain;output[index+1]!+=read(position,1)*gain;}continue;}
    const radius=16*Math.max(1,speed),cutoff=1/Math.max(1,speed);let left=0,right=0,total=0;
    for(let sample=Math.ceil(position-radius);sample<=Math.floor(position+radius);sample++){
      const x=sample-position,z=Math.PI*x*cutoff,window=.42+.5*Math.cos(Math.PI*x/radius)+.08*Math.cos(2*Math.PI*x/radius),weight=(z===0?cutoff:cutoff*Math.sin(z)/z)*window;total+=weight;
      if(sample>=0&&sample<sourceSamples){left+=read(sample,0)*weight;right+=read(sample,1)*weight;}
    }
    output[index]!+=left/total*gain;output[index+1]!+=right/total*gain;
  }
}
