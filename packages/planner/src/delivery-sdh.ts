import {contentHash} from "../../generator/src/capabilities";
import {EditTime} from "./edit-time";
import {editRenderClips} from "./edit-transition-render";
import {validateEditTimeline,type EditTimeline} from "./edit-timeline";
import {EditAssemblyClock,validateEditAssemblyPlan} from "./edit-assembly-clock";
import type {EditAssemblyPlan} from "./edit-assembly-types";
import type {EditSourceBinding} from "./edit-jobs";
import type {DeliveryCaptionTrack} from "./delivery-captions";

/**
 * HV-027-16: captions for the deaf and hard of hearing, as a track in the film's own master.
 *
 * SDH is the film's captions plus what a hearing viewer gets from the soundtrack and a caption
 * reader does not: who is speaking, and the sounds that carry the story. The rule this module keeps
 * is that **every word of it is something the pipeline already knows**. Nothing is transcribed,
 * recognised, guessed or described by a model:
 *
 * - **Dialogue and its speaker** are the film's own sealed captions, cue for cue. The captions
 *   already open each speech with the speaker's name as the screenplay gives it (`SPUD: ...`), so
 *   speaker identification is carried, not added.
 * - **Sounds** are the sound-mix cues the cut actually plays: a cue of a recording the creator placed
 *   in a reviewed sound session, on a stem or a mix the timeline puts in the film, at a level above
 *   the floor, for exactly the stretch of it the cut keeps. It is described by the recording's own
 *   label and its role -- `[music: Garden theme]`, `[ambience: Rain]`, `[Door slam]` -- because the
 *   label is the only description of that sound the studio holds.
 *
 * A sound that is in a picture's own native audio, and was never a sound-mix cue, is not described,
 * because nothing names it. That is a smaller SDH track than a human captioner would write, and it
 * is stated rather than implied.
 */
export const DELIVERY_SDH_RECIPE=Object.freeze({
  schema:"hv-delivery-sdh/1",
  container:"the master's own MP4, its picture and sound stream-copied, with one mov_text subtitle track marked hearing-impaired and captions",
  dialogue:"the film's sealed caption cues, word for word, speaker names as the captions carry them",
  sounds:"sound-mix cues the cut plays above -60 dB on a mix or their own stem, labelled [music: label], [ambience: label] or [label] from the recording's own label",
  overlap:"MP4 timed text shows one sample at a time, so overlapping cues are cut into segments that show every active cue, one per line, in order of starting",
  proof:"the track is read back out of the delivered file and must equal what was written, segment for segment; the picture and sound streams must hash as the master's own",
  limits:Object.freeze({soundCues:1024,labelCharacters:120,floorDb:-60}),
} as const);
export const SDH_SOUND_ROLES=["music","ambience","effects"] as const;
export type SdhSoundRole=typeof SDH_SOUND_ROLES[number];
/** One placed sound, in the delivered film's own 48 kHz output samples. */
export interface DeliverySoundCue {start:number;end:number;role:SdhSoundRole;label:string}
const SAMPLES=1600;
const fail:(message:string)=>never=message=>{throw new Error(message);};
const SOUND_LANES=new Set(["mix",...SDH_SOUND_ROLES]);
/** A label is the creator's own text; only its whitespace is folded, so it reads on one line. */
const oneLine=(label:string)=>label.replace(/\s+/g," ").trim();
function merged(cues:DeliverySoundCue[]):DeliverySoundCue[]{
  // The same recording heard through a mix clip and its own stem, or across a split, is one sound.
  const sorted=cues.slice().sort((a,b)=>a.role.localeCompare(b.role)||a.label.localeCompare(b.label)||a.start-b.start||a.end-b.end),result:DeliverySoundCue[]=[];
  for(const cue of sorted){const last=result.at(-1);
    if(last&&last.role===cue.role&&last.label===cue.label&&cue.start<=last.end)last.end=Math.max(last.end,cue.end);else result.push({...cue});}
  return result.sort((a,b)=>a.start-b.start||a.end-b.end||a.role.localeCompare(b.role)||a.label.localeCompare(b.label));
}
/**
 * The sound-mix cues a picture edit plays, placed on its output clock.
 *
 * A cue is heard through a clip on the mix lane (the whole mix of that sound session) or on the
 * cue's own stem, and only for the stretch of it the clip keeps. The clock is the one the captions
 * use -- a plain clip is shifted by its placement, a retimed one mapped through its own timing -- so
 * a sound and a line of dialogue that were together in the source are together in the film.
 */
export function editSoundCues(timeline:EditTimeline,bindings:EditSourceBinding[]):DeliverySoundCue[]{
  const t=validateEditTimeline(timeline),found:DeliverySoundCue[]=[],floor=DELIVERY_SDH_RECIPE.limits.floorDb;
  for(const clip of editRenderClips(t)){
    if(!SOUND_LANES.has(clip.lane)||clip.gainDb<=floor)continue;
    const session=bindings.find(binding=>binding.source.facts.id===clip.sourceId)?.source.job?.soundMix?.session;
    if(!session)continue;
    const time=new EditTime(clip),begin=time.source(clip.at*SAMPLES),end=time.source((clip.at+clip.frames)*SAMPLES);
    for(const cue of session.cues){
      if((clip.lane!=="mix"&&clip.lane!==cue.role)||cue.gainDb<=floor)continue;
      const from=Math.max(begin,cue.start),to=Math.min(end,cue.start+cue.frames);
      if(from>=to)continue;
      const shift=(clip.at-clip.from)*SAMPLES;
      const start=clip.timing?time.boundary(from):from+shift,stop=clip.timing?time.boundary(to):to+shift;
      if(start<stop)found.push({start,end:stop,role:cue.role,label:oneLine(cue.asset.label)});
    }
  }
  return merged(found);
}
/** The same, for an assembly: the parent's sounds, through the ranges the assembly keeps. */
export function editAssemblySoundCues(input:EditAssemblyPlan,bindings:EditSourceBinding[]):DeliverySoundCue[]{
  const plan=validateEditAssemblyPlan(input),clock=new EditAssemblyClock(plan),found:DeliverySoundCue[]=[];
  for(const cue of editSoundCues(plan.parent.timeline,bindings))for(const span of clock.occurrences(cue.start,cue.end))
    found.push({start:span.outputStartSample,end:span.outputStartSample+span.samples,role:cue.role,label:cue.label});
  return merged(found);
}
/** A binding's sound list is re-checked rather than trusted: in order, inside the film, labelled. */
export function validateDeliverySoundCues(cues:DeliverySoundCue[],frames:number):DeliverySoundCue[]{
  const limits=DELIVERY_SDH_RECIPE.limits;
  if(!Array.isArray(cues)||cues.length>limits.soundCues)fail("A deliverable names at most "+limits.soundCues+" sound cues.");
  let previous:DeliverySoundCue|undefined;
  return cues.map(cue=>{
    if(!cue||typeof cue!=="object"||Object.keys(cue).some(key=>!["start","end","role","label"].includes(key)))fail("Describe each sound cue by its time, role and label.");
    const {start,end,role,label}=cue;
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>frames*SAMPLES)fail("A sound cue lies inside the film it is heard in.");
    if(!SDH_SOUND_ROLES.includes(role))fail("A sound cue is music, ambience or effects.");
    if(typeof label!=="string"||!label||label!==oneLine(label)||label.length>limits.labelCharacters||[...label].some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))
      fail("A sound cue carries its recording's own one-line label.");
    if(previous&&(start<previous.start||start===previous.start&&end<previous.end))fail("A deliverable's sound cues are in the order they are heard.");
    previous=cue;
    return {start,end,role,label};
  });
}
/** How a sound reads in the track. The label is the creator's; the brackets and the role are the convention. */
export function sdhSoundText(cue:Pick<DeliverySoundCue,"role"|"label">):string{
  return cue.role==="effects"?"["+cue.label+"]":"["+cue.role+": "+cue.label+"]";
}
export interface DeliverySdhPlan {
  schema:"hv-delivery-sdh/1";captions:DeliveryCaptionTrack;
  /** The sounds, in the track's own milliseconds (start floored, end ceiled, as the captions are). */
  sounds:{startMs:number;endMs:number;text:string}[];
  output:{width:number;height:number};
  revision:string;
}
export function deliverySdhPlan(captions:DeliveryCaptionTrack|undefined,sounds:DeliverySoundCue[]|undefined,output:{width:number;height:number},frames:number):DeliverySdhPlan{
  if(!captions||typeof captions!=="object")fail("This film's sealed caption track could not be tied to its cut, so no SDH track can be made from it.");
  if(!Array.isArray(sounds))fail("This film's sound cues were not read when it was bound, so no SDH track can be made from it. Ask again for its deliverables.");
  const checked=validateDeliverySoundCues(sounds,frames);
  if(!Number.isInteger(captions.cues)||captions.cues<0)fail("Count the film's caption cues.");
  if(!captions.cues&&!checked.length)fail("This film has nothing to caption for the deaf and hard of hearing: no spoken line and no placed sound.");
  if(!output||!Number.isInteger(output.width)||!Number.isInteger(output.height)||output.width<2||output.height<2)fail("Name the master's frame.");
  const data={schema:"hv-delivery-sdh/1" as const,captions:{path:captions.path,sha256:captions.sha256,bytes:captions.bytes,cues:captions.cues},
    sounds:checked.map(cue=>({startMs:Math.floor(cue.start/48),endMs:Math.ceil(cue.end/48),text:sdhSoundText(cue)})),output:{width:output.width,height:output.height}};
  return {...data,revision:contentHash(data)};
}
/**
 * What the SDH render proved about its own file.
 *
 * `segmentsSha256` is what was written and `readBackSha256` is what the delivered file's subtitle
 * track decodes to; they must be equal. `masterStreams` and `deliveredStreams` hash the picture and
 * sound packets of the master and of the deliverable; they must be equal too, which is what "the
 * master, with a track added" means.
 */
export interface DeliverySdhCheck {
  schema:"hv-delivery-sdh-check/1";captionsSha256:string;dialogue:number;sounds:number;segments:number;
  segmentsSha256:string;readBackSha256:string;masterStreams:string;deliveredStreams:string;
  track:{codec:"mov_text";hearingImpaired:true;handler:"SDH"};
}
const HASH=/^[a-f0-9]{64}$/;
export function validateDeliverySdhCheck(check:DeliverySdhCheck,plan:DeliverySdhPlan):DeliverySdhCheck{
  if(!check||typeof check!=="object"||Array.isArray(check)
    ||Object.keys(check).some(key=>!["schema","captionsSha256","dialogue","sounds","segments","segmentsSha256","readBackSha256","masterStreams","deliveredStreams","track"].includes(key)))
    fail("An SDH deliverable keeps the check of its own track.");
  if(check.schema!=="hv-delivery-sdh-check/1"||check.captionsSha256!==plan.captions.sha256||check.dialogue!==plan.captions.cues||check.sounds!==plan.sounds.length)
    fail("This deliverable's SDH check read other cues than its plan names.");
  if(!Number.isInteger(check.segments)||check.segments<1||check.segments>2*(check.dialogue+check.sounds))fail("Count the SDH track's segments.");
  if(![check.segmentsSha256,check.readBackSha256,check.masterStreams,check.deliveredStreams].every(value=>HASH.test(value)))fail("An SDH check names what it hashed.");
  if(check.readBackSha256!==check.segmentsSha256)fail("This deliverable's SDH track does not read back as it was written.");
  if(check.deliveredStreams!==check.masterStreams)fail("This deliverable's picture or sound is not the master's own.");
  if(check.track?.codec!=="mov_text"||check.track.hearingImpaired!==true||check.track.handler!=="SDH"||Object.keys(check.track).length!==3)
    fail("An SDH deliverable carries one timed-text track marked for the hearing impaired.");
  return check;
}
