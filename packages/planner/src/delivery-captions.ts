import {contentHash} from "../../generator/src/capabilities";

/**
 * HV-027-15: the film's own captions, burned into the picture of a deliverable.
 *
 * Open captions are for the places a caption track is not read: a feed that autoplays without sound,
 * a platform that drops sidecar files, a screen in a lobby. Two decisions are the whole design.
 *
 * **The words are the film's own.** What is burned is the sealed `conform/captions.vtt` the cut was
 * completed with -- the same bytes, checked against the digest the sealed inventory names -- and
 * nothing is re-worded, re-segmented, translated or added. Its timing moves only as far as the burn
 * format forces: WebVTT counts milliseconds and the renderer counts centiseconds, so a start is
 * floored and an end is ceiled, and a cue is never shown later or cut shorter than the film's own.
 *
 * **A burned deliverable is terminal.** Once captions are in the picture they cannot be taken out,
 * so nothing may ever edit, dub or re-caption it. A delivery job is not an editorial, dialogue or
 * delivery source -- those allowlists name finished films, and this is not one -- and the test for
 * this increment holds that refusal in place rather than assuming it.
 */
export const DELIVERY_OPEN_CAPTIONS_RECIPE=Object.freeze({
  schema:"hv-delivery-open-captions/1",
  captions:"the film's own sealed conform/captions.vtt, digest-checked and cue-counted; nothing re-worded, re-segmented or added",
  timing:"WebVTT milliseconds to ASS centiseconds: start floored, end ceiled, so no cue is shown later or ended sooner than the film's own",
  layout:"bottom-centre inside side and bottom margins; the caption's own line breaks kept, libass smart wrapping within the margins",
  style:"white text with a black outline, no box and no shadow, sized from the delivered frame",
  font:"DejaVu Sans requested from the host's fontconfig; the font file is not pinned",
  encode:"h264-crf18-yuv420p-30fps, faststart, the master's own sound copied, no build version in the file (as the reframe recipe)",
  check:"every sampled cue is drawn alone on a black frame of the delivered size: it must leave ink, and no ink may touch the frame's edge",
  limits:Object.freeze({sampledCues:48,minimumFontPx:16,inkThreshold:64,maximumCues:4096,maximumBytes:8*1024**2}),
} as const);
export const OPEN_CAPTION_FRAMES=["master","9:16","1:1"] as const;
export type OpenCaptionFrame=typeof OPEN_CAPTION_FRAMES[number];
/** The sealed caption track a deliverable burns, as the film's own inventory names it. */
export interface DeliveryCaptionTrack {path:string;sha256:string;bytes:number;cues:number}
export interface DeliveryOpenCaptionsPlan {
  schema:"hv-delivery-open-captions/1";frame:OpenCaptionFrame;captions:DeliveryCaptionTrack;
  output:{width:number;height:number};
  /** The reframe's own crop, or null when the captions are burned into the master's own frame. */
  crop:string|null;
  style:{font:"DejaVu Sans";fontSize:number;outline:number;marginH:number;marginV:number};
  revision:string;
}
const fail:(message:string)=>never=message=>{throw new Error(message);};
const HASH=/^[a-f0-9]{64}$/;
/**
 * The caption layer's size comes from the frame it is burned into. A 9:16 frame is narrow, so its
 * text is sized from its width and wraps onto more lines rather than running off the edge.
 */
export function deliveryOpenCaptionsPlan(captions:DeliveryCaptionTrack|undefined,frame:OpenCaptionFrame,output:{width:number;height:number},crop:string|null):DeliveryOpenCaptionsPlan{
  if(!OPEN_CAPTION_FRAMES.includes(frame))fail("Choose a frame to burn captions into: "+OPEN_CAPTION_FRAMES.join(", ")+".");
  if(!captions||typeof captions!=="object")fail("This film's sealed caption track could not be tied to its cut, so it cannot be burned into the picture.");
  const {path,sha256,bytes,cues}=captions,limits=DELIVERY_OPEN_CAPTIONS_RECIPE.limits;
  if(typeof path!=="string"||!path.endsWith("/conform/captions.vtt")||!HASH.test(sha256)||!Number.isSafeInteger(bytes)||bytes<1||bytes>limits.maximumBytes)
    fail("Name the film's own sealed caption track, its bytes and its digest.");
  if(!Number.isInteger(cues)||cues<0||cues>limits.maximumCues)fail("Count the film's caption cues.");
  if(!cues)fail("This film has no captions to burn: nothing in its cut carries a spoken line.");
  if(!output||!Number.isInteger(output.width)||!Number.isInteger(output.height)||output.width<2||output.height<2||output.width%2||output.height%2)
    fail("Burn captions into a frame of even whole-pixel dimensions.");
  if(crop!==null&&(typeof crop!=="string"||!/^crop=\d+:\d+:\d+:\d+,setsar=1$/.test(crop)))fail("Burn captions into the master's own frame or a planned reframe of it.");
  if((frame==="master")!==(crop===null))fail("Only a reframed deliverable crops the master before its captions are burned.");
  const {width,height}=output;
  const fontSize=Math.max(limits.minimumFontPx,Math.round(Math.min(height/18,width/16)));
  const data={schema:"hv-delivery-open-captions/1" as const,frame,captions:{path,sha256,bytes,cues},output:{width,height},crop,
    style:{font:"DejaVu Sans" as const,fontSize,outline:Math.max(1,Math.round(fontSize/12)),marginH:Math.round(width*0.05),marginV:Math.round(height*0.06)}};
  return {...data,revision:contentHash(data)};
}
/** A retained plan is re-derived from its own parts rather than trusted. */
export function validateDeliveryOpenCaptionsPlan(plan:DeliveryOpenCaptionsPlan):DeliveryOpenCaptionsPlan{
  if(!plan||plan.schema!=="hv-delivery-open-captions/1")fail("Use an open-captions delivery plan.");
  const rebuilt=deliveryOpenCaptionsPlan(plan.captions,plan.frame,plan.output,plan.crop);
  if(contentHash(rebuilt)!==contentHash(plan))fail("This open-captions plan does not match the film it names.");
  return rebuilt;
}
/**
 * What the burn measured about its own caption layer.
 *
 * Each sampled cue is drawn alone, on a black frame the size of the deliverable, at a frame the
 * delivered picture actually shows it. `box` is where its ink landed. A cue that leaves no ink was
 * never visible (a missing font draws nothing), and one whose ink reaches the frame's edge was cut
 * off -- either is a defect of the burn, not of the film, so the render refuses both.
 *
 * `betweenFrames` counts cues too short to land on any frame of a 30 fps picture. They are in the
 * film's caption track, and burning cannot show them; the count says so instead of implying it.
 */
export interface DeliveryCaptionCheck {
  schema:"hv-delivery-caption-check/1";captionsSha256:string;cues:number;betweenFrames:number;
  frame:{width:number;height:number};
  sampled:{cue:number;frame:number;ink:number;box:{x0:number;y0:number;x1:number;y1:number}}[];
}
export function validateDeliveryCaptionCheck(check:DeliveryCaptionCheck,plan:DeliveryOpenCaptionsPlan):DeliveryCaptionCheck{
  const valid=validateDeliveryOpenCaptionsPlan(plan),limits=DELIVERY_OPEN_CAPTIONS_RECIPE.limits;
  if(!check||typeof check!=="object"||Array.isArray(check)||Object.keys(check).some(key=>!["schema","captionsSha256","cues","betweenFrames","frame","sampled"].includes(key)))
    fail("A burned deliverable keeps the check of its own caption layer.");
  if(check.schema!=="hv-delivery-caption-check/1"||check.captionsSha256!==valid.captions.sha256||check.cues!==valid.captions.cues)
    fail("This deliverable's caption check read a different caption track from the one its plan burns.");
  if(check.frame?.width!==valid.output.width||check.frame?.height!==valid.output.height)fail("This deliverable's caption check drew a different frame from the one delivered.");
  if(!Number.isInteger(check.betweenFrames)||check.betweenFrames<0||check.betweenFrames>check.cues)fail("Count the cues no frame can show.");
  const shown=check.cues-check.betweenFrames;
  if(!Array.isArray(check.sampled)||check.sampled.length!==Math.min(shown,limits.sampledCues))
    fail("This deliverable's caption check sampled "+(Array.isArray(check.sampled)?check.sampled.length:0)+" of "+shown+" shown cues.");
  let previous=-1;
  for(const sample of check.sampled){
    const {cue,frame,ink,box}=sample??{} as never;
    if(!Number.isInteger(cue)||cue<=previous||cue>=check.cues||!Number.isInteger(frame)||frame<0)fail("A caption sample names one cue of the track, in order.");
    previous=cue;
    if(!Number.isInteger(ink)||ink<1)fail("Caption cue "+(cue+1)+" left no ink on the delivered frame.");
    const {width,height}=valid.output;
    if(!box||![box.x0,box.y0,box.x1,box.y1].every(Number.isInteger)||box.x0>box.x1||box.y0>box.y1)fail("A caption sample records where its ink landed.");
    if(box.x0<=0||box.y0<=0||box.x1>=width-1||box.y1>=height-1)fail("Caption cue "+(cue+1)+" runs off the edge of the "+width+" by "+height+" frame.");
  }
  return check;
}
