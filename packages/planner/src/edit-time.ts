import type {EditClip} from "./edit-timeline";

export interface EditRatePoint {frame:number;rate:number}
/** Rates are thousandths of normal speed. Offset preserves the original curve through splits. */
export interface EditTiming {from:number;offset:number;points:EditRatePoint[]}
export const EDIT_TIME_RECIPE={schema:"hv-edit-time/1",rateScale:1000,phaseScale:65536,ramp:"linear-speed-integral",outside:"constant-endpoint-speed",picture:"floor-source-frame",audio:"local-speed-blackman-sinc-16-varispeed-zero-padded-muted-holds",envelope:"linear-output-phase"} as const;
const SAMPLES=1600,PHASE=EDIT_TIME_RECIPE.phaseScale;
/** A saved clip's common picture/audio/caption clock. Untimed clips retain integer source addresses. */
export class EditTime {
  readonly #clip:Pick<EditClip,"at"|"from"|"frames">;
  readonly #timing?:EditTiming;
  readonly #points:{at:number;rate:number;source:number}[]=[];
  readonly maximumRate:number;
  constructor(clip:EditClip){
    this.#clip={at:clip.at,from:clip.from,frames:clip.frames};this.#timing=clip.timing?{...clip.timing,points:clip.timing.points.map(p=>({...p}))}:undefined;
    if(clip.timing){let source=clip.timing.from*SAMPLES;for(const [i,p]of clip.timing.points.entries()){const previous=clip.timing.points[i-1];if(previous)source+=(p.frame-previous.frame)*SAMPLES*(p.rate+previous.rate)/2000;this.#points.push({at:p.frame*SAMPLES,rate:p.rate/1000,source});}}
    this.maximumRate=this.#points.length?Math.max(...this.#points.map(p=>p.rate)):1;
  }
  #position(sample:number){return sample-this.#clip.at*SAMPLES+(this.#timing?.offset??0)*SAMPLES;}
  #segment(at:number){let low=0,high=this.#points.length;while(low<high){const middle=(low+high)>>>1;if(this.#points[middle]!.at<=at)low=middle+1;else high=middle;}return Math.max(0,low-1);}
  source(sample:number):number{
    if(!this.#timing)return this.#clip.from*SAMPLES+sample-this.#clip.at*SAMPLES;
    const at=this.#position(sample),i=this.#segment(at),p=this.#points[i]!,next=this.#points[i+1],x=at-p.at;
    const value=p.source+p.rate*x+(at>=p.at&&next?(next.rate-p.rate)*x*x/(2*(next.at-p.at)):0);
    return Math.round(value*PHASE)/PHASE;
  }
  speed(sample:number):number{
    if(!this.#timing)return 1;const at=this.#position(sample),i=this.#segment(at),p=this.#points[i]!,next=this.#points[i+1];return at>=p.at&&next?p.rate+(next.rate-p.rate)*(at-p.at)/(next.at-p.at):p.rate;
  }
  frame(frame:number):number{return Math.floor(this.source(frame*SAMPLES)/SAMPLES);}
  phase(sample:number):number{return this.#timing?this.#timing.from*SAMPLES+this.#position(sample):this.source(sample);}
  /** First output sample at or beyond a source boundary; plateaus keep half-open cue semantics. */
  boundary(sourceSample:number):number{let low=this.#clip.at*SAMPLES,high=(this.#clip.at+this.#clip.frames)*SAMPLES;while(low<high){const middle=Math.floor((low+high)/2);if(this.source(middle)>=sourceSample)high=middle;else low=middle+1;}return low;}
}
export function editPhaseFrame(clip:EditClip,frame=clip.at):number{return (clip.timing?clip.timing.from+clip.timing.offset:clip.from)+frame-clip.at;}
