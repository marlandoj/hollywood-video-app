export interface SpeechWindowReport {sampleRate:number;totalSamples:number}
export interface SpeechWindow {startSample:number;endSample:number;pcmSha256:string}
export type SpeechPlaybackState="loading"|"playing"|"stopped"|"finished"|"unavailable";
export function fetchSpeechLine(url:string,report:SpeechWindowReport,line:SpeechWindow,signal?:AbortSignal,fetcher?:(url:string,options:RequestInit)=>Promise<Response>):Promise<Uint8Array>;
export function speechLineBuffer(context:AudioContext,pcm:Uint8Array,sampleRate:number):AudioBuffer;
export function createSpeechPlayer(options?:{createContext?:()=>AudioContext;load?:typeof fetchSpeechLine}):{
  stop():void;
  play(request:{url:string;report:SpeechWindowReport;line:SpeechWindow;onState:(state:SpeechPlaybackState)=>void}):Promise<void>;
};
