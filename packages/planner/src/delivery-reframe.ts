import {contentHash} from "../../generator/src/capabilities";

/**
 * HV-027: a vertical or square cut of a finished film, for the places a 16:9 master cannot go.
 *
 * Two decisions are worth stating because they are the whole design. **Nothing is scaled**: the
 * deliverable is a crop of the master, so it can never be sharper than the master and never pretends
 * to be — a 9:16 cut of a 720p film is 720 lines tall, not 1920. And **the sound is the master's
 * own**, copied rather than re-encoded, so a reframe cannot change what the film sounds like.
 *
 * A crop keeps the master's full height and takes the width the format asks for, rounded to the
 * nearest even pixel because 4:2:0 chroma is shared between pairs. That rounding is at most one
 * pixel and the plan records exactly how far from the format it lands, rather than claiming the
 * ratio is exact.
 */
export const DELIVERY_REFRAME_RECIPE=Object.freeze({
  schema:"hv-delivery-reframe/1",
  crop:"centred-by-default; master's full height where the format is narrower; even width, even offsets for 4:2:0 chroma",
  scale:"none: a deliverable is a crop of the master and is never upscaled",
  sound:"the master's own audio stream, copied",
  encode:"h264-crf18-yuv420p-30fps, metadata stripped, faststart",
  limits:Object.freeze({minimumEdge:256,maximumRatioDeviation:0.01}),
  formats:Object.freeze({"9:16":Object.freeze([9,16]),"1:1":Object.freeze([1,1])}),
} as const);
export type DeliveryFormat=keyof typeof DELIVERY_REFRAME_RECIPE.formats;
export const DELIVERY_FORMATS=Object.keys(DELIVERY_REFRAME_RECIPE.formats) as DeliveryFormat[];
export interface DeliverySource {width:number;height:number;durationSec:number}
export interface DeliveryReframePlan {
  schema:"hv-delivery-reframe/1";format:DeliveryFormat;source:DeliverySource;
  output:{width:number;height:number};crop:{x:number;y:number;width:number;height:number};
  /** Where the crop sits across the master, in ten-thousandths: 0 is hard left, 10000 hard right. */
  anchorX:number;
  /** How far the even-rounded crop lands from the format's exact ratio. Recorded, not hidden. */
  ratioDeviation:number;
  filter:string;revision:string;
}
const fail:(message:string)=>never=message=>{throw new Error(message);};
const evenDown=(value:number)=>Math.floor(value/2)*2;
const evenNear=(value:number)=>Math.round(value/2)*2;
export function deliveryReframePlan(source:DeliverySource,format:DeliveryFormat,anchorX=5000):DeliveryReframePlan{
  if(!DELIVERY_FORMATS.includes(format))fail("Choose a delivery format this studio makes: "+DELIVERY_FORMATS.join(", ")+".");
  for(const [name,value] of [["width",source?.width],["height",source?.height]] as const)
    if(!Number.isInteger(value)||(value as number)<2||(value as number)>4096)fail("A delivered master's "+name+" must be a whole number of pixels from 2 to 4096.");
  if(!Number.isFinite(source.durationSec)||source.durationSec<=0)fail("A delivered master must have a playable duration.");
  if(!Number.isInteger(anchorX)||anchorX<0||anchorX>10000)fail("Place the frame from 0 to 10000 across the master.");
  const [wide,tall]=DELIVERY_REFRAME_RECIPE.formats[format],target=wide/tall;
  // Keep every line the master has when the format is narrower than it; otherwise keep every column.
  let height=evenDown(source.height),width=evenNear(height*target);
  if(width>evenDown(source.width)){width=evenDown(source.width);height=evenNear(width/target);}
  if(height>evenDown(source.height))height=evenDown(source.height);
  const limits=DELIVERY_REFRAME_RECIPE.limits;
  if(width<limits.minimumEdge||height<limits.minimumEdge)
    fail("A "+format+" cut of this master would be "+width+" by "+height+", under the "+limits.minimumEdge+"-pixel minimum. Deliver from a larger master.");
  const ratioDeviation=Math.abs(width/height-target);
  if(ratioDeviation>limits.maximumRatioDeviation)fail("A "+format+" cut of this master cannot be made within one pixel of the format.");
  const x=evenDown(Math.min(Math.max(Math.round((source.width-width)*anchorX/10000),0),source.width-width)),y=evenDown((source.height-height)/2);
  const data={schema:"hv-delivery-reframe/1" as const,format,source:{width:source.width,height:source.height,durationSec:source.durationSec},
    output:{width,height},crop:{x,y,width,height},anchorX,ratioDeviation,
    filter:"crop="+width+":"+height+":"+x+":"+y+",setsar=1"};
  return {...data,revision:contentHash(data)};
}
/** A retained plan is re-derived from its own source rather than trusted. */
export function validateDeliveryReframePlan(plan:DeliveryReframePlan):DeliveryReframePlan{
  if(!plan||plan.schema!=="hv-delivery-reframe/1")fail("Use a delivery reframe plan.");
  const rebuilt=deliveryReframePlan(plan.source,plan.format,plan.anchorX);
  if(contentHash(rebuilt)!==contentHash(plan))fail("This delivery plan does not match the master it names.");
  return rebuilt;
}
