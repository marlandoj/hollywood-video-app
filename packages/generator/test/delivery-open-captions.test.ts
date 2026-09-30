/**
 * HV-027-15 — the burn itself: the film's own caption track, read strictly, made inert, drawn into
 * the delivered frame, and measured on its own before the deliverable is accepted.
 */
import {afterAll,expect,test} from "bun:test";
import {existsSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {deliveryOpenCaptionsPlan} from "../../planner/src/delivery-captions";
import {openCaptionCentiseconds,openCaptionFrame,openCaptionText,parseSealedCaptions,renderDeliveryOpenCaptions} from "../src/delivery-captions";

const root=mkdtempSync(join(tmpdir(),"hv-delivery-open-captions-"));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const access=async()=>{};
const PATH="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb/export/conform/captions.vtt";
async function master(size:string,seconds:number):Promise<string>{
  const path=join(root,"master-"+size+".mp4");
  const child=Bun.spawn(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i","testsrc2=size="+size+":rate=30:duration="+seconds,
    "-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration="+seconds,"-map","0:v:0","-map","1:a:0",
    "-c:v","libx264","-pix_fmt","yuv420p","-r","30","-c:a","aac","-ac","2","-t",String(seconds),"-y",path],{cwd:root,stdin:"ignore",stdout:"ignore",stderr:"pipe"});
  const log=await new Response(child.stderr).text();
  expect({code:await child.exited,log}).toEqual({code:0,log:""});
  return path;
}
/** A caption track exactly as the conform writes one, and the plan that names it. */
function track(name:string,vtt:string,cues:number,output={width:640,height:360},crop:string|null=null){
  const path=join(root,name+".vtt");writeFileSync(path,vtt);
  const plan=deliveryOpenCaptionsPlan({path:PATH,sha256:createHash("sha256").update(vtt).digest("hex"),bytes:Buffer.byteLength(vtt),cues},
    crop?"1:1":"master",output,crop);
  return {path,plan};
}
const work=(name:string)=>mkdtempSync(join(root,name+"-"));

test("the sealed track is read exactly as the conform writes it, and nothing else is read as one",()=>{
  const vtt="WEBVTT\n\na\n00:00:00.000 --> 00:00:01.172\nSPUD: Fish &amp; chips &lt;now&gt;\nplease.\n\nb\n01:02:03.004 --> 01:02:04.005\nOne.\n";
  expect(parseSealedCaptions(vtt)).toEqual([{id:"a",startMs:0,endMs:1172,text:"SPUD: Fish & chips <now>\nplease."},{id:"b",startMs:3723004,endMs:3724005,text:"One."}]);
  expect(parseSealedCaptions("WEBVTT\n\n")).toEqual([]);
  expect(()=>parseSealedCaptions("1\n00:00:00.000 --> 00:00:01.000\nx\n")).toThrow("not the WebVTT its conform writes");
  expect(()=>parseSealedCaptions("WEBVTT\n\na\n00:00:00.000 -> 00:00:01.000\nx\n")).toThrow("Caption cue 1");
  expect(()=>parseSealedCaptions("WEBVTT\n\na\n00:00:02.000 --> 00:00:01.000\nx\n")).toThrow("ends before it starts");
  expect(()=>parseSealedCaptions("WEBVTT\n\na\n00:00:00.000 --> 00:00:01.000\nx")).toThrow("ends inside a cue");
  // A cue is never shown later or ended sooner than the film's own: start floored, end ceiled.
  expect(openCaptionCentiseconds({id:"a",startMs:1179,endMs:2751,text:""})).toEqual({start:117,end:276});
  // A cue too short to land on any frame of a 30 fps picture is said to be, rather than sampled.
  expect(openCaptionFrame({id:"a",startMs:1010,endMs:1020,text:""})).toBeNull();
  expect(openCaptionFrame({id:"a",startMs:0,endMs:1172,text:""})).toBe(17);
  // Words are literal: no brace opens an override and no backslash combines with the letter after it.
  expect(openCaptionText("{\\an8}a\\Nb\nc")).toBe("\\{\\⁠an8\\}a\\⁠Nb\\Nc");
});

test("the film's own captions are burned into the frame, and a line of dialogue cannot restyle them",async()=>{
  const film=await master("640x360",3);
  // The second cue is dialogue that happens to look like libass override codes. Were it trusted, the
  // text would jump to the top of the frame (\an8) and break onto a second line (\N).
  const vtt="WEBVTT\n\na\n00:00:00.000 --> 00:00:01.000\nSPUD: Welcome to the garden.\n\nb\n00:00:01.500 --> 00:00:02.500\n{\\an8}TOP \\N OF IT\n\nc\n00:00:02.610 --> 00:00:02.620\nA blink.\n";
  const {path,plan}=track("burn",vtt,3),directory=work("burn"),destination=join(root,"burned.mp4");
  const result=await renderDeliveryOpenCaptions(film,path,plan,{width:640,height:360,durationSec:3},destination,directory,access);
  expect(result.delivered).toMatchObject({width:640,height:360,video:"h264",audio:"aac"});
  expect(result.check).toMatchObject({cues:3,betweenFrames:1,frame:{width:640,height:360}});
  expect(result.check.sampled.map(sample=>sample.cue)).toEqual([0,1]);
  const [welcome,override]=result.check.sampled;
  for(const sample of [welcome!,override!]){expect(sample.ink).toBeGreaterThan(100);expect(sample.box.y0).toBeGreaterThan(180);}
  // One line, at the bottom, like its neighbour: the override did nothing.
  expect(override!.box.y1-override!.box.y0).toBeLessThan(plan.style.fontSize*1.2);
  expect(Math.abs(override!.box.y1-welcome!.box.y1)).toBeLessThanOrEqual(plan.style.fontSize/2);
});

test("a caption that runs off the frame is refused, quoting it, and a track that is not the plan's is refused before anything is encoded",async()=>{
  const film=await master("640x360",2);
  // One unbroken word wider than a 360-pixel square: libass does not break words, so it runs off both edges.
  const wide="WEBVTT\n\na\n00:00:00.000 --> 00:00:01.000\n"+"W".repeat(42)+"\n";
  const {path,plan}=track("wide",wide,1,{width:360,height:360},"crop=360:360:140:0,setsar=1");
  await expect(renderDeliveryOpenCaptions(film,path,plan,{width:640,height:360,durationSec:2},join(root,"wide.mp4"),work("wide"),access))
    .rejects.toThrow(/Caption cue 1 runs off the edge of the 360 by 360 frame\. It reads: "W{42}"/);
  // The plan names one track's digest; given another, nothing is encoded.
  const other=track("other","WEBVTT\n\na\n00:00:00.000 --> 00:00:01.000\nOther words.\n",1);
  const destination=join(root,"never.mp4");
  await expect(renderDeliveryOpenCaptions(film,other.path,plan,{width:640,height:360,durationSec:2},destination,work("never"),access))
    .rejects.toThrow("not the film's own sealed track");
  expect(existsSync(destination)).toBe(false);
  // And a track holding a different number of cues than the cut derives is not the film's.
  const counted=track("counted","WEBVTT\n\na\n00:00:00.000 --> 00:00:01.000\nOne.\n",1);
  await expect(renderDeliveryOpenCaptions(film,counted.path,{...counted.plan,captions:{...counted.plan.captions,cues:2},
    revision:deliveryOpenCaptionsPlan({...counted.plan.captions,cues:2},"master",{width:640,height:360},null).revision},{width:640,height:360,durationSec:2},
    join(root,"counted.mp4"),work("counted"),access)).rejects.toThrow("carries 1 cues and its cut derives 2");
});
