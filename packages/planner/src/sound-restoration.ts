import {contentHash} from "../../generator/src/capabilities";
import {audioHash,audioNumber,audioRecord} from "./audio-performances";
import {soundFail} from "./sound-assets";
export const RESTORATION_TRACKS=["dialogue","narration","music","ambience","effects"] as const;
export const RESTORATION_STEMS=[...RESTORATION_TRACKS,"me","mix"] as const;
export type RestorationTrack=typeof RESTORATION_TRACKS[number];
type Stem=typeof RESTORATION_STEMS[number];
export const RESTORATION_RECIPE={schema:"hv-sound-restoration-recipe/1",processor:"ffmpeg-afftdn",rate:48000,channels:2,hopFrames:600,delayFrames:1200,tailPaddingFrames:1800,trainingGapFrames:2400,precision:"dblp",quantization:"round-signed-24",clipping:"reject-before-quantization",residual:"exact-input-minus-output-float32",sum:"integer-restored-stems-clipping-reject",source:"pre-master-track-stems"} as const;
export interface TrackRestoration {track:RestorationTrack;amountDb:number;noiseFloorDb:number;tracking:boolean;smoothing:number;reference?:{start:number;frames:number;attested:true}}
export interface SoundRestoration {schema:"hv-sound-restoration/1";tracks:TrackRestoration[]}
export interface RestorationLevels {peak:[number,number];rms:[number,number]}
export interface RestoredTrack {settings:TrackRestoration;filter:string;inputSha256:string;outputSha256:string;removedSha256:string;referenceSha256?:string;before:RestorationLevels;after:RestorationLevels;removed:RestorationLevels;referenceLevels?:RestorationLevels}
export interface RestorationReport {schema:"hv-sound-restoration-result/1";settings:SoundRestoration;engineVersion:string;recipeRevision:string;inputStems:Record<Stem,string>;inputPeaks:Record<Stem,number>;tracks:RestoredTrack[]}
const step=(v:unknown,min:number,max:number,label:string)=>{const n=audioNumber(v,min,max,label);if(Math.abs(n*10-Math.round(n*10))>1e-8)soundFail("Use "+label+" in steps of 0.1.");return n;};
export function soundRestoration(input:unknown,frames:number):SoundRestoration{
  const v=audioRecord(input,["schema","tracks"]);if(v.schema!=="hv-sound-restoration/1"||!Array.isArray(v.tracks)||v.tracks.length<1||v.tracks.length>5)soundFail("Review noise reduction for one to five sound tracks.");
  const tracks=v.tracks.map(raw=>{const t=audioRecord(raw,["track","amountDb","noiseFloorDb","tracking","smoothing","reference"]);if(!RESTORATION_TRACKS.includes(t.track as RestorationTrack)||typeof t.tracking!=="boolean")soundFail("Choose a sound track and whether to track its noise floor.");let reference:TrackRestoration["reference"];
    if(t.reference!==undefined){const r=audioRecord(t.reference,["start","frames","attested"]);if(r.attested!==true||t.tracking)soundFail("Attest that the reference contains only unwanted noise and disable automatic tracking for a learned profile.");const start=audioNumber(r.start,0,frames-1,"Noise reference start",true),duration=audioNumber(r.frames,12000,Math.min(240000,frames-start),"Noise reference duration",true);if(start%600||duration%600)soundFail("Place noise references on the 12.5 ms sample grid.");reference={start,frames:duration,attested:true};}
    return {track:t.track as RestorationTrack,amountDb:step(t.amountDb,.1,24,"noise reduction dB"),noiseFloorDb:step(t.noiseFloorDb,-80,-20,"noise floor dB"),tracking:t.tracking,smoothing:audioNumber(t.smoothing,0,20,"Noise smoothing",true),...(reference?{reference}:{})};
  }).sort((a,b)=>RESTORATION_TRACKS.indexOf(a.track)-RESTORATION_TRACKS.indexOf(b.track));if(new Set(tracks.map(t=>t.track)).size!==tracks.length)soundFail("Restore each sound track once.");return {schema:"hv-sound-restoration/1",tracks};
}
export function restorationFilter(t:TrackRestoration,frames:number):string{
  const prefix=t.reference?t.reference.frames+RESTORATION_RECIPE.trainingGapFrames:0,start=prefix+RESTORATION_RECIPE.delayFrames;
  return `apad=pad_len=1800,asetnsamples=n=600:p=1,aformat=sample_fmts=dblp,`+(t.reference?`asendcmd=c='0 afftdn sn start;${t.reference.frames/48000} afftdn sn stop',`:"")+`afftdn=nr=${t.amountDb}:nf=${t.noiseFloorDb}:nt=w:tn=${t.tracking?1:0}:tr=0:ad=0.5:nl=average:bm=1.25:gs=${t.smoothing}:om=o,atrim=start_sample=${start}:end_sample=${start+frames},asetpts=N/SR/TB`;
}
export function restorationFiles(settings:SoundRestoration):string[]{return ["restoration/report.json",...RESTORATION_STEMS.map(s=>"restoration/original/"+s+".wav"),...settings.tracks.flatMap(t=>["restoration/removed/"+t.track+".wav",...(t.reference?["restoration/reference/"+t.track+".wav"]:[])])];}
export function assertRestorationReferences(settings:SoundRestoration,windows:{start:number;end:number}[]):void{for(const t of settings.tracks){const r=t.reference;if(r&&["dialogue","narration"].includes(t.track)&&windows.some(w=>r.start<w.end&&r.start+r.frames>w.start))soundFail("Choose a noise-only reference outside measured voice windows for "+t.track+".");}}
export function validateRestorationReport(r:RestorationReport,settings:SoundRestoration,frames:number,engineVersion:string,stems:Record<Stem,string>):void{
  audioRecord(r,["schema","settings","engineVersion","recipeRevision","inputStems","inputPeaks","tracks"]);if(r.schema!=="hv-sound-restoration-result/1"||contentHash(r.settings)!==contentHash(settings)||r.engineVersion!==engineVersion||r.recipeRevision!==contentHash(RESTORATION_RECIPE))soundFail("The restoration receipt differs from its reviewed settings.");
  soundRestoration(settings,frames);audioRecord(r.inputStems,[...RESTORATION_STEMS]);Object.values(r.inputStems).forEach(audioHash);audioRecord(r.inputPeaks,[...RESTORATION_STEMS]);Object.values(r.inputPeaks).forEach(p=>audioNumber(p,0,8388608,"Unprocessed sample peak",true));
  if(!Array.isArray(r.tracks)||r.tracks.length!==settings.tracks.length)soundFail("A restored track lost its processing record.");
  for(const [i,t]of r.tracks.entries()){audioRecord(t,["settings","filter","inputSha256","outputSha256","removedSha256","referenceSha256","before","after","removed","referenceLevels"]);const s=settings.tracks[i]!;if(contentHash(t.settings)!==contentHash(s)||t.filter!==restorationFilter(s,frames)||t.inputSha256!==r.inputStems[s.track]||t.outputSha256!==stems[s.track]||Boolean(t.referenceSha256)!==Boolean(s.reference)||Boolean(t.referenceLevels)!==Boolean(s.reference))soundFail("A restored track changed its source, settings or output.");for(const h of [t.inputSha256,t.outputSha256,t.removedSha256,...(t.referenceSha256?[t.referenceSha256]:[])])audioHash(h);
    for(const [kind,l]of Object.entries({before:t.before,after:t.after,removed:t.removed,...(t.referenceLevels?{reference:t.referenceLevels}:{})})){audioRecord(l,["peak","rms"]);for(const a of [l.peak,l.rms]){if(!Array.isArray(a)||a.length!==2)soundFail("A restoration level lost its stereo channels.");a.forEach(n=>audioNumber(n,0,kind==="removed"?2:1,"Restoration level"));}if(l.rms.some((n,i)=>n>l.peak[i]!+1e-12))soundFail("Restoration RMS exceeds its measured peak.");}
  }
  for(const stem of RESTORATION_TRACKS)if(!settings.tracks.some(t=>t.track===stem)&&r.inputStems[stem]!==stems[stem])soundFail("Restoration changed an untreated track.");
}
