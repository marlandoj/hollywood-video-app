import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PICTURE_QC_RECIPE,pictureQcFindings,pictureQcReport,validatePictureQcReport,type PictureQcMeasurement} from "../../planner/src/picture-qc";
import {measurePictureQc,readDetectors} from "../src/picture-qc";

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
  // The levels the release evidence has been recording by hand now come from code. A measured film
  // carries a reading; null here would mean the meter never ran, which is a different report.
  expect(report.sound).not.toBeNull();
  expect(report.sound!.meanVolumeDb).toBeLessThan(0);expect(report.sound!.maxVolumeDb).toBeLessThan(0);
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

test("HV-026-04: a soundtrack nobody metered is reported as unmeasured, never as silence",()=>{
  // Silence that was measured is a failure a film cannot be delivered with. A reading that was never
  // taken is a note -- and it no longer stands in for the clipping check it used to disable.
  expect(codes(measurement({sound:null}))).toEqual(["sound-unmeasured:note"]);
  expect(pictureQcReport(measurement({sound:null}),{sha256:"a".repeat(64),bytes:1},"ffmpeg-sound-test").verdict).toBe("pass");
  expect(codes(measurement({sound:{meanVolumeDb:null,maxVolumeDb:null}}))).toEqual(["silent-programme:fail"]);
  // A film with no audio stream says so once, by the stream, rather than twice.
  expect(codes(measurement({programme:{...measurement().programme,audio:null,channels:null,sampleRate:null},sound:null}))).toEqual(["audio-missing:fail"]);
  // The level findings are still judged whenever there is a reading to judge.
  expect(codes(measurement({sound:{meanVolumeDb:-48,maxVolumeDb:0}}))).toEqual(["clipping:fail","quiet-programme:warning"]);
  // And a retained report cannot swap a reading for none: the findings are re-derived from it.
  const report=pictureQcReport(measurement(),{sha256:"a".repeat(64),bytes:1},"ffmpeg-sound-test");
  expect(()=>validatePictureQcReport({...report,sound:null})).toThrow("does not match its own measurement");
  expect(validatePictureQcReport(pictureQcReport(measurement({sound:null}),{sha256:"a".repeat(64),bytes:1},"ffmpeg-sound-test")).sound).toBeNull();
});

test("HV-026-04: a finding names only the readings that were taken",()=>{
  // YMIN and YMAX are two separate per-frame statistics and one can be empty while the other is not.
  // The message used to read "Luma reaches null–253" in a delivery report.
  const capped=pictureQcFindings(measurement({picture:{...measurement().picture,lumaMin:null,lumaMax:255,framesSampled:3}}));
  expect(capped.map(finding=>finding.code)).toEqual(["illegal-levels"]);
  expect(capped[0]!.message).toContain("a maximum of 255");expect(capped[0]!.message).not.toContain("null");
  const floored=pictureQcFindings(measurement({picture:{...measurement().picture,lumaMin:4,lumaMax:null,framesSampled:3}}));
  expect(floored[0]!.message).toContain("a minimum of 4");expect(floored[0]!.message).not.toContain("null");
  expect(pictureQcFindings(measurement({picture:{...measurement().picture,lumaMin:4}}))[0]!.message).toContain("4–235");
});

test("HV-026-04: the log is read only where the detectors wrote it, and a pairing it cannot make is refused",()=>{
  const line=(name:string,text:string)=>"["+name+" @ 0x55f0a1] "+text;
  const black=line("blackdetect","black_start:1.0 black_end:2.0 black_duration:1"),freeze=line("freezedetect","freeze_start: 4.5");
  const metered=[line("Parsed_volumedetect_0","mean_volume: -29.7 dB"),line("Parsed_volumedetect_0","max_volume: -3.4 dB")];
  const log=[black,freeze,...metered].join("\n");
  expect(readDetectors(log,14,true)).toEqual({blackSpans:[{fromSec:1,toSec:2}],freezeSpans:[{fromSec:4.5,toSec:14}],
    sound:{meanVolumeDb:-29.7,maxVolumeDb:-3.4}});
  // The film's own name and metadata tags are in the same log. A title reading "black_start:0.0" is
  // not a defect, and a delivery report must not carry a span nothing detected.
  expect(readDetectors(log+"\n    title           : black_start:0.0 freeze_start: 0.0\n    comment         : mean_volume: 0.0 dB",14,true)).toEqual(readDetectors(log,14,true));
  // Zipping by index would shift every later pair and drop the mismatched tail: a quality check
  // reporting fewer defects than it found. The list is refused instead.
  expect(()=>readDetectors(line("blackdetect","black_end:2.0"),14,true)).toThrow("cannot be paired");
  expect(()=>readDetectors(line("blackdetect","black_start:5.0 black_end:1.0"),14,true)).toThrow("does not run forwards");
  // volumedetect prints both lines or neither: neither is "not measured", one is a broken log.
  expect(readDetectors(black,14,true).sound).toBeNull();
  expect(readDetectors(log,14,false).sound).toBeNull();
  expect(()=>readDetectors(metered[0]!,14,true)).toThrow("mean with no peak");
  expect(()=>readDetectors(metered[1]!,14,true)).toThrow("peak with no mean");
  expect(()=>readDetectors([line("Parsed_volumedetect_0","mean_volume: bananas dB"),metered[1]!].join("\n"),14,true)).toThrow("invalid value");
  // Measured silence still measures as silence.
  expect(readDetectors([line("Parsed_volumedetect_0","mean_volume: -inf dB"),line("Parsed_volumedetect_0","max_volume: -inf dB")].join("\n"),14,true).sound)
    .toEqual({meanVolumeDb:null,maxVolumeDb:null});
});

test("HV-026-04: a refused check leaves nothing beside the film",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"hv-picture-qc-scratch-"));
  try{
    const notAFilm=join(directory,"notes.txt");writeFileSync(notAFilm,"this is not a film\n");
    expect(await measurePictureQc(notAFilm,directory,access).then(()=>"measured",error=>(error as Error).name)).not.toBe("measured");
    // The scratch was removed on the way past, so any refusal left three files in the caller's
    // directory -- which is often the directory the film is in -- and the next run read them.
    expect(readdirSync(directory)).toEqual(["notes.txt"]);
  }finally{rmSync(directory,{recursive:true,force:true});}
},30_000);
