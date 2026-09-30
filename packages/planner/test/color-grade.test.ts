/**
 * HV-026-07 — a grade: a versioned colour decision on a finished cut, and the check that decides
 * whether the graded cut is offered.
 *
 * These are the pure halves: what a decision may be, how it binds a deliverable, what the studio's
 * looks are, and how a measurement becomes "offered" or "withheld". The render and the route are
 * exercised in `packages/generator/test/color-grade.test.ts` and
 * `packages/api/test/color-grade-route.test.ts`.
 */
import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {contentHash} from "../../generator/src/capabilities";
import {COLOR_GRADE_NEUTRAL,COLOR_GRADE_RECIPE,COLOR_LOOKS,COLOR_LOOK_IDS,COLOR_LOOK_SIZE,assertColorGradeOffered,colorGradeCheck,colorGradeTally,
  colorGradeGraph,colorGradeLevelsGraph,colorGradeMatrix,colorGradePlan,colorLookCube,colorLookFile,validateColorGradeCheck,validateColorGradeDecision,validateColorGradePlan,
  type ColorGradeMeasurement} from "../src/color-grade";
import {deliveryBinding,deliveryJobPlan,deliveryOffers,validateDeliveryPlan,type DeliveryFile} from "../src/delivery-jobs";

const REPOSITORY=join(import.meta.dir,"../../..");
const PROJECT="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",JOB="bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",ROOT=PROJECT+"/"+JOB+"/export/conform";
const digest=(seed:string)=>seed.repeat(64).slice(0,64);
const at=(path:string,bytes:number):DeliveryFile=>({path,sha256:contentHash(path),bytes});
const binding=(outputRevision=digest("d"))=>deliveryBinding({storage:"local",source:{projectId:PROJECT,jobId:JOB,stage:"picture-edit",outputRevision},
  master:at(ROOT+"/export.mp4",4_000_000),
  files:[at(ROOT+"/export.mp4",4_000_000),at(ROOT+"/picture/index.ffconcat",512),at(ROOT+"/audio/final.wav",44+900*1600*6),at(ROOT+"/picture/part-00000.mkv",60_000_000)],
  conform:{width:1280,height:720,frames:900,pictureFramesSha256:digest("c"),pictureBytes:60_000_000,mixBytes:44+900*1600*6}});
const SOURCE={width:1280,height:720,frames:900};
const none={frames:0,worstShare:0,worstFrame:null};
const clean:ColorGradeMeasurement={framesMeasured:900,ceiling:none,floor:none,below:none,above:none};
const FILE={sha256:digest("e"),bytes:1234};

/**
 * A decision is compared, hashed and made again from its numbers, so a number outside its range, off
 * its step, or a control the grade does not have is refused by name rather than rounded into a grade
 * nobody asked for.
 */
test("a grade is eight bounded numbers in hundredths and a look, and anything else is refused by name",()=>{
  expect(validateColorGradeDecision({...COLOR_GRADE_NEUTRAL})).toEqual({...COLOR_GRADE_NEUTRAL});
  expect(validateColorGradeDecision({...COLOR_GRADE_NEUTRAL,exposure:-0.35,temperature:0.2,saturation:1.15,look:"warm"}))
    .toMatchObject({exposure:-0.35,temperature:0.2,saturation:1.15,look:"warm"});
  for(const [control,[low,high]] of Object.entries(COLOR_GRADE_RECIPE.bounds)){
    expect(()=>validateColorGradeDecision({...COLOR_GRADE_NEUTRAL,[control]:high+0.01})).toThrow("grade's "+control+" must be a number from "+low+" to "+high);
    expect(()=>validateColorGradeDecision({...COLOR_GRADE_NEUTRAL,[control]:low-0.01})).toThrow("grade's "+control+" must be a number");
    expect(()=>validateColorGradeDecision({...COLOR_GRADE_NEUTRAL,[control]:String(low)})).toThrow("grade's "+control+" must be a number");
  }
  expect(()=>validateColorGradeDecision({...COLOR_GRADE_NEUTRAL,gain:1.005})).toThrow("moves in steps of 0.01");
  expect(()=>validateColorGradeDecision({...COLOR_GRADE_NEUTRAL,gain:Number.NaN})).toThrow("grade's gain must be a number");
  expect(()=>validateColorGradeDecision({...COLOR_GRADE_NEUTRAL,look:"teal-and-orange"})).toThrow("Choose a look from the studio's library");
  expect(()=>validateColorGradeDecision({...COLOR_GRADE_NEUTRAL,hue:0.1})).toThrow('A grade has no "hue" control');
  expect(()=>validateColorGradeDecision(null)).toThrow("Describe the grade");
  const {look:_look,...noLook}=COLOR_GRADE_NEUTRAL;
  expect(()=>validateColorGradeDecision(noLook)).toThrow("Choose a look");
  // The chain is derived, never supplied: a plan whose filter was edited is not the decision it names.
  const plan=colorGradePlan(SOURCE,COLOR_GRADE_NEUTRAL);
  expect(validateColorGradePlan(plan)).toEqual(plan);
  expect(()=>validateColorGradePlan({...plan,filter:plan.filter.replace("tetrahedral","nearest")})).toThrow("does not match the decision");
  expect(()=>validateColorGradePlan({...plan,look:{...plan.look,sha256:digest("0")}})).toThrow("does not match the decision");
  expect(()=>colorGradePlan({...SOURCE,width:1279},COLOR_GRADE_NEUTRAL)).toThrow("even dimensions");
});

/**
 * The matrix is the one place white balance, exposure and saturation meet, so it is held to the
 * arithmetic: neutral is the identity, a stop is a doubling, warmth is red up and blue down, and a
 * monochrome row is the Rec.709 luma weights.
 */
test("white balance, exposure and saturation are one matrix, and neutral is the identity",()=>{
  expect(colorGradeMatrix(COLOR_GRADE_NEUTRAL)).toEqual([1,0,0,0,1,0,0,0,1]);
  expect(colorGradeMatrix({...COLOR_GRADE_NEUTRAL,exposure:1})).toEqual([2,0,0,0,2,0,0,0,2]);
  const warm=colorGradeMatrix({...COLOR_GRADE_NEUTRAL,temperature:1});
  expect([warm[0],warm[4],warm[8]].map(value=>Number(value!.toFixed(6)))).toEqual([1.1,1,0.9]);
  const mono=colorGradeMatrix({...COLOR_GRADE_NEUTRAL,saturation:0});
  for(const row of [0,1,2])expect(mono.slice(row*3,row*3+3)).toEqual([0.2126,0.7152,0.0722]);
  const plan=colorGradePlan(SOURCE,{...COLOR_GRADE_NEUTRAL,exposure:1});
  expect(plan.filter).toContain("colorchannelmixer=rr=2.000000:rg=0.000000:rb=0.000000:gr=0.000000:gg=2.000000");
  expect(plan.filter).toContain("lut3d=file=look.cube:interp=tetrahedral");
  // Packed 16-bit RGB: lutrgb on planar 16-bit RGB does not map a channel to itself in this ffmpeg.
  expect(plan.filter).toContain("format=rgb48le");
  const graph=colorGradeGraph(plan,{ceiling:"a.txt",floor:"b.txt"});
  expect(graph).toContain("[gradeceiling][cutceiling]blend=all_mode=subtract");
  expect(graph).toContain("[gradefloor][cutfloor]blend=all_mode=subtract");
  expect(()=>colorGradeGraph(plan,{ceiling:"../a.txt",floor:"b.txt"})).toThrow("plain file name");
  // The graded file is read back against the luma tolerance, as encoded.
  expect(colorGradeLevelsGraph({below:"c.txt",above:"d.txt"})).toBe("[0:v:0]split=2[low][high];[low]lutyuv=y='255*lt(val,14)',signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=c.txt[below];"
    +"[high]lutyuv=y='255*gt(val,241)',signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=d.txt[above]");
});

/**
 * A grade is a deliverable, bound to the cut's sealed output like every other. Its decision joins the
 * idempotency key, so the same decision on the same cut is one job and a changed decision is another;
 * and the keys of the kinds that existed before grades are exactly what they were, so a deliverable
 * retained before this increment still validates.
 */
test("the same decision on the same cut is the same deliverable, and a changed decision is a different one",()=>{
  const made=binding();
  const first=deliveryJobPlan(made,"grade",{...COLOR_GRADE_NEUTRAL,look:"warm"});
  expect(deliveryJobPlan(made,"grade",{...COLOR_GRADE_NEUTRAL,look:"warm"}).idempotencyKey).toBe(first.idempotencyKey);
  expect(deliveryJobPlan(made,"grade",{...COLOR_GRADE_NEUTRAL,look:"cool"}).idempotencyKey).not.toBe(first.idempotencyKey);
  expect(deliveryJobPlan(made,"grade",{...COLOR_GRADE_NEUTRAL,look:"warm",gain:1.01}).idempotencyKey).not.toBe(first.idempotencyKey);
  expect(deliveryJobPlan(binding(digest("f")),"grade",{...COLOR_GRADE_NEUTRAL,look:"warm"}).idempotencyKey).not.toBe(first.idempotencyKey);
  expect(first.grade!.source).toEqual({width:1280,height:720,frames:900});
  expect(validateDeliveryPlan(first)).toEqual(first);
  expect(()=>validateDeliveryPlan({...first,grade:colorGradePlan(SOURCE,{...COLOR_GRADE_NEUTRAL,look:"cool"})})).toThrow("does not match the film it names");
  expect(()=>validateDeliveryPlan({...first,grade:undefined})).toThrow("Describe the grade");
  expect(()=>deliveryJobPlan(made,"grade")).toThrow("Describe the grade");
  expect(()=>deliveryJobPlan(made,"mezzanine",COLOR_GRADE_NEUTRAL)).toThrow("Only a grade takes a colour decision");
  const mezzanine=deliveryJobPlan(made,"mezzanine");
  expect(()=>validateDeliveryPlan({...mezzanine,grade:first.grade})).toThrow("Only a grade takes a colour decision");
  // The older kinds keep the key they were admitted under.
  for(const kind of ["reframe-1:1","mezzanine"] as const)
    expect(deliveryJobPlan(made,kind).idempotencyKey).toBe(contentHash({schema:"hv-delivery-idempotency/1",outputRevision:made.source.outputRevision,kind}));
  expect("grade" in mezzanine).toBe(false);
  // Offered as the decision every grade starts from.
  const offer=deliveryOffers(made).find(value=>value.kind==="grade")!;
  expect(offer.available).toBe(true);
  expect(offer.plan!.grade!.decision).toEqual({...COLOR_GRADE_NEUTRAL});
});

/**
 * The looks are authored in this repository — no third-party LUT — and a grade is bound to their
 * bytes. The shipped `.cube` files, the functions that author them and the digests the library
 * records must all agree; each look keeps 0 at 0 and full scale at full scale and rises monotonically,
 * which is why a look cannot clip anything on its own.
 */
test("the studio's looks are the files it ships, authored here and bound by digest",()=>{
  expect(COLOR_LOOK_IDS).toEqual(["neutral-709","warm","cool","film-contrast"]);
  for(const id of COLOR_LOOK_IDS){
    const shipped=readFileSync(join(REPOSITORY,colorLookFile(id)));
    expect({id,text:shipped.toString("utf8")===colorLookCube(id)}).toEqual({id,text:true});
    expect({id,sha256:createHash("sha256").update(shipped).digest("hex"),bytes:shipped.length}).toEqual({id,sha256:COLOR_LOOKS[id].sha256,bytes:COLOR_LOOKS[id].bytes});
    const rows=colorLookCube(id).trim().split("\n").filter(line=>/^[\d.]+ [\d.]+ [\d.]+$/.test(line)).map(line=>line.split(" ").map(Number));
    expect(rows).toHaveLength(COLOR_LOOK_SIZE**3);
    expect(rows[0]).toEqual([0,0,0]);expect(rows.at(-1)).toEqual([1,1,1]);
    // Red runs fastest: along the first row of the cube, red rises and nothing else moves.
    const red=rows.slice(0,COLOR_LOOK_SIZE).map(row=>row[0]!);
    expect(red.every((value,index)=>index===0||value>red[index-1]!)).toBe(true);
    expect(rows.slice(1,COLOR_LOOK_SIZE-1).every(row=>row[0]!>0&&row[0]!<1&&row[1]===0&&row[2]===0)).toBe(true);
  }
  // Warm and cool pull the mids in opposite directions; neutral does not move them.
  const mid=(id:keyof typeof COLOR_LOOKS)=>COLOR_LOOKS[id].map(0.5,0.5,0.5);
  expect(mid("neutral-709")).toEqual([0.5,0.5,0.5]);
  expect(mid("warm")[0]).toBeGreaterThan(mid("warm")[2]);
  expect(mid("cool")[2]).toBeGreaterThan(mid("cool")[0]);
  expect(COLOR_LOOKS["film-contrast"].map(0.25,0.25,0.25)[0]).toBeLessThan(0.25);
  expect(COLOR_LOOKS["film-contrast"].map(0.75,0.75,0.75)[0]).toBeGreaterThan(0.75);
});

/**
 * The gate. A grade is withheld when more than five percent of its frames have one percent or more of
 * their pixels newly at 0 or full scale, or when any frame of the graded file has one percent or more of
 * its luma outside the 14–241 tolerance; each reason names the remedy. Less clipping than that is a
 * note, an extreme pixel past 16–235 on less than one percent of a frame is a note, and the grade is
 * offered.
 */
test("a grade that clips what the cut did not, or leaves the tolerance over a percent of a frame, is withheld with the remedy",()=>{
  const plan=colorGradePlan(SOURCE,COLOR_GRADE_NEUTRAL);
  const offered=colorGradeCheck(plan,FILE,clean,{lumaMin:16,lumaMax:235});
  expect({verdict:offered.verdict,findings:offered.findings}).toEqual({verdict:"offered",findings:[]});
  expect(offered.notChecked).toEqual(COLOR_GRADE_RECIPE.notChecked);
  expect(()=>assertColorGradeOffered(plan,offered)).not.toThrow();

  // Forty-five frames is five percent of nine hundred: a note. Forty-six is over it.
  const tally=(frames:number)=>({frames,worstShare:0.2,worstFrame:12});
  const glint=colorGradeCheck(plan,FILE,{...clean,ceiling:tally(45)},{lumaMin:16,lumaMax:235});
  expect(glint.verdict).toBe("offered");
  expect(glint.findings).toEqual([{code:"highlights-clipped",severity:"note",message:expect.stringContaining("within the 5% of the film it may")}]);
  const blown=colorGradeCheck(plan,FILE,{...clean,ceiling:tally(46)},{lumaMin:16,lumaMax:235});
  expect(blown.verdict).toBe("withheld");
  expect(blown.findings[0]!.message).toBe("This grade clips the highlights in 46 of 900 frames (up to 20% of frame 12) that the cut did not. Lower the gain or the exposure, and grade again.");
  expect(()=>assertColorGradeOffered(plan,blown)).toThrow("This grade is withheld: This grade clips the highlights in 46 of 900 frames");
  const crushed=colorGradeCheck(plan,FILE,{...clean,floor:tally(900)},{lumaMin:16,lumaMax:235});
  expect(crushed.findings.map(finding=>finding.code+":"+finding.severity)).toEqual(["blacks-crushed:withhold"]);
  expect(crushed.findings[0]!.message).toContain("Raise the lift");

  // Levels: a single frame with a percent of its picture past the tolerance withholds the grade.
  const over=colorGradeCheck(plan,FILE,{...clean,above:tally(1)},{lumaMin:16,lumaMax:250});
  expect(over.findings.map(finding=>finding.code+":"+finding.severity)).toEqual(["illegal-levels:withhold","levels-outside-nominal:note"]);
  expect(over.findings[0]!.message).toBe("The graded cut has 1% or more of its picture over 241, outside the broadcast tolerance, in 1 of 900 frames (up to 20% of frame 12). Lower the gain, and grade again.");
  expect(colorGradeCheck(plan,FILE,{...clean,below:tally(3)},{lumaMin:2,lumaMax:235}).findings[0]!.message).toContain("under 14");
  expect(colorGradeCheck(plan,FILE,{...clean,below:tally(3)},{lumaMin:2,lumaMax:235}).findings[0]!.message).toContain("Raise the lift");
  // An encode that rings past the nominal range on a few pixels of an edge is a note, not a refusal.
  const ringing=colorGradeCheck(plan,FILE,{...clean,below:{frames:0,worstShare:0.0004,worstFrame:7}},{lumaMin:3,lumaMax:244});
  expect(ringing.verdict).toBe("offered");
  expect(ringing.findings).toEqual([{code:"levels-outside-nominal",severity:"note",message:"The graded cut's luma reaches 3–244, past the nominal 16–235 on less than 1% of any frame."}]);
  // A reading nobody took is not a legal reading.
  expect(colorGradeCheck(plan,FILE,clean,{lumaMin:null,lumaMax:235}).findings.map(finding=>finding.code+":"+finding.severity)).toEqual(["levels-unmeasured:withhold"]);
  // A measurement that did not cover the cut is not a measurement of this grade.
  expect(()=>colorGradeCheck(plan,FILE,{...clean,framesMeasured:899},{lumaMin:16,lumaMax:235})).toThrow("measured over 899 frames and the cut has 900");
  expect(()=>colorGradeCheck(plan,FILE,{...clean,ceiling:{frames:1,worstShare:0,worstFrame:3}},{lumaMin:16,lumaMax:235})).toThrow("does not describe this cut");
  expect(()=>colorGradeCheck(plan,FILE,{...clean,above:{frames:901,worstShare:1,worstFrame:3}},{lumaMin:16,lumaMax:235})).toThrow("does not describe this cut");

  // A retained check is re-derived: a withheld grade edited to read "offered" is refused.
  expect(validateColorGradeCheck(plan,blown)).toEqual(blown);
  const forged={...blown,verdict:"offered" as const};
  expect(()=>validateColorGradeCheck(plan,{...forged,revision:contentHash({...forged,revision:undefined})})).toThrow("does not match its own measurement");
  expect(()=>assertColorGradeOffered(plan,{...blown,findings:[],verdict:"offered"})).toThrow("does not match its own measurement");
  expect(()=>validateColorGradeCheck(colorGradePlan(SOURCE,{...COLOR_GRADE_NEUTRAL,gain:1.1}),offered)).toThrow("does not match its own measurement");
});

/** The per-frame shares the render reads are reduced the same way every time, and a share outside 0–1 is refused. */
test("per-frame shares reduce to a count of frames over a percent and the worst one",()=>{
  expect(colorGradeTally([0,0.009,0.01,0.5,0.02])).toEqual({frames:3,worstShare:0.5,worstFrame:3});
  expect(colorGradeTally([0,0,0])).toEqual({frames:0,worstShare:0,worstFrame:null});
  expect(()=>colorGradeTally([0,1.2])).toThrow("not a fraction of a frame");
  expect(()=>colorGradeTally([Number.NaN])).toThrow("not a fraction of a frame");
});
