/**
 * HV-026-07 — a grade rendered with ffmpeg, and measured as it is made.
 *
 * The cut here is a 640x360 test pattern with a tone under it, encoded the way the studio's masters
 * are. Each test grades it for real and reads the result back: what the grade clipped that the cut
 * had not, what the picture quality check reads from the graded file, and whether the look was
 * actually applied.
 */
import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {COLOR_GRADE_NEUTRAL,colorGradeCheck,colorGradePlan,type ColorGradeDecision} from "../../planner/src/color-grade";
import {renderColorGrade} from "../src/color-grade";
import {measurePictureQc} from "../src/picture-qc";

const root=mkdtempSync(join(tmpdir(),"hv-color-grade-"));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const access=async()=>{};
const FRAMES=30;
async function run(args:string[]):Promise<string>{
  const child=Bun.spawn(args,{cwd:root,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  const [out,log,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({code,log}).toEqual({code:0,log:""});
  return out;
}
let cut:Promise<string>|undefined;
/** One cut for the whole file: a second of `testsrc2` over a tone, limited range, H.264 and AAC. */
const master=()=>cut??=(async()=>{
  const path=join(root,"cut.mp4");
  await run(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i","testsrc2=size=640x360:rate=30:duration=1","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=1",
    "-map","0:v:0","-map","1:a:0","-vf","scale=in_range=full:out_range=limited","-c:v","libx264","-pix_fmt","yuv420p","-r","30","-c:a","aac","-ac","2","-t","1","-y",path]);
  return path;
})();
async function grade(name:string,change:Partial<ColorGradeDecision>){
  const plan=colorGradePlan({width:640,height:360,frames:FRAMES},{...COLOR_GRADE_NEUTRAL,...change});
  const destination=join(root,name+".mp4");
  const result=await renderColorGrade(await master(),plan,destination,root,access);
  const quality=await measurePictureQc(destination,root,access);
  const check=colorGradeCheck(plan,quality.source,result.measurement,{lumaMin:quality.picture.lumaMin,lumaMax:quality.picture.lumaMax});
  return {plan,result,quality,check,destination};
}
/** Mean Cb and Cr of the first frame: where warm and cool have to show. */
async function chroma(path:string):Promise<{u:number;v:number}>{
  const text=await run(["ffmpeg","-v","error","-nostdin","-i",path,"-frames:v","1","-vf","signalstats,metadata=print:file=-","-f","null","-"]);
  const read=(key:string)=>Number(new RegExp("lavfi\\.signalstats\\."+key+"=([\\d.]+)").exec(text)?.[1]);
  return {u:read("UAVG"),v:read("VAVG")};
}

/**
 * The decision that changes nothing is the control for every other test here: it clips nothing that
 * the cut had not, keeps the cut's size, length and soundtrack, and is offered.
 */
test("a neutral grade clips nothing the cut did not, keeps the cut's shape and soundtrack, and is offered",async()=>{
  const {result,quality,check}=await grade("neutral",{});
  expect(result.measurement).toMatchObject({framesMeasured:FRAMES,ceiling:{frames:0},floor:{frames:0},below:{frames:0},above:{frames:0}});
  expect(result.measurement.ceiling.worstShare).toBeLessThan(0.001);
  expect(result.delivered).toMatchObject({width:640,height:360,video:"h264",audio:"aac"});
  expect(Math.abs(result.delivered.durationSec-1)).toBeLessThan(0.1);
  expect(result.file.sha256).toBe(quality.source.sha256);
  // The pattern's hard edges ring a few codes past the nominal range after the encode -- as the cut's
  // own do -- on far less than a percent of any frame, which is a note and not a refusal.
  expect(result.measurement.below.worstShare).toBeLessThan(0.01);
  expect(quality.sound).not.toBeNull();
  expect(check.verdict).toBe("offered");
  expect(check.findings.filter(finding=>finding.severity==="withhold")).toEqual([]);
},120_000);

/**
 * A gain pushed until the pattern's colours leave the RGB cube: nearly every pixel has a channel at
 * full scale that the cut did not, on every frame, and the graded file's luma leaves the tolerance.
 * The grade is withheld and says what to do about it.
 */
test("a gain pushed past the cube clips the highlights the cut did not have, and the grade is withheld",async()=>{
  const {result,quality,check}=await grade("hot",{gain:1.6});
  expect(result.measurement.ceiling.frames).toBe(FRAMES);
  expect(result.measurement.ceiling.worstShare).toBeGreaterThan(0.5);
  expect(result.measurement.floor.frames).toBe(0);
  expect(quality.picture.lumaMax).toBeGreaterThan(235);
  expect(check.verdict).toBe("withheld");
  expect(check.findings.find(finding=>finding.code==="highlights-clipped")).toMatchObject({severity:"withhold",message:expect.stringContaining("Lower the gain or the exposure")});
},120_000);

/** Lift pulled down and contrast up: the shadows go to 0, and that is counted as its own finding. */
test("a lift pulled under black crushes the blacks, and that is its own finding",async()=>{
  const {result,check}=await grade("crushed",{lift:-0.2,contrast:1.5});
  expect(result.measurement.floor.frames).toBe(FRAMES);
  expect(check.findings.map(finding=>finding.code)).toContain("blacks-crushed");
  expect(check.verdict).toBe("withheld");
},120_000);

/**
 * The look is really applied: warm moves the picture toward red (Cr up, Cb down) and cool the other
 * way (Cb up, Cr down), against the neutral grade of the same cut — and neither clips anything, because a look keeps
 * its ends.
 */
test("the warm and cool looks move the picture in opposite directions and clip nothing",async()=>{
  const neutral=await chroma((await grade("neutral-look",{})).destination);
  const warm=await grade("warm",{look:"warm"}),cool=await grade("cool",{look:"cool"});
  const [w,c]=[await chroma(warm.destination),await chroma(cool.destination)];
  // Averaged over a saturated test pattern the shift is small, and deterministic: warm is redder and
  // less blue than neutral, cool the reverse, and the two are well apart.
  expect(w.v).toBeGreaterThan(neutral.v);expect(w.u).toBeLessThan(neutral.u-1);
  expect(c.v).toBeLessThan(neutral.v-0.5);expect(c.u).toBeGreaterThan(neutral.u+0.5);
  expect(w.v-c.v).toBeGreaterThan(0.5);expect(c.u-w.u).toBeGreaterThan(1.5);
  for(const look of [warm,cool]){
    expect(look.result.measurement.ceiling.frames+look.result.measurement.floor.frames).toBe(0);
    expect({look:look.plan.look.id,findings:look.check.findings.filter(finding=>finding.severity==="withhold")}).toEqual({look:look.plan.look.id,findings:[]});
  }
  expect(warm.plan.look.id).toBe("warm");
  expect(warm.result.plan.revision).not.toBe(cool.result.plan.revision);
},180_000);

/** A grade decided for another cut is refused before anything is encoded, and nothing is left behind. */
test("a grade decided for another cut is refused before anything is encoded",async()=>{
  const plan=colorGradePlan({width:1280,height:720,frames:FRAMES},COLOR_GRADE_NEUTRAL);
  const destination=join(root,"mismatch.mp4");
  await expect(renderColorGrade(await master(),plan,destination,root,access)).rejects.toThrow("decided for a 1280 by 720 cut and this one is 640 by 360");
  expect(await Bun.file(destination).exists()).toBe(false);
  expect(await Bun.file(join(root,"look.cube")).exists()).toBe(false);
},60_000);
