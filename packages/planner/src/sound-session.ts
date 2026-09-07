import {contentHash} from "../../generator/src/capabilities";
import {audioNumber,audioRecord} from "./audio-performances";
import {SOUND_RATE,soundId,soundFail,validateSoundAsset,type SoundAsset} from "./sound-assets";
export const SOUND_MIX_RECIPE={schema:"hv-sound-mix-recipe/1",sampleRate:48000,channels:2,encoding:"pcm_s24le",gainScale:1048576,envelope:"linear-amplitude",pan:"stereo-balance-attenuation",sum:"fixed-point-before-final-round",clipping:"reject",loops:"repeat-trimmed-window",picture:"unchanged",voiceTiming:"unchanged"} as const;
export const SOUND_ROLES=["music","ambience","effects"] as const;
export const SOUND_STEMS=["dialogue","narration",...SOUND_ROLES,"me","mix"] as const;
export type SoundStem=typeof SOUND_STEMS[number];
export interface SoundCue {id:string;asset:SoundAsset;role:typeof SOUND_ROLES[number];start:number;frames:number;trimIn:number;trimOut:number;loop:boolean;gainDb:number;balance:number;fadeIn:number;fadeOut:number;duckDb:number;duckAttack:number;duckRelease:number}
export interface SoundSession {schema:"hv-sound-session/1";review:"owner-reviewed";totalFrames:number;dialogueGainDb:number;narrationGainDb:number;cues:SoundCue[];revision:string}
const step=(value:unknown,min:number,max:number,label:string)=>{const n=audioNumber(value,min,max,label);if(Math.abs(n*10-Math.round(n*10))>1e-8)soundFail("Use "+label+" in steps of 0.1.");return n;};
export function soundSession(input:unknown,projectId:string,totalFrames:number):SoundSession{
  audioNumber(totalFrames,1,SOUND_RATE*3600,"Sound timeline frames",true);const v=audioRecord(input,["reviewed","dialogueGainDb","narrationGainDb","cues"]);if(v.reviewed!==true||!Array.isArray(v.cues)||v.cues.length>64)soundFail("Review up to 64 sound cues and the voice levels before rendering.");
  const cues=v.cues.map(raw=>{const c=audioRecord(raw,["id","asset","role","start","frames","trimIn","trimOut","loop","gainDb","balance","fadeIn","fadeOut","duckDb","duckAttack","duckRelease"]),asset=validateSoundAsset(c.asset as SoundAsset,projectId),id=soundId(c.id);
    if(!SOUND_ROLES.includes(c.role as SoundCue["role"])||typeof c.loop!=="boolean")soundFail("Choose a sound track and whether to loop its trimmed recording.");
    const start=audioNumber(c.start,0,totalFrames-1,"Cue start",true),frames=audioNumber(c.frames,1,totalFrames-start,"Cue duration",true),trimIn=audioNumber(c.trimIn,0,asset.audio.frames-1,"Sound trim in",true),trimOut=audioNumber(c.trimOut,trimIn+1,asset.audio.frames,"Sound trim out",true);
    if(!c.loop&&frames>trimOut-trimIn)soundFail("Shorten this cue or enable looping; audio is not stretched.");
    const fadeIn=audioNumber(c.fadeIn,0,frames,"Fade-in frames",true),fadeOut=audioNumber(c.fadeOut,0,frames,"Fade-out frames",true);if(fadeIn+fadeOut>frames)soundFail("Keep the cue's combined fades within its duration.");
    return {id,asset,role:c.role as SoundCue["role"],start,frames,trimIn,trimOut,loop:c.loop,gainDb:step(c.gainDb,-60,12,"sound gain"),balance:step(c.balance,-1,1,"stereo balance"),fadeIn,fadeOut,duckDb:step(c.duckDb,-36,0,"voice ducking"),duckAttack:audioNumber(c.duckAttack,0,SOUND_RATE*2,"Duck attack frames",true),duckRelease:audioNumber(c.duckRelease,0,SOUND_RATE*5,"Duck release frames",true)};
  }).sort((a,b)=>a.start-b.start||a.id.localeCompare(b.id));
  if(new Set(cues.map(c=>c.id)).size!==cues.length)soundFail("Use each sound cue identity once.");const assets=new Map<string,SoundAsset>();for(const c of cues){if(assets.has(c.asset.id)&&assets.get(c.asset.id)!.revision!==c.asset.revision)soundFail("The same sound cannot carry conflicting receipts.");assets.set(c.asset.id,c.asset);}
  if(cues.reduce((n,c)=>n+c.frames,0)>SOUND_RATE*3600)soundFail("Use up to one hour of combined sound cue duration in one session.");
  const data={schema:"hv-sound-session/1" as const,review:"owner-reviewed" as const,totalFrames,dialogueGainDb:step(v.dialogueGainDb,-60,6,"dialogue gain"),narrationGainDb:step(v.narrationGainDb,-60,6,"narration gain"),cues};return {...data,revision:contentHash(data)};
}
export function validateSoundSession(session:SoundSession,projectId:string,totalFrames:number):SoundSession{audioRecord(session,["schema","review","totalFrames","dialogueGainDb","narrationGainDb","cues","revision"]);const expected=soundSession({reviewed:session.review==="owner-reviewed",dialogueGainDb:session.dialogueGainDb,narrationGainDb:session.narrationGainDb,cues:session.cues},projectId,totalFrames);if(contentHash(expected)!==contentHash(session))soundFail("The reviewed sound session changed.");return expected;}
export function soundSessionAssets(session:SoundSession):SoundAsset[]{return [...new Map(session.cues.map(c=>[c.asset.id,c.asset])).values()].sort((a,b)=>a.id.localeCompare(b.id));}
export function soundCopiedAssetName(asset:SoundAsset,kind:"original"|"audio"):string{return "sounds/"+asset.id+"/"+kind+".wav";}
