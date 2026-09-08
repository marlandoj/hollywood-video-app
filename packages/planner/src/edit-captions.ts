import {contentHash} from "../../generator/src/capabilities";
import {editFail,editNumber,EDIT_MAX_FRAMES,type EditCaption} from "./edit-timeline";

/** Retained studio exports use plain WebVTT cues. Refuse unsupported styling/regions instead of losing them. */
export function parseEditCaptions(vtt:string,frames:number):EditCaption[]{
  editNumber(frames,1,EDIT_MAX_FRAMES,"Caption source frames");
  // VTT writers round cue ends up to a whole millisecond; retained timing stays frame-exact.
  const sourceEnd=frames*1600,maximumEnd=Math.ceil(sourceEnd/48)*48;
  if(typeof vtt!=="string"||vtt.length>8*1024**2)editFail("The retained caption file is too large.");const normalized=vtt.replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n");if(!normalized.startsWith("WEBVTT\n\n"))editFail("Choose a plain retained WebVTT caption track.");
  const cues:EditCaption[]=[];for(const block of normalized.slice(8).trim().split(/\n{2,}/).filter(Boolean)){
    const lines=block.split("\n"),index=lines[0]!.includes(" --> ")?0:1,match=/^(\d{2,}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2,}):(\d{2}):(\d{2})\.(\d{3})$/.exec(lines[index]??"");
    if(!match||index===1&&/^(STYLE|REGION|NOTE)(\s|$)/.test(lines[0]!))editFail("Retain plain caption cues before editing this styled or malformed track.");
    const time=(offset:number)=>{const h=Number(match[offset]),m=Number(match[offset+1]),s=Number(match[offset+2]),ms=Number(match[offset+3]);if(m>59||s>59)editFail("A caption timestamp is invalid.");return ((h*3600+m*60+s)*1000+ms)*48;},start=time(1),rawEnd=time(5),end=Math.min(rawEnd,sourceEnd),rawText=lines.slice(index+1).join("\n");
    // The longest supported entity, &nbsp;, needs six raw characters for one decoded character.
    if(start<0||start>=end||rawEnd>maximumEnd||!rawText.trim()||rawText.length>6*4000||/[<>]/.test(rawText))editFail("The retained caption text or timing cannot be edited losslessly.");
    const text=rawText.replace(/&(amp|lt|gt|lrm|rlm|nbsp);/g,(_all,name:string)=>({amp:"&",lt:"<",gt:">",lrm:"\u200e",rlm:"\u200f",nbsp:"\u00a0"}[name]!));if(!text.trim()||text.length>4000)editFail("Retain nonblank caption text in 4000 decoded characters or fewer.");cues.push({id:"caption-"+contentHash({index:cues.length,identifier:index?lines[0]:null,start,end,text}),start,end,text});
  }
  if(cues.length>4096)editFail("Use up to 4096 retained caption cues.");return cues;
}
