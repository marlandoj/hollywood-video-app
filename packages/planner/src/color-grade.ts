import {contentHash} from "../../generator/src/capabilities";
import {EDIT_MAX_FRAMES} from "./edit-timeline";

/**
 * HV-026: a grade — a versioned colour decision on a finished cut, and the check that decides whether
 * the graded cut is offered.
 *
 * Three decisions are the whole design.
 *
 * **A grade never touches the cut.** It is a deliverable (docs/DELIVERY-JOBS.md): a new job that names
 * the cut's sealed output revision and writes one new file. The cut is read and never written, so a
 * grade can be changed, compared and thrown away as often as wanted. A grade is always made from the
 * cut's own master, never from another grade, because a delivery binds only to a picture edit or an
 * assembly — a grade of a grade would compound two encodes and two sets of clipping.
 *
 * **A grade is a decision, not a filter string.** Eight numbers and a look, each bounded and stepped,
 * hashed into a revision. The same decision on the same cut is the same deliverable, and a changed
 * decision is visibly a different one; the ffmpeg chain is derived from the decision, recorded beside
 * it, and re-derived rather than trusted.
 *
 * **A grade is checked before it is offered — and unlike every other deliverable, it is gated.** The
 * quality check on a reframe or a mezzanine does not gate it (HV-027-06), because every failure it can
 * find is inherited from the cut and the delivery route offers no remedy. A grade is different: the
 * clipping and the levels it is judged on are the grade's own doing, and the remedy is in the
 * creator's hands — lower the gain, raise the lift. So a grade that clips what the cut did not, or that
 * leaves the broadcast tolerance, is sealed with its measurement and **withheld**: listed with the
 * reason, never served.
 */
export const COLOR_GRADE_RECIPE=Object.freeze({
  schema:"hv-color-grade/1",
  space:"the cut's own 8-bit Rec.709 limited-range picture, converted to 16-bit RGB (bt709 matrix, tv range) for grading and back to yuv420p tv range for delivery",
  order:"white balance and exposure, then saturation (one 3x3 colorchannelmixer); then lift, gain, contrast about mid-grey and gamma (one lutrgb transfer, the same on every channel); then the look (lut3d, tetrahedral); nothing is scaled or cropped",
  temperature:"red and blue gains of 1 ± 0.1 × temperature, warm positive; tint moves green by 1 ∓ 0.1 × tint, magenta positive",
  saturation:"mixed toward Rec.709 luma (0.2126, 0.7152, 0.0722): 0 is monochrome, 1 unchanged",
  exposure:"a gain of 2^stops on the encoded signal, not on scene-linear light",
  encode:"h264-crf18-yuv420p-30fps, the cut's own soundtrack copied; the same metadata rules as a reframe (HV-027-07)",
  clipping:"any RGB channel at 0 or at full scale, measured on the graded picture before it is encoded and compared pixel by pixel with the same measure of the cut, so only what the grade clipped is counted",
  levels:"the graded file read back as encoded: the share of each frame's luma under 14 and over 241",
  bounds:Object.freeze({
    exposure:Object.freeze([-2,2]),temperature:Object.freeze([-1,1]),tint:Object.freeze([-1,1]),lift:Object.freeze([-0.2,0.2]),
    gamma:Object.freeze([0.5,2]),gain:Object.freeze([0.5,2]),contrast:Object.freeze([0.5,2]),saturation:Object.freeze([0,2]),
  }),
  step:0.01,
  /**
   * `frameShare` is the one area threshold: a frame counts when at least one percent of its pixels are
   * newly at 0 or full scale, or outside the luma tolerance.
   *
   * Clipping withholds a grade when more than `programmeShare` of its frames count — one percent of a
   * frame is a visible patch, five percent of a film is more than a glint.
   *
   * Levels withhold a grade when **any** frame counts. The tolerance is the one EBU R 103 gives luma,
   * −1% to 103% of the nominal range — 14 to 241 in 8-bit codes — judged over at least one percent of
   * the picture, as R 103 judges it, rather than on the single most extreme pixel: an H.264 encode rings
   * a few codes past every hard edge whatever the grade does, and a check that refused a neutral grade
   * for that would refuse every grade. Extremes past the nominal 16–235 are a note.
   */
  thresholds:Object.freeze({frameShare:0.01,programmeShare:0.05,lumaTolerance:Object.freeze([14,241]),lumaNominal:Object.freeze([16,235])}),
  notChecked:Object.freeze([
    "gamut beyond the RGB cube: clipping is counted, a hue that shifts inside it is not",
    "chroma levels and RGB gamut in the delivered file: only its luma is read against the tolerance",
    "scene-linear exposure: exposure is a gain on the encoded signal",
    "colour-managed transforms, HDR and any display other than Rec.709",
    "shot-to-shot matching: one decision covers the whole cut",
  ]),
} as const);
export type ColorGradeControl=keyof typeof COLOR_GRADE_RECIPE.bounds;
export const COLOR_GRADE_CONTROLS=Object.keys(COLOR_GRADE_RECIPE.bounds) as ColorGradeControl[];

/**
 * The studio's looks: four `.cube` files authored here, from the functions below, and shipped in
 * `packages/generator/looks/`. No third-party LUT is used. Each look maps every channel monotonically
 * with 0 kept at 0 and full scale at full scale, so **a look never clips anything on its own**: only a
 * primary correction pushed too far can, and the check measures exactly that.
 *
 * The digests bind a grade to the bytes of its look. `bun scripts/color-looks.ts` writes the files, and
 * a test holds the shipped files, these functions and these digests to one another.
 */
export const COLOR_LOOK_SIZE=17;
type Rgb=[number,number,number];
const power=(value:number,exponent:number)=>Math.pow(value,exponent);
/** A symmetric S about mid-grey: 0 and 1 fixed, steeper through the middle. */
const s=(value:number,k:number)=>value<0.5?0.5*power(2*value,k):1-0.5*power(2-2*value,k);
export const COLOR_LOOKS=Object.freeze({
  "neutral-709":Object.freeze({label:"Neutral Rec.709",description:"No look: the primary corrections alone, delivered in Rec.709 legal range.",
    sha256:"60b24b7e8cce74b378ada9dc14eb1abb9c66e7ebf38cc32c6873dbbd440728d6",bytes:132841,map:((r,g,b)=>[r,g,b]) as (r:number,g:number,b:number)=>Rgb}),
  warm:Object.freeze({label:"Warm",description:"Reds lifted and blues held back through the mids, as if under tungsten.",
    sha256:"1e58a65d4b273a5e5d1e48d11f5d9a87f2452068eba5d66932c54574c0d44ade",bytes:132830,map:((r,g,b)=>[power(r,0.92),power(g,0.98),power(b,1.1)]) as (r:number,g:number,b:number)=>Rgb}),
  cool:Object.freeze({label:"Cool",description:"Blues lifted and reds held back through the mids, as if in shade or moonlight.",
    sha256:"f48203859c061a05b86f1ec434bf590f547ef9c6f568bb7ade54111c3c6fbdd2",bytes:132830,map:((r,g,b)=>[power(r,1.1),power(g,0.99),power(b,0.92)]) as (r:number,g:number,b:number)=>Rgb}),
  "film-contrast":Object.freeze({label:"Film contrast",description:"A print-film S: deeper shadows and brighter highlights with the ends kept, and a faint warmth in the toe.",
    sha256:"8eed15559fc4212d79f0dca8864e57f736fc418b3d6566d8e7a900a56352a97d",bytes:132839,map:((r,g,b)=>[s(r,1.3),s(g,1.32),s(b,1.36)]) as (r:number,g:number,b:number)=>Rgb}),
});
export type ColorLookId=keyof typeof COLOR_LOOKS;
export const COLOR_LOOK_IDS=Object.keys(COLOR_LOOKS) as ColorLookId[];
/** The shipped file a look lives in, relative to the repository. */
export const colorLookFile=(id:ColorLookId)=>"packages/generator/looks/"+id+".cube";
/** A look, written as a `.cube`: red fastest, six decimals, the same bytes on every host. */
export function colorLookCube(id:ColorLookId):string{
  const look=COLOR_LOOKS[id];if(!look)fail("Choose a look from the studio's library: "+COLOR_LOOK_IDS.join(", ")+".");
  const n=COLOR_LOOK_SIZE,lines=["TITLE \"Rough Cut "+look.label+"\"","# Authored in packages/planner/src/color-grade.ts; regenerate with bun scripts/color-looks.ts.",
    "LUT_3D_SIZE "+n,"DOMAIN_MIN 0.0 0.0 0.0","DOMAIN_MAX 1.0 1.0 1.0"];
  for(let b=0;b<n;b++)for(let g=0;g<n;g++)for(let r=0;r<n;r++)
    lines.push(look.map(r/(n-1),g/(n-1),b/(n-1)).map(value=>Math.min(1,Math.max(0,value)).toFixed(6)).join(" "));
  return lines.join("\n")+"\n";
}

export interface ColorGradeDecision {
  exposure:number;temperature:number;tint:number;lift:number;gamma:number;gain:number;contrast:number;saturation:number;look:ColorLookId;
}
/** The decision that changes nothing but the encode: what a grade is before anyone has touched it. */
export const COLOR_GRADE_NEUTRAL:Readonly<ColorGradeDecision>=Object.freeze({exposure:0,temperature:0,tint:0,lift:0,gamma:1,gain:1,contrast:1,saturation:1,look:"neutral-709"});
export interface ColorGradeSource {width:number;height:number;frames:number}
export interface ColorGradePlan {
  schema:"hv-color-grade/1";source:ColorGradeSource;decision:ColorGradeDecision;
  look:{id:ColorLookId;file:string;sha256:string;bytes:number};
  /** The white balance, exposure and saturation matrix, output channels by row, six decimals. */
  matrix:string[];
  /** The per-channel transfer lutrgb evaluates: lift, gain, contrast and gamma. */
  transfer:string;
  /** The grade itself, from the cut's 8-bit picture to the delivered one. `look.cube` is the verified look. */
  filter:string;
  recipeRevision:string;revision:string;
}
const fail:(message:string)=>never=message=>{throw new Error(message);};
const fixed=(value:number)=>{const text=value.toFixed(6);return text==="-0.000000"?"0.000000":text;};
/**
 * A decision is eight bounded numbers in hundredths and a look from the library. Anything else is
 * refused by name, because a grade is compared, hashed and made again from these values, and a value
 * of 1.0000000001 is a different grade that looks the same.
 */
export function validateColorGradeDecision(input:unknown):ColorGradeDecision{
  if(!input||typeof input!=="object"||Array.isArray(input))fail("Describe the grade: "+COLOR_GRADE_CONTROLS.join(", ")+" and a look.");
  const value=input as Record<string,unknown>,known=[...COLOR_GRADE_CONTROLS,"look"];
  const extra=Object.keys(value).find(key=>!known.includes(key));
  if(extra!==undefined)fail("A grade has no "+JSON.stringify(extra.slice(0,40))+" control. It takes "+known.join(", ")+".");
  const decision={} as Record<string,unknown>;
  for(const control of COLOR_GRADE_CONTROLS){
    const [low,high]=COLOR_GRADE_RECIPE.bounds[control],number=value[control];
    if(typeof number!=="number"||!Number.isFinite(number)||number<low||number>high)
      fail("A grade's "+control+" must be a number from "+low+" to "+high+".");
    if(Math.abs(Math.round(number/COLOR_GRADE_RECIPE.step)*COLOR_GRADE_RECIPE.step-number)>1e-9)
      fail("A grade's "+control+" moves in steps of "+COLOR_GRADE_RECIPE.step+".");
    decision[control]=Math.round(number*100)/100+0;
  }
  if(typeof value.look!=="string"||!COLOR_LOOK_IDS.includes(value.look as ColorLookId))
    fail("Choose a look from the studio's library: "+COLOR_LOOK_IDS.join(", ")+".");
  decision.look=value.look;
  return decision as unknown as ColorGradeDecision;
}
/** White balance and exposure as channel gains, then saturation toward Rec.709 luma, as one matrix. */
export function colorGradeMatrix(decision:ColorGradeDecision):number[]{
  const e=Math.pow(2,decision.exposure),gains=[e*(1+0.1*decision.temperature),e*(1-0.1*decision.tint),e*(1-0.1*decision.temperature)];
  const luma=[0.2126,0.7152,0.0722],sat=decision.saturation,matrix:number[]=[];
  for(let row=0;row<3;row++)for(let column=0;column<3;column++)
    matrix.push(((row===column?sat:0)+(1-sat)*luma[column]!)*gains[column]!);
  return matrix;
}
export function colorGradePlan(source:ColorGradeSource,input:unknown):ColorGradePlan{
  for(const [name,value,low,high] of [["width",source?.width,16,4096],["height",source?.height,16,4096],["frames",source?.frames,1,EDIT_MAX_FRAMES]] as const)
    if(!Number.isInteger(value)||(value as number)<low||(value as number)>high)fail("A graded cut's "+name+" must be a whole number from "+low+" to "+high+".");
  if(source.width%2||source.height%2)fail("A graded cut keeps the cut's own even dimensions.");
  const decision=validateColorGradeDecision(input),look=COLOR_LOOKS[decision.look];
  if(!/^[a-f0-9]{64}$/.test(look.sha256)||!Number.isSafeInteger(look.bytes)||look.bytes<1)
    fail("The "+decision.look+" look has no recorded digest, so a grade cannot be bound to it.");
  const matrix=colorGradeMatrix(decision).map(fixed);
  const names=["rr","rg","rb","gr","gg","gb","br","bg","bb"];
  const x="(val/maxval)";
  const transfer="maxval*pow(clip(("+fixed(decision.gain)+"*("+x+"*"+fixed(1-decision.lift)+"+("+fixed(decision.lift)+"))-0.5)*"
    +fixed(decision.contrast)+"+0.5,0,1),"+fixed(1/decision.gamma)+")";
  const filter=["scale=in_color_matrix=bt709:in_range=tv","format=rgb48le",
    "colorchannelmixer="+names.map((name,at)=>name+"="+matrix[at]).join(":"),
    "lutrgb=r='"+transfer+"':g='"+transfer+"':b='"+transfer+"'",
    "lut3d=file=look.cube:interp=tetrahedral"].join(",");
  const data={schema:"hv-color-grade/1" as const,source:{width:source.width,height:source.height,frames:source.frames},decision,
    look:{id:decision.look,file:colorLookFile(decision.look),sha256:look.sha256,bytes:look.bytes},matrix,transfer,filter,
    recipeRevision:contentHash(COLOR_GRADE_RECIPE)};
  return {...data,revision:contentHash(data)};
}
/** A retained plan is re-derived from its own source and decision rather than trusted. */
export function validateColorGradePlan(plan:ColorGradePlan):ColorGradePlan{
  if(!plan||plan.schema!=="hv-color-grade/1")fail("Use a colour grade plan.");
  const rebuilt=colorGradePlan(plan.source,plan.decision);
  if(contentHash(rebuilt)!==contentHash(plan))fail("This grade plan does not match the decision it names.");
  return rebuilt;
}
const MASK=(test:string)=>"lutrgb=r='maxval*"+test+"':g='maxval*"+test+"':b='maxval*"+test+"',colorchannelmixer=rr=1:rg=1:rb=1:gr=1:gg=1:gb=1:br=1:bg=1:bb=1";
const plain=(name:string)=>{if(!/^[a-z0-9-]+\.txt$/.test(name))fail("A grade's measurement is written to a plain file name in its own scratch.");return name;};
const share=(file:string)=>"signalstats,metadata=print:key=lavfi.signalstats.YAVG:file="+plain(file);
/**
 * The whole graph the grading ffmpeg runs: the graded picture to `[graded]`, and two masks — pixels
 * the grade put at full scale, and pixels it put at 0, that the cut did not already have there — each
 * read by `signalstats` as a per-frame share and printed to its file.
 *
 * A mask is 65535 on every channel where **any** channel is at the bound, so a red channel pushed off
 * the top counts even when the pixel is not white. The cut's own mask is subtracted pixel by pixel, so
 * a sky the cut had already blown is not blamed on the grade. The mask is carried to 8-bit full range
 * before it is read, where "every channel equal" makes its luma exactly the mask.
 */
export function colorGradeGraph(plan:ColorGradePlan,files:{ceiling:string;floor:string}):string{
  const valid=validateColorGradePlan(plan),stages=valid.filter.split(",");
  const into=stages.slice(0,2).join(","),grade=stages.slice(2).join(",");
  const read=(file:string)=>"scale=out_color_matrix=bt709:out_range=pc,format=yuvj444p,"+share(file);
  return ["[0:v:0]"+into+",split=3[cut][cuthigh][cutlow]",
    "[cut]"+grade+",split=3[grade][gradehigh][gradelow]",
    "[grade]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[graded]",
    "[cuthigh]"+MASK("eq(val,maxval)")+"[cutceiling]","[gradehigh]"+MASK("eq(val,maxval)")+"[gradeceiling]",
    "[gradeceiling][cutceiling]blend=all_mode=subtract,"+read(files.ceiling)+"[ceiling]",
    "[cutlow]"+MASK("eq(val,0)")+"[cutfloor]","[gradelow]"+MASK("eq(val,0)")+"[gradefloor]",
    "[gradefloor][cutfloor]blend=all_mode=subtract,"+read(files.floor)+"[floor]"].join(";");
}
/**
 * The graph that reads the graded file back, as encoded: the share of each frame's luma below and
 * above the tolerance. The grade itself cannot leave the tolerance — it is converted to limited range
 * from RGB — but the encode rings past hard edges, further when the grade has steepened them, so the
 * file is what is judged, not the picture before it was encoded.
 */
export function colorGradeLevelsGraph(files:{below:string;above:string}):string{
  const [floor,ceiling]=COLOR_GRADE_RECIPE.thresholds.lumaTolerance;
  return ["[0:v:0]split=2[low][high]","[low]lutyuv=y='255*lt(val,"+floor+")',"+share(files.below)+"[below]",
    "[high]lutyuv=y='255*gt(val,"+ceiling+")',"+share(files.above)+"[above]"].join(";");
}

/** One per-frame share, across the programme: frames at or over the frame threshold, and the worst one. */
export interface ColorGradeTally {frames:number;worstShare:number;worstFrame:number|null}
export interface ColorGradeMeasurement {
  framesMeasured:number;
  /** Pixels the grade put at full scale, and at 0, that the cut had not: the graded picture before it was encoded. */
  ceiling:ColorGradeTally;floor:ColorGradeTally;
  /** Pixels of the graded file, as encoded, with luma below and above the tolerance. */
  below:ColorGradeTally;above:ColorGradeTally;
}
const TALLIES=["ceiling","floor","below","above"] as const;
/**
 * Per-frame shares reduced as they are read. Pure, so what the check is judged on can be driven by a
 * test directly.
 */
export function colorGradeTally(shares:number[]):ColorGradeTally{
  let frames=0,worstShare=0,worstFrame:number|null=null;
  shares.forEach((share,frame)=>{
    if(!Number.isFinite(share)||share<0||share>1)fail("A measured share was not a fraction of a frame.");
    if(share>=COLOR_GRADE_RECIPE.thresholds.frameShare)frames++;
    if(share>worstShare){worstShare=share;worstFrame=frame;}
  });
  // The share is kept to a millionth, and the worst frame is named only when that rounded share is
  // above nothing. A single stray pixel in a 1080p frame is 4.8e-7 of it, which rounds to 0; naming its
  // frame beside a share of 0 made a tally the check itself refused, and a grade that tripped it failed
  // on every retry.
  const rounded=Math.round(worstShare*1e6)/1e6;
  return {frames,worstShare:rounded,worstFrame:rounded>0?worstFrame:null};
}
export interface ColorGradeFinding {code:string;severity:"withhold"|"note";message:string}
/**
 * The check, bound to the graded file it judged. `measurement` comes from the render that made the
 * file; `levels` is the extremes the file's own picture quality check read, carried so the two
 * readings of one file can be made to agree.
 */
export interface ColorGradeCheck {
  schema:"hv-color-grade-check/1";recipeRevision:string;planRevision:string;source:{sha256:string;bytes:number};
  measurement:ColorGradeMeasurement;levels:{lumaMin:number|null;lumaMax:number|null};
  findings:ColorGradeFinding[];verdict:"offered"|"withheld";notChecked:readonly string[];revision:string;
}
const percent=(value:number)=>(Math.round(value*1000)/10)+"%";
const where=(tally:ColorGradeTally,frames:number)=>" in "+tally.frames+" of "+frames+" frames (up to "+percent(tally.worstShare)+" of frame "+tally.worstFrame+")";
/** Pure: the same measurement always produces the same findings, in the same order. */
export function colorGradeFindings(plan:ColorGradePlan,measurement:ColorGradeMeasurement,levels:ColorGradeCheck["levels"]):ColorGradeFinding[]{
  const findings:ColorGradeFinding[]=[],limits=COLOR_GRADE_RECIPE.thresholds,frames=plan.source.frames;
  if(measurement.framesMeasured!==frames)fail("This grade was measured over "+measurement.framesMeasured+" frames and the cut has "+frames+".");
  const allowed=Math.floor(frames*limits.programmeShare);
  for(const [bound,code,what,remedy] of [["ceiling","highlights-clipped","clips the highlights","Lower the gain or the exposure"],
    ["floor","blacks-crushed","crushes the blacks","Raise the lift or lower the contrast"]] as const){
    const tally=measurement[bound];
    if(!tally.frames)continue;
    if(tally.frames>allowed)findings.push({code,severity:"withhold",message:"This grade "+what+where(tally,frames)+" that the cut did not. "+remedy+", and grade again."});
    else findings.push({code,severity:"note",message:"This grade "+what+where(tally,frames)+", within the "+percent(limits.programmeShare)+" of the film it may."});
  }
  const [floor,ceiling]=limits.lumaTolerance,[nominalFloor,nominalCeiling]=limits.lumaNominal;
  for(const [bound,side,remedy] of [["below","under "+floor,"Raise the lift"],["above","over "+ceiling,"Lower the gain"]] as const){
    const tally=measurement[bound];
    if(tally.frames)findings.push({code:"illegal-levels",severity:"withhold",message:"The graded cut has "+percent(limits.frameShare)+" or more of its picture "+side
      +", outside the broadcast tolerance,"+where(tally,frames)+". "+remedy+", and grade again."});
  }
  if(levels.lumaMin===null||levels.lumaMax===null)
    findings.push({code:"levels-unmeasured",severity:"withhold",message:"The graded cut's levels were not measured, so it cannot be offered as legal."});
  else if(levels.lumaMin<nominalFloor||levels.lumaMax>nominalCeiling)
    findings.push({code:"levels-outside-nominal",severity:"note",message:"The graded cut's luma reaches "+levels.lumaMin+"–"+levels.lumaMax
      +", past the nominal "+nominalFloor+"–"+nominalCeiling+(measurement.below.frames||measurement.above.frames?".":" on less than "+percent(limits.frameShare)+" of any frame.")});
  return findings;
}
export function colorGradeCheck(plan:ColorGradePlan,source:ColorGradeCheck["source"],measurement:ColorGradeMeasurement,levels:ColorGradeCheck["levels"]):ColorGradeCheck{
  const valid=validateColorGradePlan(plan);
  if(!/^[a-f0-9]{64}$/.test(source?.sha256??"")||!Number.isSafeInteger(source.bytes)||source.bytes<1)fail("A grade's check names the bytes it judged.");
  for(const tally of TALLIES.map(key=>measurement?.[key]))
    if(!tally||!Number.isSafeInteger(tally.frames)||tally.frames<0||tally.frames>valid.source.frames||!Number.isFinite(tally.worstShare)||tally.worstShare<0||tally.worstShare>1
      ||(tally.worstFrame!==null&&(!Number.isSafeInteger(tally.worstFrame)||tally.worstFrame<0||tally.worstFrame>=valid.source.frames))||(tally.worstFrame===null)!==(tally.worstShare===0))
      fail("A grade's measurement does not describe this cut.");
  for(const value of [levels?.lumaMin,levels?.lumaMax])if(value!==null&&(typeof value!=="number"||!Number.isFinite(value)))fail("A grade's levels are not a reading.");
  const findings=colorGradeFindings(valid,measurement,levels);
  const data={schema:"hv-color-grade-check/1" as const,recipeRevision:contentHash(COLOR_GRADE_RECIPE),planRevision:valid.revision,
    source:{sha256:source.sha256,bytes:source.bytes},
    measurement:{framesMeasured:measurement.framesMeasured,...Object.fromEntries(TALLIES.map(key=>[key,{frames:measurement[key].frames,worstShare:measurement[key].worstShare,worstFrame:measurement[key].worstFrame}]))} as ColorGradeMeasurement,
    levels:{lumaMin:levels.lumaMin,lumaMax:levels.lumaMax},findings,
    verdict:(findings.some(finding=>finding.severity==="withhold")?"withheld":"offered") as ColorGradeCheck["verdict"],
    notChecked:COLOR_GRADE_RECIPE.notChecked};
  return {...data,revision:contentHash(data)};
}
/** A retained check is re-derived from its own measurement rather than trusted — the whole check, not its revision. */
export function validateColorGradeCheck(plan:ColorGradePlan,check:ColorGradeCheck):ColorGradeCheck{
  if(!check||check.schema!=="hv-color-grade-check/1"||check.recipeRevision!==contentHash(COLOR_GRADE_RECIPE))fail("This grade was checked by another recipe. Grade it again.");
  const rebuilt=colorGradeCheck(plan,check.source,check.measurement,check.levels);
  if(contentHash(rebuilt)!==contentHash(check))fail("This grade's check does not match its own measurement.");
  return rebuilt;
}
/** A withheld grade is refused wherever it would be offered, with every reason it was withheld. */
export function assertColorGradeOffered(plan:ColorGradePlan,check:ColorGradeCheck):void{
  const valid=validateColorGradeCheck(plan,check);
  if(valid.verdict!=="offered")fail("This grade is withheld: "+valid.findings.filter(finding=>finding.severity==="withhold").map(finding=>finding.message).join(" "));
}
