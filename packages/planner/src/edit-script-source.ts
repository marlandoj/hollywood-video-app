import {parseFountain,type SceneBeat} from "../../parser/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {TIERS} from "../../queue/src/index";
import {validateEditSourceReceipt,type EditSourceReceipt} from "./edit-sources";
import {EDIT_SCRIPT_LIMITS,type EditScriptEntry,type EditScriptSourceIndex,type EditScriptWindow} from "./edit-script-types";
import {editFail,type EditLane} from "./edit-timeline";
import {lineSources} from "./performances";
import {renderShots} from "./shot-reuse";
import {planShots} from "./index";
import {soundBaseDialogue,soundBaseFilm} from "./sound-jobs";
import {cutSource} from "./scene-cuts";
import {captionCues} from "./captions";
import {parseEditCaptions} from "./edit-captions";

type DialogueBeat=Extract<SceneBeat,{kind:"dialogue"}>;
interface ShotBinding {id:string;sceneIndex:number;entries:EditScriptEntry[];lines:Map<string,EditScriptEntry>;start:number|null;end:number|null}
const sample48=(sample:number)=>Math.round(sample*48000/22050);

/** Match the parser's protected physical lines; notes cannot impersonate screenplay headings or speech. */
function physicalLines(script:string){
  const raw=script.split(/\r?\n/),protectedLines=new Set<number>();let block=false;
  raw.forEach((line,index)=>{if(block){protectedLines.add(index+1);if(line.includes("*/"))block=false;return;}
    if(line.includes("/*")&&!line.includes("*/")){block=true;protectedLines.add(index+1);}else if(/\[\[[^\]]*\]\]|\/\*[\s\S]*?\*\//.test(line))protectedLines.add(index+1);
  });
  const headings=raw.flatMap((line,index)=>{const value=line.trim();return !protectedLines.has(index+1)&&(/^(INT|EXT|EST|INT\.\/EXT|I\/E)[.\s]/i.test(value)||/^\.(?!\.)/.test(value))?[index+1]:[];});
  return {raw,protectedLines,headings};
}

/** Pure derived navigation. Neither original receipts nor historical render/schema identities are changed. */
export function compileEditScriptSource(input:EditSourceReceipt):EditScriptSourceIndex{
  const receipt=validateEditSourceReceipt(input),{facts,job}=receipt,base=job.soundMix?.source.base??job,film=soundBaseFilm(base),entries:EditScriptEntry[]=[],warnings:string[]=[];
  const finish=(scriptText:string|null,scriptRevision:string|null):EditScriptSourceIndex=>{
    if(entries.length>EDIT_SCRIPT_LIMITS.entriesPerSource)editFail("This source exceeds the screenplay navigation entry limit.");
    const data={schema:"hv-edit-script-source/1" as const,sourceId:facts.id,sourceRevision:facts.revision,receiptRevision:receipt.revision,label:facts.label,language:receipt.language,scriptRevision,scriptText,entries,warnings};
    const result={...data,revision:contentHash(data)};if(new TextEncoder().encode(JSON.stringify(result)).length>EDIT_SCRIPT_LIMITS.responseBytes)editFail("This source exceeds the screenplay navigation response size limit.");return result;
  };
  if(job.graphicOutput){warnings.push("This graphic has no screenplay source or measured speech alignment.");return finish(null,null);}
  const script=film.scriptText,scriptRevision=contentHash({scriptVersion:film.scriptVersion,scriptText:script}),parsed=parseFountain(script),physical=physicalLines(script);
  if(parsed.rejected||parsed.scenes.length!==physical.headings.length)editFail("The retained screenplay cannot be indexed with exact source lines.");
  for(const warning of parsed.warnings)warnings.push(warning.message);
  const scope={sourceId:facts.id,sourceRevision:facts.revision,scriptRevision},scenes=new Map<number,EditScriptEntry>(),beatEntries=new Map<string,EditScriptEntry[]>(),dialogueEntries=new Map<string,EditScriptEntry>(),sceneDialogueEntries=new Map<string,EditScriptEntry>();
  const add=(identity:unknown,value:Omit<EditScriptEntry,"id"|"windows">)=>{
    if(entries.length>=EDIT_SCRIPT_LIMITS.entriesPerSource)editFail("This source exceeds the screenplay navigation entry limit.");
    const entry:EditScriptEntry={id:contentHash({scope,identity}),...value,windows:[]};entries.push(entry);return entry;
  };
  for(const scene of parsed.scenes){
    const line=physical.headings[scene.index]!;scenes.set(scene.index,add({scene:scene.index},{kind:"scene",sceneIndex:scene.index,startLine:line,endLine:line,text:scene.heading}));
    let dialogueIndex=-1,originalLine=0;
    for(const beat of scene.beats??[]){
      if(beat.kind!=="dialogue"){beatEntries.set(beat.id,[add({beatId:beat.id},{kind:beat.kind,sceneIndex:scene.index,startLine:beat.startLine,endLine:beat.endLine,text:beat.text})]);continue;}
      // A transition can split a dialogue block: its continuation beat begins at spoken text, without a new character cue.
      const physicalBeat:number[]=[];for(let n=beat.startLine;n<=beat.endLine;n++)if(!physical.protectedLines.has(n)&&physical.raw[n-1]!.trim())physicalBeat.push(n);
      const hasCue=physicalBeat.length===beat.lines.length+1,lines=hasCue?physicalBeat.slice(1):physicalBeat;
      if(hasCue){dialogueIndex++;originalLine=0;}
      if(lines.length!==beat.lines.length||lines.some((n,index)=>physical.raw[n-1]!.trim()!==beat.lines[index])||scene.dialogue[dialogueIndex]?.character!==beat.character||contentHash(scene.dialogue[dialogueIndex]!.lines.slice(originalLine,originalLine+beat.lines.length))!==contentHash(beat.lines))editFail("A retained dialogue line lost its exact screenplay position.");
      const values:EditScriptEntry[]=[];
      for(const source of lineSources([{character:beat.character,lines:beat.lines}])){
        const n=lines[source.lineIndex]!,entry=add({beatId:beat.id,lineIndex:source.lineIndex},{kind:"dialogue",sceneIndex:scene.index,startLine:n,endLine:n,text:source.text,character:source.character});
        values.push(entry);dialogueEntries.set(beat.id+":"+source.lineIndex,entry);sceneDialogueEntries.set(scene.index+":"+dialogueIndex+":"+(originalLine+source.lineIndex),entry);
      }
      beatEntries.set(beat.id,values);originalLine+=beat.lines.length;
    }
  }
  const at=Date.parse(film.startedAt??film.completedAt??""),declared=renderShots(film,at),records=film.output?.shotRenders??[],standard=planShots(parsed,7000,TIERS[film.tier].maxShots),bindings=new Map<string,ShotBinding>();
  const fullOrder=records.length===declared.length&&new Set(records.map(record=>record.shotId)).size===records.length&&records.every((record,index)=>record.shotId===declared[index]!.id);
  const durations=records.map(record=>Math.round(record.clip.durationSec*30));
  const overlap=film.stage==="final"&&!records.some(record=>record.clip.speech)?15:0;
  const expectedFrames=durations.reduce((n,count)=>n+count,0)-overlap*Math.max(0,records.length-1);
  const aligned=fullOrder&&durations.every((count,index)=>count>overlap&&Math.abs(count/30-records[index]!.clip.durationSec)<1e-6)&&expectedFrames===facts.frames;
  if(!aligned)warnings.push("Retained shot order or assembly duration does not establish exact source positions; shot coverage and shot-relative speech remain unbound.");
  let cursor=0;
  for(const shot of declared){
    const scene=parsed.scenes[shot.sceneIndex]!,cut=film.direction?.sceneCuts?.find(value=>value.source.sceneIndex===scene.index&&value.sourceHash===contentHash(cutSource(scene))),accepted=cut?.shots.find(value=>value.id===shot.id);
    const dialogueBeats=(scene.beats??[]).filter((beat):beat is DialogueBeat=>beat.kind==="dialogue");let selected:SceneBeat[]=[];
    if(accepted)selected=accepted.beatIds.map(id=>scene.beats!.find(beat=>beat.id===id)!);
    else if(!cut){
      const group=standard.filter(value=>value.sceneIndex===scene.index),index=group.findIndex(value=>value.id===shot.id),actions=(scene.beats??[]).filter(beat=>beat.kind==="action");
      if(index>=0){const count=Math.floor(actions.length/group.length),extra=actions.length%group.length,start=index*count+Math.min(index,extra);selected=actions.slice(start,start+count+(index<extra?1:0));if(index===0)selected.push(...dialogueBeats);}
    }
    const lines=new Map<string,EditScriptEntry>(),chosen=selected.filter((beat):beat is DialogueBeat=>beat.kind==="dialogue"),sources=lineSources(shot.dialogue);
    // Coverage reindexes dialogue within a shot. Bind its exact local source identity back to the accepted beat identity.
    for(const source of sources){const beat=chosen[source.dialogueIndex],entry=cut?beat&&dialogueEntries.get(beat.id+":"+source.lineIndex):sceneDialogueEntries.get(scene.index+":"+source.dialogueIndex+":"+source.lineIndex);if(entry&&entry.text===source.text&&entry.character===source.character)lines.set(source.hash,entry);}
    const index=records.findIndex(record=>record.shotId===shot.id),frames=durations[index]??0;
    bindings.set(shot.id,{id:shot.id,sceneIndex:scene.index,entries:[scenes.get(scene.index)!,...selected.flatMap(beat=>beatEntries.get(beat.id)??[])],lines,start:aligned?cursor*1600:null,end:aligned?(cursor+frames)*1600:null});
    if(aligned)cursor+=frames-overlap;
  }
  let windowCount=0;
  const window=(entry:EditScriptEntry,startSample:number,endSample:number,lanes:EditLane[],evidence:EditScriptWindow["evidence"],shotId?:string)=>{
    if(!Number.isSafeInteger(startSample)||!Number.isSafeInteger(endSample)||startSample<0||endSample<=startSample||endSample>facts.frames*1600||!lanes.length)return false;
    if(++windowCount>EDIT_SCRIPT_LIMITS.occurrences)editFail("This source exceeds the screenplay navigation window limit.");
    entry.windows.push({startSample,endSample,lanes:[...new Set(lanes)],evidence,...(shotId?{shotId}:{})});return true;
  };
  for(const binding of bindings.values())if(binding.start!==null&&binding.end!==null)for(const entry of binding.entries)window(entry,binding.start,binding.end,["picture"],"shot-coverage",binding.id);
  const measured=(entry:EditScriptEntry|undefined,start:number,end:number,lane:"dialogue"|"narration",text:string,shotId?:string)=>{
    if(!entry)return false;const lanes:EditLane[]=["picture",...(["mix",lane] as const).filter(value=>facts.audio.includes(value))];
    if(!window(entry,start,end,lanes,"measured-speech",shotId))return false;entry.performedText=text;return true;
  };
  const dialogue=soundBaseDialogue(base),narrationEntries=new Map<string,EditScriptEntry>();
  if(dialogue){
    for(const line of dialogue.lines){const entry=bindings.get(line.shotId)?.lines.get(line.source.hash);if(entry)entry.performedText=line.spokenText;}
    for(const cue of dialogue.narration?.track.cues??[]){const read=cue.audition.take.line;narrationEntries.set(cue.id,add({narrationCueId:cue.id},{kind:"narration",sceneIndex:cue.audition.take.sceneIndex,startLine:null,endLine:null,text:read.source.text,character:read.source.character,performedText:read.spokenText,unavailableReason:"The retained narration has no aligned measured speech window."}));}
    if(dialogue.totalFrames!==facts.frames)warnings.push("The retained dialogue report does not match the measured source duration; speech alignment is unavailable.");
    else{
      for(const line of dialogue.lines){const entry=bindings.get(line.shotId)?.lines.get(line.source.hash),conversion=line.audition?.conversion;
        if(!measured(entry,sample48(line.startSample+(conversion?.speechStartSample??0)),sample48(conversion?line.startSample+conversion.speechEndSample:line.endSample),"dialogue",line.spokenText,line.shotId))warnings.push("A retained performed line cannot be bound to its exact screenplay source and measured window.");
      }
      for(const cue of dialogue.narration?.track.cues??[]){const conversion=dialogue.narration!.conversions.find(value=>value.cueId===cue.id)?.report,read=cue.audition.take.line;
        const entry=narrationEntries.get(cue.id)!;
        if(conversion&&measured(entry,sample48(cue.startSample+conversion.speechStartSample),sample48(cue.startSample+conversion.speechEndSample),"narration",read.spokenText))delete entry.unavailableReason;
      }
    }
  }else{
    for(const record of records){const binding=bindings.get(record.shotId);for(const line of record.clip.speech?.lines??[]){const entry=binding?.lines.get(line.source.hash);if(entry)entry.performedText=line.spokenText;
      if(binding?.start===null||binding?.start===undefined||!measured(entry,binding.start+sample48(line.startSample),binding.start+sample48(line.endSample),"dialogue",line.spokenText,record.shotId))warnings.push("A retained spoken line has no verified source-frame alignment.");
    }}
  }
  // Reproduce the exact ordered caption writer before attaching cue identities; no text search or fuzzy matching.
  if(facts.captions.length){
    const cues:{startMs:number;endMs:number;text:string;entry?:EditScriptEntry;shotId?:string}[]=[];
    if(dialogue&&dialogue.totalFrames===facts.frames){
      const reads:{start:number;end:number;character:string;text:string;entry:EditScriptEntry|undefined;shotId?:string}[]=dialogue.lines.map(line=>({start:line.startSample,end:line.endSample,character:line.source.character,text:line.text,entry:bindings.get(line.shotId)?.lines.get(line.source.hash),shotId:line.shotId}));
      for(const cue of dialogue.narration?.track.cues??[]){const conversion=dialogue.narration!.conversions.find(value=>value.cueId===cue.id)!.report;reads.push({start:cue.startSample+conversion.speechStartSample,end:cue.startSample+conversion.speechEndSample,character:cue.audition.take.line.source.character+" ("+cue.role+")",text:cue.audition.take.line.localization?.text??cue.audition.take.narration!.text,entry:narrationEntries.get(cue.id)});}
      const ordered=reads.sort((a,b)=>a.start-b.start||a.end-b.end).flatMap(read=>captionCues([{character:read.character,lines:[read.text]}],(read.end-read.start)/22050).map(cue=>({start:read.start+Math.round(cue.startSec*22050),end:read.start+Math.round(cue.endSec*22050),text:cue.text,entry:read.entry,shotId:read.shotId}))).sort((a,b)=>a.start-b.start||a.end-b.end);
      cues.push(...ordered.map(cue=>({...cue,startMs:Math.round(cue.start*1000/22050),endMs:Math.round(cue.end*1000/22050)})));
    }else if(!dialogue&&aligned){
      let time=0;
      for(const [index,record]of records.entries()){
        const binding=bindings.get(record.shotId)!;
        if(record.clip.speech)for(const line of record.clip.speech.lines)for(const cue of captionCues([{character:line.source.character,lines:[line.source.text]}],(line.endSample-line.startSample)/22050))cues.push({startMs:Math.max(0,Math.round((time+(cue.startSec+line.startSample/22050))*1000)),endMs:Math.max(0,Math.round((time+(cue.endSec+line.startSample/22050))*1000)),text:cue.text,entry:binding.lines.get(line.source.hash),shotId:record.shotId});
        else for(const cue of captionCues(declared[index]!.dialogue,record.clip.durationSec))cues.push({startMs:Math.max(0,Math.round((time+cue.startSec)*1000)),endMs:Math.max(0,Math.round((time+cue.endSec)*1000)),text:cue.text});
        time+=record.clip.durationSec-overlap/30;
      }
      if(!cues.length)cues.push({startMs:0,endMs:1000,text:"[no dialogue]"});
    }
    const stamp=(ms:number)=>[Math.floor(ms/3600000),Math.floor(ms/60000)%60,Math.floor(ms/1000)%60].map(value=>String(value).padStart(2,"0")).join(":")+"."+String(ms%1000).padStart(3,"0");
    let matching=false;
    try{const expected=parseEditCaptions("WEBVTT\n\n"+cues.map(cue=>stamp(cue.startMs)+" --> "+stamp(cue.endMs)+"\n"+cue.text+"\n").join("\n"),facts.frames);matching=contentHash(expected)===contentHash(facts.captions);}catch{/* Unsupported historical caption writers stay explicitly unbound. */}
    if(matching){for(const [index,cue]of cues.entries())if(cue.entry){const caption=facts.captions[index]!;window(cue.entry,caption.start,caption.end,["captions"],"measured-speech",cue.shotId);}if(cues.some(cue=>!cue.entry&&cue.text!=="[no dialogue]"))warnings.push("Caption cues without an individual measured line identity remain unbound.");}
    else warnings.push("The retained caption cues do not match the ordered measured caption recipe; caption-lane navigation remains unbound.");
  }
  for(const entry of entries){
    entry.windows.sort((a,b)=>a.startSample-b.startSample||a.endSample-b.endSample||a.evidence.localeCompare(b.evidence)||String(a.shotId??"").localeCompare(String(b.shotId??"")));
    if(entry.kind==="dialogue"&&!entry.windows.some(value=>value.evidence==="measured-speech"))entry.unavailableReason="No measured speech timing is retained for this screenplay line; any picture window is shot coverage only.";
    else if(!entry.windows.length&&!entry.unavailableReason)entry.unavailableReason=entry.kind==="transition"?"This screenplay transition has no separately timed retained shot.":"No exact retained shot coverage is available for this screenplay entry.";
  }
  warnings.splice(0,warnings.length,...new Set(warnings));return finish(script,scriptRevision);
}
