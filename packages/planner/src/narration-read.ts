import {contentHash} from "../../generator/src/capabilities";
import {gateOrThrow} from "../../safety/src/index";
import {audioRecord,audioText,AudioPerformanceError} from "./audio-performances";
import {lineSources,type LineSource} from "./performances";

/** Narration has its own reviewed text; it never impersonates a screenplay line. */
export interface NarrationRead {schema:"hv-narration-read/1";text:string;review:"owner-reviewed";revision:string}
export function narrationRead(input:unknown):NarrationRead {
  const value=audioRecord(input,["text","reviewed"]),text=audioText(value.text,20000,"Narration text").trim();
  if(value.reviewed!==true||!text||/[<>[\]]/.test(text)||/^\([^\r\n]*\)$/.test(text))throw new AudioPerformanceError("Review non-empty plain narration text before auditioning it.");
  gateOrThrow(text);const data={schema:"hv-narration-read/1" as const,text,review:"owner-reviewed" as const};return {...data,revision:contentHash(data)};
}
export function validateNarrationRead(value:NarrationRead):NarrationRead {
  audioRecord(value,["schema","text","review","revision"]);const valid=narrationRead({text:value.text,reviewed:value.review==="owner-reviewed"});
  if(contentHash(valid)!==contentHash(value))throw new AudioPerformanceError("The reviewed narration text changed.");return valid;
}
export function narrationLineSource(value:NarrationRead,character:string):LineSource {
  return lineSources([{character,lines:[validateNarrationRead(value).text]}])[0]!;
}
