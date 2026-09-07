import {AZURE_STYLES,type AzureStyle} from "../../generator/src/azure-capability";
import {audioNumber,audioRecord,AudioPerformanceError,type AudioControls,type AudioVoiceProfile} from "./audio-performances";
import {audioPhrases,type AudioPhraseDirection} from "./audio-phrases";
import {DEFAULT_VOICE,spokenText,type LineSource} from "./performances";

export function azureControls(input:unknown):AudioControls{
  const v=audioRecord(input,["speed","volume","emotion","style","intensity"]);
  if(v.emotion!=="neutral"||!AZURE_STYLES.includes(v.style as AzureStyle))throw new AudioPerformanceError("Choose an Azure speaking style explicitly; a different provider's emotion cannot be substituted.");
  const intensity=audioNumber(v.intensity,.01,2,"Style intensity");
  if(Math.abs(intensity*100-Math.round(intensity*100))>1e-8||v.style==="neutral"&&intensity!==1)throw new AudioPerformanceError("Use intensity in steps of 0.01 for a speaking style. Neutral uses 1.");
  return {speed:audioNumber(v.speed,.6,1.5,"Speed"),volume:audioNumber(v.volume,.5,2,"Volume"),emotion:"neutral",style:v.style as AzureStyle,intensity};
}
const xml=(text:string)=>text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
const percent=(ratio:number)=>((ratio-1)*100>=0?"+":"")+((ratio-1)*100).toFixed(2)+"%";
export function azureTranscript(source:LineSource,profile:AudioVoiceProfile,phrases:AudioPhraseDirection[]):string{
  const line={source,voice:{...DEFAULT_VOICE,pronunciations:profile.pronunciations},beforeMs:0,afterMs:0,notes:""};
  const chunks:{text:string;phrase?:AudioPhraseDirection}[]=[];let cursor=0;
  for(const p of audioPhrases(source.text,phrases,true)){chunks.push({text:source.text.slice(cursor,p.start)},{text:p.text,phrase:p});cursor=p.end;}chunks.push({text:source.text.slice(cursor)});
  const spoken=chunks.map(c=>spokenText({...line,source:{...source,text:c.text}}));
  if(spoken.join("")!==spokenText(line))throw new AudioPerformanceError("A pronunciation crosses a phrase boundary. Include the entire written phrase in one range.");
  // Sibling prosody scopes avoid ambiguous nested relative rates. The original
  // line's effective controls apply to every undirected chunk.
  const body=chunks.map((c,i)=>{
    const p=c.phrase;let text=xml(spoken[i]!);if(!text)return "";
    if(p?.emphasis)text='<emphasis level="'+p.emphasis+'">'+text+'</emphasis>';
    text='<prosody rate="'+percent(p?.speed??profile.controls.speed)+'" volume="'+percent(profile.controls.volume)+'">'+text+'</prosody>';
    return (p?.pauseBeforeMs?'<break time="'+p.pauseBeforeMs+'ms"/>':"")+text+(p?.pauseAfterMs?'<break time="'+p.pauseAfterMs+'ms"/>':"");
  }).join("");
  const c=azureControls(profile.controls),styled=c.style==="neutral"?body:'<mstts:express-as style="'+c.style+'" styledegree="'+c.intensity+'">'+body+'</mstts:express-as>';
  return '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US"><voice name="'+xml(profile.voice.id)+'">'+styled+'</voice></speak>';
}
