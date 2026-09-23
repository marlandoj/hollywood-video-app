/**
 * HV-026-06 — the quality check measured every film's luma range as nothing at all.
 *
 * HV-026-04 replaced `Math.min(...values)` with a reduction, because a spread over a million
 * per-frame values overflows the call stack. It reduced with the function itself:
 *
 *     values.reduce(Math.min)
 *
 * `reduce` hands its callback four arguments, and the fourth is the array. `Math.min(11, 20, 1,
 * [11, 20, 30])` coerces that array and answers `NaN`, so every film of more than one frame came
 * back with `lumaMin: NaN, lumaMax: NaN` — a single-frame film was the only survivor, because
 * `reduce` skips the callback entirely for one element.
 *
 * Nothing said so. `NaN` is a `number`, so the type held; `NaN < 16` and `NaN > 235` are both false,
 * so `illegal-levels` could not fire; `levels-unmeasured` is keyed to `framesSampled`, which was the
 * film's real frame count, so the report did not even say the levels went unjudged; and
 * `JSON.stringify(NaN)` is `null`, so the stored report looked like a film whose meter never ran.
 * A stack overflow became a silent wrong answer, which is the worse of the two.
 *
 * So there are two claims here: the range is measured, and a range that is not a number is refused
 * rather than reported.
 */
import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PICTURE_QC_RECIPE,pictureQcFindings,pictureQcReport,validatePictureQcReport,type PictureQcMeasurement} from "../../planner/src/picture-qc";
import {measurePictureQc} from "../src/picture-qc";

const root=mkdtempSync(join(tmpdir(),"hv-picture-qc-levels-"));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const access=async()=>{};

async function media(name:string,args:string[]):Promise<string>{
  const path=join(root,name);
  const child=Bun.spawn(["ffmpeg","-v","error","-nostdin",...args,"-y",path],{cwd:root,stdin:"ignore",stdout:"ignore",stderr:"pipe"});
  const log=await new Response(child.stderr).text();
  expect({name,code:await child.exited,log}).toEqual({name,code:0,log:""});
  return path;
}
const sound=["-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=2","-map","0:v:0","-map","1:a:0",
  "-c:v","libx264","-pix_fmt","yuv420p","-r","30","-c:a","aac","-t","2"];

test("a film of more than one frame has its luma range read, and the range is a pair of numbers",async()=>{
  // The whole defect in one assertion: sixty frames go in and two numbers must come out. Before
  // this, sixty frames went in and `NaN` came out of both ends of the range.
  const path=await media("levels.mp4",["-f","lavfi","-i","testsrc2=size=320x240:rate=30:duration=2",...sound]);
  const report=await measurePictureQc(path,root,access);
  expect(report.picture.framesSampled).toBe(60);
  expect({min:Number.isInteger(report.picture.lumaMin),max:Number.isInteger(report.picture.lumaMax)}).toEqual({min:true,max:true});
  expect(report.picture.lumaMin!).toBeLessThanOrEqual(report.picture.lumaMax!);
  expect(report.picture.lumaMin!).toBeGreaterThanOrEqual(0);
  expect(report.picture.lumaMax!).toBeLessThanOrEqual(255);
  // And the reading survives being written down: `NaN` did not, which is how a report of a film
  // nobody measured and a report of a film whose meter never ran came to look the same.
  const written=JSON.parse(JSON.stringify(report));
  expect(written.picture.lumaMin).toBe(report.picture.lumaMin);
  expect(validatePictureQcReport(written)).toEqual(report);
},120_000);

test("and a film whose levels leave the limited range is said so, which is what this check is for",async()=>{
  // `testsrc2` is full-range, and every other film in these tests is encoded through
  // `scale=in_range=full:out_range=limited`, which is why nothing noticed: the one clip that would
  // have shown the defect was the one the suite was careful never to make.
  const path=await media("full-range.mp4",["-f","lavfi","-i","testsrc2=size=320x240:rate=30:duration=2",...sound]);
  const report=await measurePictureQc(path,root,access);
  const illegal=report.findings.find(finding=>finding.code==="illegal-levels");
  expect(illegal?.severity).toBe("warning");
  expect(illegal!.message).toContain(String(PICTURE_QC_RECIPE.thresholds.lumaFloor));
  expect(illegal!.message).not.toContain("NaN");
  expect(illegal!.message).not.toContain("null");
  expect(report.verdict).toBe("review");
  // The same film, carried into the limited range on the way out, has nothing said about its levels.
  const conformed=await media("limited-range.mp4",["-f","lavfi","-i","testsrc2=size=320x240:rate=30:duration=2",
    "-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=2","-map","0:v:0","-map","1:a:0",
    "-vf","scale=in_range=full:out_range=limited","-c:v","libx264","-pix_fmt","yuv420p","-r","30","-c:a","aac","-t","2"]);
  const clean=await measurePictureQc(conformed,root,access);
  expect(clean.findings.map(finding=>finding.code)).not.toContain("illegal-levels");
  expect(clean.picture.lumaMin!).toBeGreaterThanOrEqual(PICTURE_QC_RECIPE.thresholds.lumaFloor);
  expect(clean.picture.lumaMax!).toBeLessThanOrEqual(PICTURE_QC_RECIPE.thresholds.lumaCeiling);
},120_000);

test("and a luma reading that is not a number is refused rather than reported",()=>{
  // The guard on the defect rather than on the one line that caused it. `NaN` is a `number`, so this
  // is the only place that can tell the difference between a range and the absence of one.
  const base:PictureQcMeasurement={
    programme:{durationSec:2,width:320,height:240,frameRate:"30/1",pixelFormat:"yuv420p",video:"h264",audio:"aac",channels:1,sampleRate:48000,bytes:1},
    picture:{blackSpans:[],freezeSpans:[],lumaMin:16,lumaMax:235,framesSampled:60},
    sound:{meanVolumeDb:-20,maxVolumeDb:-3}};
  const with_=(picture:Partial<PictureQcMeasurement["picture"]>)=>({...base,picture:{...base.picture,...picture}});
  for (const [name,broken] of [["lumaMin",with_({lumaMin:Number.NaN})],["lumaMax",with_({lumaMax:Number.NaN})],
    ["lumaMin",with_({lumaMin:Number.POSITIVE_INFINITY})]] as const) {
    expect(()=>pictureQcFindings(broken)).toThrow(name+" is not a number");
    expect(()=>pictureQcReport(broken,{sha256:"a".repeat(64),bytes:1},"ffmpeg-levels-test")).toThrow("never read");
  }
  // A reading that is simply absent is a different fact and stays allowed: the two statistics are
  // printed separately and one can be empty while the other is not.
  expect(pictureQcFindings(with_({lumaMin:null,lumaMax:null,framesSampled:0})).map(finding=>finding.code)).toEqual(["levels-unmeasured"]);
  expect(pictureQcFindings(with_({lumaMin:null,lumaMax:255,framesSampled:3}))[0]!.code).toBe("illegal-levels");
  expect(pictureQcFindings(base)).toEqual([]);
});

test("and the reduction cannot be written the way that caused this again",()=>{
  // `values.reduce(Math.min)` is the whole defect, and it reads correctly. The shape is what has to
  // be refused, so it is refused by name here rather than left to whoever reads it next.
  // The comments are stripped first, because the defect is named in one of them.
  const source=readFileSync(new URL("../src/picture-qc.ts",import.meta.url),"utf8");
  const code=source.replaceAll(/\/\*[\s\S]*?\*\//g,"").replaceAll(/^\s*\/\/.*$/gm,"");
  expect(code).not.toMatch(/\.reduce\(\s*Math\.\w+\s*\)/);
  expect(code).not.toMatch(/\.(map|filter|reduce|forEach|some|every)\(\s*(?:Math\.\w+|Number|parseInt)\s*\)/);
  // What it does instead: the reducer takes the two arguments it is meant to take, and nothing else.
  expect(source).toContain("values.reduce((best,value)=>pick(best,value))");
  // And the reason is written down where it happened, because the line is correct-looking.
  expect(source).toContain("hands its callback four arguments");
});
