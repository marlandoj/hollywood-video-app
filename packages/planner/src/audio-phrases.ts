import {audioNumber,audioRecord,audioText,AudioPerformanceError,type AudioControls} from "./audio-performances";
import {spokenText,type PerformanceLine} from "./performances";

export interface AudioPhraseDirection {start:number;end:number;text:string;speed?:number;volume?:number;pauseBeforeMs?:number;pauseAfterMs?:number;emphasis?:"reduced"|"none"|"moderate"|"strong"}
export function phraseTokens(source:string):{start:number;end:number;text:string}[]{
  audioText(source,20000,"phrase source");return [...source.matchAll(/\S+/gu)].map(m=>({start:m.index!,end:m.index!+m[0].length,text:m[0]}));
}
/** Offsets address the original source, never a provider-normalized transcript. */
export function audioPhrases(source:string,input:unknown,native=false):AudioPhraseDirection[]{
  if(!Array.isArray(input)||input.length>16)throw new AudioPerformanceError("Use up to 16 non-overlapping phrase directions per line.");
  const tokens=phraseTokens(source),starts=new Set(tokens.map(t=>t.start)),ends=new Set(tokens.map(t=>t.end));
  const phrases=input.map(item=>{
    const v=audioRecord(item,["start","end","text","speed","volume","pauseBeforeMs","pauseAfterMs",...(native?["emphasis"]:[])]),start=audioNumber(v.start,0,source.length-1,"Phrase start",true),end=audioNumber(v.end,start+1,source.length,"Phrase end",true),text=audioText(v.text,20000,"phrase");
    if(!starts.has(start)||!ends.has(end)||source.slice(start,end)!==text)throw new AudioPerformanceError("Choose whole source words and review the exact phrase again.");
    const phrase:AudioPhraseDirection={start,end,text};
    if(native&&v.volume!==undefined)throw new AudioPerformanceError("Use line volume for this voice; phrase volume is not supported.");
    if(v.emphasis!==undefined){if(!["reduced","none","moderate","strong"].includes(v.emphasis as string))throw new AudioPerformanceError("Choose a supported word emphasis level.");phrase.emphasis=v.emphasis as AudioPhraseDirection["emphasis"];}
    if(v.speed!==undefined)phrase.speed=audioNumber(v.speed,.6,1.5,"Phrase speed");if(v.volume!==undefined)phrase.volume=audioNumber(v.volume,.5,2,"Phrase volume");
    for(const key of ["pauseBeforeMs","pauseAfterMs"] as const)if(v[key]!==undefined){const n=audioNumber(v[key],0,3000,"Requested phrase pause",true);if(n)phrase[key]=n;}
    if(Object.keys(phrase).length===3)throw new AudioPerformanceError("Set a phrase speed, volume or pause, or remove the phrase direction.");return phrase;
  }).sort((a,b)=>a.start-b.start);
  if(phrases.some((p,i)=>i>0&&p.start<phrases[i-1]!.end))throw new AudioPerformanceError("Phrase directions cannot overlap. Edit the existing phrase or choose another range.");
  if(phrases.some((p,i)=>i>0&&/^\s*$/.test(source.slice(phrases[i-1]!.end,p.start))&&p.pauseBeforeMs&&phrases[i-1]!.pauseAfterMs))throw new AudioPerformanceError("Use one requested pause between neighboring directed phrases.");
  return phrases;
}
/** Only generated, bounded tags enter the wire transcript. No raw markup input. */
export function phraseTranscript(line:PerformanceLine,controls:AudioControls,phrases:AudioPhraseDirection[]):string{
  const chunks:{text:string;phrase?:AudioPhraseDirection}[]=[];let cursor=0;
  for(const phrase of audioPhrases(line.source.text,phrases)){chunks.push({text:line.source.text.slice(cursor,phrase.start)},{text:phrase.text,phrase});cursor=phrase.end;}chunks.push({text:line.source.text.slice(cursor)});
  const spoken=chunks.map(c=>spokenText({...line,source:{...line.source,text:c.text}}));
  if(spoken.join("")!==spokenText(line))throw new AudioPerformanceError("A pronunciation replacement crosses a phrase boundary. Include the entire written phrase in one range or revise its pronunciation.");
  return chunks.map((chunk,i)=>{
    const p=chunk.phrase;if(!p)return spoken[i];
    const before=p.pauseBeforeMs?'<break time="'+p.pauseBeforeMs+'ms"/>':"",after=p.pauseAfterMs?'<break time="'+p.pauseAfterMs+'ms"/>':"";
    const open=(p.speed!==undefined?'<speed ratio="'+p.speed+'"/>':"")+(p.volume!==undefined?'<volume ratio="'+p.volume+'"/>':"");
    const reset=(p.speed!==undefined?'<speed ratio="'+controls.speed+'"/>':"")+(p.volume!==undefined?'<volume ratio="'+controls.volume+'"/>':"");
    return before+open+spoken[i]+reset+after;
  }).join("");
}
