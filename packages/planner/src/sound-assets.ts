import {contentHash} from "../../generator/src/capabilities";
import {audioHash,audioNumber,audioRecord} from "./audio-performances";
export const SOUND_RATE=48000,SOUND_CHANNELS=2,SOUND_FRAME_BYTES=6,MAX_SOUND_SECONDS=600,MAX_SOUND_UPLOAD_BYTES=128*1024**2,MAX_SOUND_ASSETS=64,MAX_SOUND_LIBRARY_BYTES=512*1024**2;
export class SoundError extends Error {}
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
  const current=validateSoundLibrary(library,projectId);if(expectedVersion!==current.version)soundFail("The sound library changed. Reload before saving.");if(current.events.length>=1000)soundFail("This project has reached its sound history limit.");let assetId:string,available:boolean;
  if("schema" in input){const asset=validateSoundAsset(input,projectId);if(current.assets.some(a=>a.id===asset.id))soundFail("This sound is already in the library.");current.assets.push(asset);assetId=asset.id;available=true;}
  else{audioRecord(input,["assetId","available"]);assetId=soundId(input.assetId);available=input.available;if(typeof available!=="boolean"||!current.assets.some(a=>a.id===assetId))soundFail("Choose a retained sound and its availability.");}
  const data={version:current.version+1,assetId,available,at:new Date(Math.max(now,Date.parse(current.events.at(-1)?.at??"")||0)).toISOString()};current.version=data.version;current.events.push({...data,revision:contentHash(data)});return validateSoundLibrary(current,projectId);
}
