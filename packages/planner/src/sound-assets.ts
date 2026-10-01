import {contentHash} from "../../generator/src/capabilities";
import {audioHash,audioNumber,audioRecord} from "./audio-performances";
import {checkPrompt,type SafetyVerdict} from "../../safety/src/index";
export const SOUND_RATE=48000,SOUND_CHANNELS=2,SOUND_FRAME_BYTES=6,MAX_SOUND_SECONDS=600,MAX_SOUND_UPLOAD_BYTES=128*1024**2,MAX_SOUND_ASSETS=64,MAX_SOUND_LIBRARY_BYTES=512*1024**2;
export class SoundError extends Error {}
export class SoundConflict extends SoundError {}
export function soundFail(message:string):never{throw new SoundError(message);}
export function soundId(value:unknown):string{if(typeof value!=="string"||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value))soundFail("Invalid sound identity.");return value;}
export function soundText(value:unknown,label:string,max:number):string{if(typeof value!=="string"||!value.trim()||value.length>max||[...value].some(c=>c.charCodeAt(0)<32&&c!=="\n"&&c!=="\t"||c.charCodeAt(0)===127))soundFail("Use "+label+" of one to "+max+" characters.");return value.trim();}
export interface SoundRights {basis:"original"|"licensed"|"public-domain";source:string;credit:string;terms:string;attestedAt:string}
export interface SoundAsset {schema:"hv-sound-asset/1";id:string;projectId:string;label:string;createdAt:string;rights:SoundRights;original:{sha256:string;bytes:number;sampleRate:number;channels:number;frames:number;encoding:string};audio:{sha256:string;bytes:number;frames:number};engineVersion:string;revision:string}
export interface SoundAssetEvent {version:number;assetId:string;available:boolean;at:string;revision:string}
export interface SoundLibrary {schema:"hv-sound-library/1";version:number;assets:SoundAsset[];events:SoundAssetEvent[]}
export const emptySoundLibrary=():SoundLibrary=>({schema:"hv-sound-library/1",version:0,assets:[],events:[]});
export function soundRights(input:unknown,now=Date.now()):SoundRights{const value=audioRecord(input,["basis","source","credit","terms","attested"]);if(value.attested!==true||!["original","licensed","public-domain"].includes(String(value.basis)))soundFail("Confirm the recording's source and your right to use and distribute it in this film.");
  if(typeof value.credit!=="string"||value.credit.length>500)soundFail("Use a credit of up to 500 characters.");return {basis:value.basis as SoundRights["basis"],source:soundText(value.source,"a recording source",1000),credit:value.credit? soundText(value.credit,"a credit",500):"",terms:soundText(value.terms,"licence or ownership notes",2000),attestedAt:new Date(now).toISOString()};}
/**
 * HV-031-13: a sound's label, source, credit and licence notes are the creator's own words. The
 * library shows them, the spotting list and cue sheet credit them, and SDH puts the label in front of
 * viewers -- yet until this increment none of them met the prompt gate that every other creator text
 * meets. Each field is checked alone, so the refusal can name it, and then all of them together, so
 * a refusal can't be split across fields (HV-030-21). Controls that are not a newline or tab are
 * refused here too, C1 included, which `soundText` never covered.
 *
 * This runs where a sound is admitted, never in `validateSoundAsset`: a stored record is read back
 * as it was saved, so no library that was valid yesterday becomes unreadable today.
 */
export class SoundRefused extends SoundError {override name="SafetyRefusal";constructor(readonly safety:SafetyVerdict,message:string){super(message);}}
const SOUND_CONTROL=/[^\P{Cc}\n\t]/u;
export function gateSoundText(label:string,rights:Pick<SoundRights,"source"|"credit"|"terms">):void{
  const fields:[string,string][]=[["label",label],["recording source",rights.source],["credit",rights.credit],["licence or ownership notes",rights.terms]];
  for(const [field,text] of fields)if(SOUND_CONTROL.test(text))soundFail("Remove the control characters from the sound's "+field+".");
  for(const [field,text] of fields){const verdict=checkPrompt(text),notes=field.endsWith("notes");if(text&&!verdict.allowed)throw new SoundRefused(verdict,"We can't keep this sound: its "+field+(notes?" name a real person or fall":" names a real person or falls")+" outside the content policy. Reword "+(notes?"them":"it")+" and import the recording again -- nothing was stored.");}
  const joined=checkPrompt(fields.map(([,text])=>text).filter(Boolean).join("\n"));
  if(!joined.allowed)throw new SoundRefused(joined,"We can't keep this sound: its label, source, credit and licence notes, taken together, fall outside the content policy. Reword them and import the recording again -- nothing was stored.");
}
/** The label and rights of a sound being admitted from a creator, normalized and gated. */
export function admitSoundText(label:unknown,rightsInput:unknown,now=Date.now()):{label:string;rights:SoundRights}{const rights=soundRights(rightsInput,now),name=soundText(label,"a sound label",120);gateSoundText(name,rights);return {label:name,rights};}
export function validateSoundAsset(asset:SoundAsset,projectId:string):SoundAsset{
  audioRecord(asset,["schema","id","projectId","label","createdAt","rights","original","audio","engineVersion","revision"]);soundId(asset.id);soundId(projectId);
  if(asset.schema!=="hv-sound-asset/1"||asset.projectId!==projectId||soundText(asset.label,"a sound label",120)!==asset.label||!Number.isFinite(Date.parse(asset.createdAt)))soundFail("Invalid sound asset metadata.");
  audioRecord(asset.rights,["basis","source","credit","terms","attestedAt"]);const {attestedAt,...rights}=asset.rights;if(attestedAt!==asset.createdAt||contentHash(asset.rights)!==contentHash(soundRights({...rights,attested:true},Date.parse(asset.createdAt))))soundFail("The sound's rights record changed.");
  audioRecord(asset.original,["sha256","bytes","sampleRate","channels","frames","encoding"]);audioHash(asset.original.sha256);audioNumber(asset.original.bytes,44,MAX_SOUND_UPLOAD_BYTES,"Original sound bytes",true);audioNumber(asset.original.sampleRate,8000,192000,"Sound sample rate",true);audioNumber(asset.original.channels,1,2,"Sound channels",true);audioNumber(asset.original.frames,1,asset.original.sampleRate*MAX_SOUND_SECONDS,"Sound frames",true);
  if(!["pcm_u8","pcm_s16le","pcm_s24le","pcm_s32le","pcm_f32le","pcm_f64le"].includes(asset.original.encoding))soundFail("Choose an uncompressed PCM or floating-point WAV recording.");
  audioRecord(asset.audio,["sha256","bytes","frames"]);audioHash(asset.audio.sha256);if(asset.audio.frames!==Math.round(asset.original.frames*SOUND_RATE/asset.original.sampleRate)||asset.audio.bytes!==44+asset.audio.frames*SOUND_FRAME_BYTES||!/^ffmpeg-sound-[a-f0-9]{64}$/.test(asset.engineVersion))soundFail("The normalized sound length or runtime changed.");
  const {revision,...data}=asset;if(contentHash(data)!==revision)soundFail("The sound asset receipt changed.");return structuredClone(asset);
}
export function soundAssetKey(asset:SoundAsset,kind:"original"|"audio"):string{validateSoundAsset(asset,asset.projectId);return asset.projectId+"/sounds/"+asset.id+"/"+kind+"-"+asset[kind].sha256+".wav";}
export function soundAssetObjectKey(asset:SoundAsset,kind:"original"|"audio"):string{return "v1/"+soundAssetKey(asset,kind);}
export function validateSoundLibrary(input:SoundLibrary,projectId:string):SoundLibrary{
  audioRecord(input,["schema","version","assets","events"]);if(input.schema!=="hv-sound-library/1"||!Array.isArray(input.assets)||input.assets.length>MAX_SOUND_ASSETS||!Array.isArray(input.events)||input.events.length>1000||input.version!==input.events.length)soundFail("Invalid sound library history.");
  input.assets.forEach(a=>validateSoundAsset(a,projectId));if(new Set(input.assets.map(a=>a.id)).size!==input.assets.length||input.assets.reduce((n,a)=>n+a.original.bytes+a.audio.bytes,0)>MAX_SOUND_LIBRARY_BYTES)soundFail("The sound library exceeds its retained media limit.");
  const seen=new Set<string>();let at=-Infinity;for(const [i,event]of input.events.entries()){audioRecord(event,["version","assetId","available","at","revision"]);if(event.version!==i+1||typeof event.available!=="boolean"||!input.assets.some(a=>a.id===event.assetId)||!Number.isFinite(Date.parse(event.at))||Date.parse(event.at)<at||!seen.has(event.assetId)&&!event.available)soundFail("Invalid sound availability event.");const {revision,...data}=event;if(contentHash(data)!==revision)soundFail("Sound availability history changed.");seen.add(event.assetId);at=Date.parse(event.at);}
  if(seen.size!==input.assets.length)soundFail("A sound is missing its admission event.");return structuredClone(input);
}
export function soundAssetAvailable(library:SoundLibrary,asset:SoundAsset):boolean{return library.assets.some(a=>a.id===asset.id&&a.revision===asset.revision)&&library.events.filter(e=>e.assetId===asset.id).at(-1)?.available===true;}
export function updateSoundLibrary(library:SoundLibrary,projectId:string,expectedVersion:number,input:SoundAsset|{assetId:string;available:boolean},now=Date.now()):SoundLibrary{
  const current=validateSoundLibrary(library,projectId);if(expectedVersion!==current.version)throw new SoundConflict("The sound library changed. Reload before saving.");if(current.events.length>=1000)soundFail("This project has reached its sound history limit.");let assetId:string,available:boolean;
  if("schema" in input){const asset=validateSoundAsset(input,projectId);gateSoundText(asset.label,asset.rights);if(current.assets.some(a=>a.id===asset.id))soundFail("This sound is already in the library.");current.assets.push(asset);assetId=asset.id;available=true;}
  else{audioRecord(input,["assetId","available"]);assetId=soundId(input.assetId);available=input.available;if(typeof available!=="boolean"||!current.assets.some(a=>a.id===assetId))soundFail("Choose a retained sound and its availability.");}
  const data={version:current.version+1,assetId,available,at:new Date(Math.max(now,Date.parse(current.events.at(-1)?.at??"")||0)).toISOString()};current.version=data.version;current.events.push({...data,revision:contentHash(data)});return validateSoundLibrary(current,projectId);
}
