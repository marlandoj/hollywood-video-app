/**
 * HV-023-04: independent readers for the interchange files, written for the tests. They share no
 * code with the writers in packages/planner/src/edit-interchange.ts: each parses the file as a
 * finishing tool would and reports the shots, frames and dissolves it finds.
 */

/** A shot as the CMX 3600 model records it: its event starts where any dissolve into it starts. */
export interface ReadEvent {jobId:string;sourceIn:number;sourceOut:number;recordIn:number;recordOut:number;dissolve:number|null}
/** A clip as OpenTimelineIO records it: the hard cut, with the dissolve's offsets beside it. */
export interface ReadClip {name:string;jobId:string;clipId:string;sourceIn:number;sourceOut:number;recordIn:number;recordOut:number;dissolveIn:{before:number;after:number}|null}
export interface ReadTrack {name:string;kind:string;frames:number;clips:ReadClip[]}

const JOB=/^urn:hv:job:([A-Za-z0-9_-]{1,128})$/;
function fail(message:string):never{throw new Error(message);}

export function frames(timecode:string,fps=30):number{
  const m=/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/.exec(timecode);if(!m)fail("Not a non-drop timecode: "+timecode);
  const [h,mi,s,f]=m.slice(1).map(Number) as [number,number,number,number];if(mi>59||s>59||f>=fps)fail("Timecode out of range: "+timecode);return ((h*60+mi)*60+s)*fps+f;
}

export function readOtio(text:string):{name:string;startFrame:number;tracks:ReadTrack[];markers:{name:string;frame:number}[];metadata:Record<string,unknown>}{
  const timeline=JSON.parse(text);
  const rt=(value:any)=>{if(value?.OTIO_SCHEMA!=="RationalTime.1"||value.rate!==30||!Number.isInteger(value.value))fail("Expected a RationalTime.1 at 30 fps.");return value.value as number;};
  const tr=(value:any)=>{if(value?.OTIO_SCHEMA!=="TimeRange.1")fail("Expected a TimeRange.1.");return {start:rt(value.start_time),duration:rt(value.duration)};};
  if(timeline.OTIO_SCHEMA!=="Timeline.1"||timeline.tracks?.OTIO_SCHEMA!=="Stack.1")fail("Expected Timeline.1 holding a Stack.1.");
  const tracks:ReadTrack[]=timeline.tracks.children.map((track:any)=>{
    if(track.OTIO_SCHEMA!=="Track.1")fail("Expected Track.1.");let position=0,pending:{before:number;after:number}|null=null;const clips:ReadClip[]=[];
    for(const item of track.children){
      if(item.OTIO_SCHEMA==="Gap.1"){if(pending)fail("A transition must sit between two clips.");position+=tr(item.source_range).duration;continue;}
      if(item.OTIO_SCHEMA==="Transition.1"){if(pending||!clips.length||clips.at(-1)!.recordOut!==position)fail("A transition must follow a clip.");pending={before:rt(item.in_offset),after:rt(item.out_offset)};continue;}
      if(item.OTIO_SCHEMA!=="Clip.1"||item.media_reference?.OTIO_SCHEMA!=="ExternalReference.1")fail("Expected Clip.1 with an ExternalReference.1.");
      const job=JOB.exec(item.media_reference.target_url);if(!job)fail("Media must be named by a studio job id.");
      const source=tr(item.source_range),available=tr(item.media_reference.available_range);if(source.start<available.start||source.start+source.duration>available.start+available.duration)fail("A clip reaches beyond its media.");
      if(pending&&(pending.before>clips.at(-1)!.recordOut-clips.at(-1)!.recordIn||pending.after>source.duration))fail("A transition is longer than its clips.");
      clips.push({name:item.name,jobId:job[1]!,clipId:item.metadata?.hv?.clipId,sourceIn:source.start,sourceOut:source.start+source.duration,recordIn:position,recordOut:position+source.duration,dissolveIn:pending});pending=null;position+=source.duration;
    }
    if(pending)fail("A transition must precede a clip.");return {name:track.name,kind:track.kind,frames:position,clips};
  });
  return {name:timeline.name,startFrame:rt(timeline.global_start_time),tracks,markers:timeline.tracks.markers.map((m:any)=>({name:m.name,frame:tr(m.marked_range).start})),metadata:timeline.metadata};
}

/** Reads CMX 3600: title, FCM, events with cuts and dissolves, and each event's source comment. */
export function readEdl(text:string,recordStart=108000):{title:string;fcm:string;events:ReadEvent[];names:string[]}{
  const lines=text.split(/\r?\n/),title=/^TITLE: (.*)$/.exec(lines[0]??"")?.[1],fcm=/^FCM: (.*)$/.exec(lines[1]??"")?.[1];if(title===undefined||fcm===undefined)fail("Expected TITLE and FCM headers.");
  const EVENT=/^(\d{3})\s+(\S{1,8})\s+V\s+(C|D)(?:\s+(\d{3}))?\s+(\d\d:\d\d:\d\d:\d\d) (\d\d:\d\d:\d\d:\d\d) (\d\d:\d\d:\d\d:\d\d) (\d\d:\d\d:\d\d:\d\d)$/;
  const raw:{n:string;reel:string;kind:string;dissolve:number|null;s:[number,number];r:[number,number];file?:string;name?:string}[]=[];
  for(const line of lines.slice(2)){
    if(!line.trim())continue;const m=EVENT.exec(line);
    if(m){const [,n,reel,kind,duration,a,b,c,d]=m as unknown as string[];if(kind==="D"&&!duration)fail("A dissolve needs a duration.");raw.push({n:n!,reel:reel!,kind:kind!,dissolve:duration?Number(duration):null,s:[frames(a!),frames(b!)],r:[frames(c!)-recordStart,frames(d!)-recordStart]});continue;}
    const file=/^\* SOURCE FILE: (.*)$/.exec(line),name=/^\* (?:FROM|TO) CLIP NAME: (.*)$/.exec(line);
    if(!raw.length||!file&&!name)fail("Unexpected EDL line: "+line);if(file)raw.at(-1)!.file=file[1];if(name)raw.at(-1)!.name=name[1];
  }
  const reels=new Map<string,string>(),events:ReadEvent[]=[];
  raw.forEach((e,i)=>{
    if(e.s[1]-e.s[0]!==e.r[1]-e.r[0])fail("Event "+e.n+" changes speed.");
    if(e.file){const job=JOB.exec(e.file);if(!job)fail("Media must be named by a studio job id.");if(reels.has(e.reel)&&reels.get(e.reel)!==job[1])fail("Reel "+e.reel+" names two jobs.");reels.set(e.reel,job[1]!);}
    if(e.kind==="D"){const from=raw[i-1];if(!from||from.n!==e.n||from.kind!=="C"||from.r[0]!==from.r[1]||from.r[0]!==e.r[0])fail("A dissolve must follow its zero-length outgoing cut.");
      const outgoing=events.at(-1);if(!outgoing||outgoing.recordOut!==e.r[0]||outgoing.sourceOut!==from.s[0]||reels.get(from.reel)!==outgoing.jobId)fail("The outgoing cut of event "+e.n+" does not continue the previous event.");}
    if(e.kind==="C"&&raw[i+1]?.n===e.n)return;
    const jobId=reels.get(e.reel);if(!jobId)fail("Reel "+e.reel+" names no job.");
    events.push({jobId,sourceIn:e.s[0],sourceOut:e.s[1],recordIn:e.r[0],recordOut:e.r[1],dissolve:e.dissolve});
  });
  return {title,fcm,events,names:raw.map(e=>e.name??"")};
}

/** OpenTimelineIO hard cuts in CMX terms: each shot starts where any dissolve into it starts. */
export function otioAsEvents(track:ReadTrack):ReadEvent[]{
  return track.clips.map((c,i)=>{const before=c.dissolveIn?.before??0,tail=track.clips[i+1]?.dissolveIn?.before??0;return {jobId:c.jobId,sourceIn:c.sourceIn-before,sourceOut:c.sourceOut-tail,recordIn:c.recordIn-before,recordOut:c.recordOut-tail,dissolve:c.dissolveIn?c.dissolveIn.before+c.dissolveIn.after:null};});
}
