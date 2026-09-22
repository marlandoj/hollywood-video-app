import {contentHash} from "../../generator/src/capabilities";
import {EDIT_FPS,EDIT_MAX_FRAMES,EDIT_SAMPLES_PER_FRAME} from "./edit-timeline";
import {EDIT_STORAGE_LIMITS} from "./edit-resources";

/**
 * HV-027: the mezzanine master — the film in the form another edit suite can take it in.
 *
 * The decision that is the whole design: **a mezzanine is not made from the delivered file.** The
 * delivered `export.mp4` is H.264 at CRF 18; re-encoding it into ProRes produces a larger file that
 * is no better, because nothing can put back what the H.264 encode threw away. A mezzanine built
 * that way is a big file wearing a master's clothes.
 *
 * The conform already writes a **lossless FFV1 picture master** and a 48 kHz 24-bit mix, and seals
 * both as artifacts. So the mezzanine is those two streams, **copied** — not transcoded, not
 * re-encoded, not even re-compressed. `-c:v copy -c:a copy`. The bytes of the picture are the bytes
 * the conform made.
 *
 * That is also why this is not ProRes. ProRes 422 HQ is 4:2:2 and ten-bit; the conform's picture
 * master is 4:2:0 and eight-bit, so a ProRes wrap would carry no more information than the FFV1 does
 * while costing more and changing every pixel on the way. Measured on a three-second fixture: the
 * FFV1 rewrap was 1,539,214 bytes with every frame bit-identical to the conform's own; ProRes 422 HQ
 * was 4,217,081 bytes and differed from the conform's picture on all ninety frames. A wider codec
 * around a narrower picture is the same trade this epic already refused for scaling.
 */
export const DELIVERY_MEZZANINE_RECIPE=Object.freeze({
  schema:"hv-delivery-mezzanine/1",
  container:"matroska",
  picture:"the conform's own FFV1 yuv420p picture master, stream-copied part by part",
  sound:"the conform's own 48 kHz 24-bit final mix, stream-copied as pcm_s24le",
  metadata:"stripped: no tags, no encoder string, no source paths",
  proof:"the mezzanine's decoded frames are hashed and compared with the conform's own recorded frame hashes; a single differing frame is refused",
  /**
   * A mezzanine is retained beside the output it was made from, and it is the largest thing that
   * output contains, so it gets half the editorial output budget and no more.
   */
  limits:Object.freeze({maximumBytes:EDIT_STORAGE_LIMITS.outputBytes/2,containerOverhead:0.01,containerOverheadBytes:1024**2}),
  notCarried:Object.freeze([
    "captions or a subtitle track (the conform's WebVTT is delivered beside it)",
    "a timecode track or a start timecode",
    "the separate audio lanes: one stereo mix, as the conform made it",
    "colour primaries, transfer or matrix tagging beyond what the picture master already carries",
    "an alpha channel",
    "any wider colour: the picture master is eight-bit 4:2:0, and a ten-bit or 4:2:2 wrap would carry no more of it",
  ]),
} as const);
export interface MezzanineSource {
  width:number;height:number;frames:number;
  /** `contentHash` of the conform's own per-frame picture hashes: the proof, in sixty-four bytes. */
  pictureFramesSha256:string;
  /** What the conform's retained picture parts and final mix actually weigh. */
  pictureBytes:number;mixBytes:number;
}
export interface DeliveryMezzaninePlan {
  schema:"hv-delivery-mezzanine/1";source:MezzanineSource;
  output:{width:number;height:number;frames:number;durationSec:number;video:"ffv1";pixelFormat:"yuv420p";audio:"pcm_s24le";sampleRate:48000;channels:2};
  /** The streams plus an allowance for the container's own bookkeeping. The result records the truth. */
  estimatedBytes:number;
  revision:string;
}
const fail:(message:string)=>never=message=>{throw new Error(message);};
const bytes=(value:number)=>value.toLocaleString("en-US")+" bytes";
/**
 * What a conform's own record has to look like before anything is made of it.
 *
 * HV-027-03: separated from the plan because they answer different questions. Whether this record
 * describes a film is a fact about the conform, and everything delivered from it depends on the
 * answer; whether a *lossless master* of that film fits beside it is a fact about this one
 * deliverable. They were the same function, so a film too long for a mezzanine could not be bound to
 * at all -- and its reframes, which cost a fraction of the size, were refused with it.
 */
export function assertMezzanineSource(source:MezzanineSource):MezzanineSource{
  if(!source||typeof source!=="object")fail("Describe the conform this mezzanine is made from.");
  for(const [name,value,low,high] of [["width",source.width,16,1920],["height",source.height,16,1080],["frames",source.frames,1,EDIT_MAX_FRAMES]] as const)
    if(!Number.isInteger(value)||value<low||value>high)fail("A mezzanine's "+name+" must be a whole number from "+low+" to "+high+".");
  if(source.width%2||source.height%2)fail("A mezzanine carries the conform's own even export dimensions.");
  if(!/^[a-f0-9]{64}$/.test(source.pictureFramesSha256))fail("Name the conform's recorded picture frame hashes, so the mezzanine can be checked against them.");
  if(!Number.isInteger(source.pictureBytes)||source.pictureBytes<=0)fail("The conform's retained picture master must have a size.");
  // The conform's mix is canonical: a 44-byte header and six bytes per sample of stereo 24-bit at
  // 48 kHz, for exactly this many frames. Its size is a fact, not a report, so it is checked rather
  // than believed -- a mix of the wrong length means this record is not describing this conform.
  const mixBytes=44+source.frames*EDIT_SAMPLES_PER_FRAME*6;
  if(source.mixBytes!==mixBytes)
    fail("This conform's final mix is "+bytes(source.mixBytes)+" and "+source.frames+" frames of stereo 48 kHz 24-bit sound is "+bytes(mixBytes)+". The plan and the film do not agree.");
  return {width:source.width,height:source.height,frames:source.frames,
    pictureFramesSha256:source.pictureFramesSha256,pictureBytes:source.pictureBytes,mixBytes};
}
export function deliveryMezzaninePlan(input:MezzanineSource):DeliveryMezzaninePlan{
  const source=assertMezzanineSource(input),mixBytes=source.mixBytes;
  const streams=source.pictureBytes+mixBytes,limits=DELIVERY_MEZZANINE_RECIPE.limits;
  const estimatedBytes=streams+Math.ceil(streams*limits.containerOverhead)+limits.containerOverheadBytes;
  if(estimatedBytes>limits.maximumBytes)
    fail("A mezzanine of this film would be about "+bytes(estimatedBytes)+", over the "+bytes(limits.maximumBytes)
      +" one may take. A lossless master of a film this long does not fit beside it; deliver a shorter range, or take the H.264 master.");
  const data={schema:"hv-delivery-mezzanine/1" as const,
    source:{width:source.width,height:source.height,frames:source.frames,pictureFramesSha256:source.pictureFramesSha256,pictureBytes:source.pictureBytes,mixBytes},
    output:{width:source.width,height:source.height,frames:source.frames,durationSec:source.frames/EDIT_FPS,
      video:"ffv1" as const,pixelFormat:"yuv420p" as const,audio:"pcm_s24le" as const,sampleRate:48000 as const,channels:2 as const},
    estimatedBytes};
  return {...data,revision:contentHash(data)};
}
/**
 * The mezzanine's source, read off the conform's own record rather than off the disk.
 *
 * `conform.json` already states every fact this needs: the picture master's parts and their frame
 * counts, and `pictureFrames` — the per-frame hashes the conform computed while it made them. Only
 * the parts' sizes come from the filesystem, and they are passed in so this stays a pure function
 * the tests can drive. The three counts have to agree with each other before any of them is used:
 * a conform whose parts do not add up to its timeline is not a film to make a master of.
 */
export function mezzanineSource(
  conform:{pictureFrames:string[];picture:{parts:{frames:number}[]}},
  timeline:{width:number;height:number;frames:number},
  partBytes:number[],
):MezzanineSource{
  if(!conform?.picture?.parts?.length||!Array.isArray(conform.pictureFrames))fail("This editorial record has no picture master to deliver.");
  if(partBytes.length!==conform.picture.parts.length)
    fail("This conform records "+conform.picture.parts.length+" picture parts and "+partBytes.length+" were found on disk.");
  if(partBytes.some(value=>!Number.isInteger(value)||value<=0))fail("Every retained picture part must have a size.");
  const parts=conform.picture.parts.reduce((total,part)=>total+part.frames,0);
  if(parts!==timeline.frames||conform.pictureFrames.length!==timeline.frames)
    fail("This film is "+timeline.frames+" frames, its picture master holds "+parts+" and it recorded "+conform.pictureFrames.length+" frame hashes. They have to agree before a master is made of them.");
  return assertMezzanineSource({width:timeline.width,height:timeline.height,frames:timeline.frames,
    pictureFramesSha256:contentHash(conform.pictureFrames),
    pictureBytes:partBytes.reduce((total,value)=>total+value,0),mixBytes:44+timeline.frames*EDIT_SAMPLES_PER_FRAME*6});
}
/** A retained plan is re-derived from its own source rather than trusted. */
export function validateDeliveryMezzaninePlan(plan:DeliveryMezzaninePlan):DeliveryMezzaninePlan{
  if(!plan||plan.schema!=="hv-delivery-mezzanine/1")fail("Use a delivery mezzanine plan.");
  const rebuilt=deliveryMezzaninePlan(plan.source);
  if(contentHash(rebuilt)!==contentHash(plan))fail("This mezzanine plan does not match the conform it names.");
  return rebuilt;
}
