/**
 * HV-027-16 — the SDH render: the master's own picture and sound, copied, with a timed-text track
 * holding the film's own lines and the sounds its sound session placed, proved by reading it back.
 */
import {afterAll,expect,test} from "bun:test";
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {deliverySdhPlan,type DeliverySoundCue} from "../../planner/src/delivery-sdh";
import {parseSdhReadBack,renderDeliverySdh,sdhSegments} from "../src/delivery-sdh";

const root=mkdtempSync(join(tmpdir(),"hv-delivery-sdh-"));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const access=async()=>{};
const PATH="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb/export/conform/captions.vtt";
async function master(seconds:number):Promise<string>{
  const path=join(root,"master.mp4");
  const child=Bun.spawn(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i","testsrc2=size=640x360:rate=30:duration="+seconds,
    "-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration="+seconds,"-map","0:v:0","-map","1:a:0",
    "-c:v","libx264","-pix_fmt","yuv420p","-r","30","-c:a","aac","-ac","2","-t",String(seconds),"-y",path],{cwd:root,stdin:"ignore",stdout:"ignore",stderr:"pipe"});
  const log=await new Response(child.stderr).text();
  expect({code:await child.exited,log}).toEqual({code:0,log:""});
  return path;
}
function planned(name:string,vtt:string,cues:number,sounds:DeliverySoundCue[]){
  const path=join(root,name+".vtt");writeFileSync(path,vtt);
  return {path,plan:deliverySdhPlan({path:PATH,sha256:createHash("sha256").update(vtt).digest("hex"),bytes:Buffer.byteLength(vtt),cues},sounds,{width:640,height:360},90)};
}
const s=(seconds:number)=>Math.round(seconds*48000);

test("overlapping cues become segments that show every cue active across them, one per line",()=>{
  // Measured: MP4 timed text shows one sample at a time, so music under a line of dialogue was cut
  // off where the line began and the rest of it was lost. Segments keep all of it.
  expect(sdhSegments([{startMs:500,endMs:1500,text:"SPUD: Hello."}],[{startMs:0,endMs:2500,text:"[music: Garden theme]"}])).toEqual([
    {startMs:0,endMs:500,text:"[music: Garden theme]"},
    {startMs:500,endMs:1500,text:"[music: Garden theme]\nSPUD: Hello."},
    {startMs:1500,endMs:2500,text:"[music: Garden theme]"}]);
  // A gap is a gap, and a cue that ends where an identical one begins is one segment.
  expect(sdhSegments([{startMs:0,endMs:100,text:"A"},{startMs:100,endMs:200,text:"A"},{startMs:300,endMs:400,text:"B"}],[]))
    .toEqual([{startMs:0,endMs:200,text:"A"},{startMs:300,endMs:400,text:"B"}]);
  expect(parseSdhReadBack("1\n00:00:00,000 --> 00:00:00,500\nOne\ntwo\n\n2\n00:01:02,003 --> 00:01:02,004\nThree\n\n"))
    .toEqual([{startMs:0,endMs:500,text:"One\ntwo"},{startMs:62003,endMs:62004,text:"Three"}]);
});

test("the master's picture and sound are copied and the track reads back exactly as written",async()=>{
  const film=await master(3);
  const vtt="WEBVTT\n\na\n00:00:00.200 --> 00:00:01.172\nSPUD: Fish &amp; chips &lt;now&gt;\nplease.\n\nb\n00:00:01.500 --> 00:00:02.000\nSPUD: Come inside.\n";
  const sounds:DeliverySoundCue[]=[{start:s(1),end:s(2.5),role:"ambience",label:"Rain on glass"},{start:s(2.2),end:s(2.4),role:"effects",label:"Door slam"}];
  const {path,plan}=planned("sdh",vtt,2,sounds),destination=join(root,"sdh.mp4");
  expect(plan.sounds).toEqual([{startMs:1000,endMs:2500,text:"[ambience: Rain on glass]"},{startMs:2200,endMs:2400,text:"[Door slam]"}]);
  const result=await renderDeliverySdh(film,path,plan,destination,mkdtempSync(join(root,"work-")),access);
  expect(result.delivered).toMatchObject({width:640,height:360,video:"h264",audio:"aac"});
  expect(result.check).toMatchObject({dialogue:2,sounds:2,track:{codec:"mov_text",hearingImpaired:true,handler:"SDH"}});
  expect(result.check.readBackSha256).toBe(result.check.segmentsSha256);
  expect(result.check.deliveredStreams).toBe(result.check.masterStreams);
  // Read the delivered file independently of the render, and see the film's lines and its sounds.
  const back=join(root,"independent.srt"),child=Bun.spawn(["ffmpeg","-v","error","-i",destination,"-map","0:s:0","-f","srt","-y",back],{stdin:"ignore",stdout:"ignore",stderr:"pipe"});
  expect(await child.exited).toBe(0);
  expect(parseSdhReadBack(readFileSync(back,"utf8"))).toEqual([
    {startMs:200,endMs:1000,text:"SPUD: Fish & chips <now>\nplease."},
    {startMs:1000,endMs:1172,text:"SPUD: Fish & chips <now>\nplease.\n[ambience: Rain on glass]"},
    {startMs:1172,endMs:1500,text:"[ambience: Rain on glass]"},
    {startMs:1500,endMs:2000,text:"[ambience: Rain on glass]\nSPUD: Come inside."},
    {startMs:2000,endMs:2200,text:"[ambience: Rain on glass]"},
    {startMs:2200,endMs:2400,text:"[ambience: Rain on glass]\n[Door slam]"},
    {startMs:2400,endMs:2500,text:"[ambience: Rain on glass]"}]);
  expect(result.check.segments).toBe(7);
});

test("text MP4 timed text would alter is refused by name, and a track that is not the plan's is refused, before anything is written",async()=>{
  const film=await master(3);
  // Measured: ffmpeg carries timed text through ASS, and `{x}` came back as `\{x\}`.
  const braced=planned("braced","WEBVTT\n\na\n00:00:00.000 --> 00:00:01.000\nSPUD: {whispers} Now.\n",1,[]);
  const destination=join(root,"refused.mp4");
  await expect(renderDeliverySdh(film,braced.path,braced.plan,destination,mkdtempSync(join(root,"work-")),access))
    .rejects.toThrow("SDH segment 1 holds a brace or a backslash, which MP4 timed text cannot carry unaltered: \"SPUD: {whispers} Now.\"");
  expect(existsSync(destination)).toBe(false);
  const other=planned("other","WEBVTT\n\na\n00:00:00.000 --> 00:00:01.000\nOther words.\n",1,[]);
  await expect(renderDeliverySdh(film,other.path,braced.plan,destination,mkdtempSync(join(root,"work-")),access)).rejects.toThrow("not the film's own sealed track");
  expect(existsSync(destination)).toBe(false);
});
