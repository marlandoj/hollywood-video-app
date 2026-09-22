import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PICTURE_QC_RECIPE,pictureQcFindings,pictureQcReport,validatePictureQcReport,type PictureQcMeasurement} from "../../planner/src/picture-qc";
import {measurePictureQc} from "../src/picture-qc";

const root=mkdtempSync(join(tmpdir(),"hv-picture-qc-"));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const access=async()=>{};
async function media(name:string,args:string[]):Promise<string>{
  const path=join(root,name);
  const child=Bun.spawn(["ffmpeg","-v","error","-nostdin",...args,"-y",path],{cwd:root,stdin:"ignore",stdout:"ignore",stderr:"pipe"});
  const log=await new Response(child.stderr).text();
  expect({name,code:await child.exited,log}).toEqual({name,code:0,log:""});
  return path;
}
const measurement=(overrides:Partial<PictureQcMeasurement>={}):PictureQcMeasurement=>({
  programme:{durationSec:14,width:1280,height:720,frameRate:"30/1",pixelFormat:"yuv420p",video:"h264",audio:"aac",channels:2,sampleRate:48000,bytes:548271},
  picture:{blackSpans:[],freezeSpans:[],lumaMin:16,lumaMax:235,framesSampled:420},
  sound:{meanVolumeDb:-29.7,maxVolumeDb:-3.4},
  ...overrides});
const codes=(m:PictureQcMeasurement)=>pictureQcFindings(m).map(finding=>finding.code+":"+finding.severity);

test("a finished film passes, and each thing that can be measured has its own finding and severity",()=>{
  expect(codes(measurement())).toEqual([]);
  expect(pictureQcReport(measurement(),{sha256:"a".repeat(64),bytes:548271},"ffmpeg-sound-test").verdict).toBe("pass");
  // Failures: the film cannot be delivered as it is.
  expect(codes(measurement({programme:{...measurement().programme,audio:null,channels:null,sampleRate:null}}))).toEqual(["audio-missing:fail"]);
  expect(codes(measurement({sound:{meanVolumeDb:null,maxVolumeDb:null}}))).toEqual(["silent-programme:fail"]);
  expect(codes(measurement({sound:{meanVolumeDb:-20,maxVolumeDb:0}}))).toEqual(["clipping:fail"]);
  // Warnings: measured, and a person has to look.
  expect(codes(measurement({sound:{meanVolumeDb:-48,maxVolumeDb:-20}}))).toEqual(["quiet-programme:warning"]);
  expect(codes(measurement({sound:{meanVolumeDb:-6,maxVolumeDb:-1}}))).toEqual(["loud-programme:warning"]);
  expect(codes(measurement({picture:{...measurement().picture,blackSpans:[{fromSec:2,toSec:4.5}]}}))).toEqual(["black-picture:warning"]);
  expect(codes(measurement({picture:{...measurement().picture,freezeSpans:[{fromSec:0,toSec:3}]}}))).toEqual(["frozen-picture:warning"]);
  expect(codes(measurement({picture:{...measurement().picture,lumaMin:4}}))).toEqual(["illegal-levels:warning"]);
  expect(codes(measurement({picture:{...measurement().picture,lumaMax:255}}))).toEqual(["illegal-levels:warning"]);
  // Notes: worth saying, and not a reason to stop.
  const noted=measurement({programme:{...measurement().programme,frameRate:"25/1",pixelFormat:"yuv422p"}});
  expect(codes(noted)).toEqual(["unexpected-frame-rate:note","unexpected-pixel-format:note"]);
  expect(pictureQcReport(noted,{sha256:"a".repeat(64),bytes:1},"ffmpeg-sound-test").verdict).toBe("pass");
  expect(codes(measurement({picture:{...measurement().picture,lumaMin:null,lumaMax:null,framesSampled:0}}))).toEqual(["levels-unmeasured:note"]);
  // A finding names what it measured, and the report names what nobody looked at.
  const black=pictureQcFindings(measurement({picture:{...measurement().picture,blackSpans:[{fromSec:2,toSec:4.5}]}}))[0]!;
  expect(black.message).toContain("2–4.5 s");expect(black.spans).toEqual([{fromSec:2,toSec:4.5}]);
  expect(PICTURE_QC_RECIPE.notChecked.join(" ")).toContain("safe area");
  expect(pictureQcReport(measurement(),{sha256:"a".repeat(64),bytes:1},"ffmpeg-sound-test").notChecked).toEqual(PICTURE_QC_RECIPE.notChecked);
});

test("a retained report is re-derived from its own measurement rather than trusted",()=>{
  const report=pictureQcReport(measurement(),{sha256:"a".repeat(64),bytes:548271},"ffmpeg-sound-test");
  expect(validatePictureQcReport(report)).toEqual(report);
  // A report cannot be talked out of its own findings: they are re-derived from the measurement.
  const flagged=pictureQcReport(measurement({sound:{meanVolumeDb:-20,maxVolumeDb:0}}),{sha256:"a".repeat(64),bytes:1},"ffmpeg-sound-test");
  expect(flagged.verdict).toBe("review");
  expect(()=>validatePictureQcReport({...flagged,verdict:"pass",findings:[]})).toThrow("does not match its own measurement");
  expect(()=>validatePictureQcReport({...report,sound:{meanVolumeDb:-20,maxVolumeDb:-3}})).toThrow("does not match its own measurement");
  expect(()=>validatePictureQcReport({...report,recipeRevision:"0".repeat(64)})).toThrow("another recipe");
  expect(pictureQcReport(measurement(),{sha256:"a".repeat(64),bytes:548271},"ffmpeg-sound-test").revision).toBe(report.revision);
});

test("the check measures a real film, and finds a black, frozen, near-silent one",async()=>{
  const good=await media("good.mp4",["-f","lavfi","-i","testsrc2=size=320x240:rate=30:duration=3","-f","lavfi","-i",
    "sine=frequency=440:sample_rate=48000:duration=3","-map","0:v:0","-map","1:a:0","-vf","scale=in_range=full:out_range=limited",
    "-c:v","libx264","-pix_fmt","yuv420p","-r","30","-c:a","aac","-t","3"]);
  const report=await measurePictureQc(good,root,access);
  expect(report.schema).toBe("hv-picture-qc/1");
  expect(report.programme).toMatchObject({width:320,height:240,frameRate:"30/1",pixelFormat:"yuv420p",video:"h264",audio:"aac",channels:1,sampleRate:48000});
  expect(report.picture.framesSampled).toBe(90);
  expect(report.picture.blackSpans).toEqual([]);expect(report.picture.freezeSpans).toEqual([]);
  // The levels the release evidence has been recording by hand now come from code.
  expect(report.sound.meanVolumeDb).toBeLessThan(0);expect(report.sound.maxVolumeDb).toBeLessThan(0);
  expect(report.findings.filter(finding=>finding.severity!=="note")).toEqual([]);
  expect(report.verdict).toBe("pass");
  // Measuring changes nothing, so the same file measures the same way.
  const again=await measurePictureQc(good,root,access);
  expect(again.revision).toBe(report.revision);

  const bad=await media("bad.mp4",["-f","lavfi","-i","color=c=black:s=320x240:r=30:d=3","-f","lavfi","-i",
    "anullsrc=sample_rate=48000:channel_layout=mono","-map","0:v:0","-map","1:a:0","-c:v","libx264","-pix_fmt","yuv420p","-r","30","-c:a","aac","-t","3"]);
  const flagged=await measurePictureQc(bad,root,access);
  expect(flagged.verdict).toBe("review");
  const found=flagged.findings.map(finding=>finding.code);
  expect(found).toContain("black-picture");expect(found).toContain("frozen-picture");
  expect(flagged.picture.blackSpans[0]!.fromSec).toBe(0);
  expect(flagged.picture.blackSpans[0]!.toSec).toBeGreaterThan(2);
  // A freeze that runs to the end of the programme is closed at its duration, not left open.
  expect(flagged.picture.freezeSpans[0]!.toSec).toBeCloseTo(flagged.programme.durationSec,1);
  expect(found.some(code=>["quiet-programme","silent-programme"].includes(code))).toBe(true);
  expect(flagged.source.sha256).toMatch(/^[a-f0-9]{64}$/);
},60_000);
