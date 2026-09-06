import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createAudioDelivery,audioPcmHash} from "../src/audio-delivery";
import {convertAudioToTimeline,audioTimelineRuntimeRevision} from "../src/audio-timeline";
import {compileAudioLine} from "../../planner/src/audio-performances";
import {lineSources} from "../../planner/src/performances";
import {validateAudioTimeline,timelineSampleCounts,assertAudioTimelineWindow} from "../../planner/src/audio-timeline";
import {contentHash} from "../src/capabilities";
import {AUDIO_POLICY} from "../../../test/fixtures/audio";
const root=mkdtempSync(join(tmpdir(),"hv-audio-timeline-")),runtime=audioTimelineRuntimeRevision();
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function fixture(samples=48000,frequency=1000,beforeMs=37,afterMs=113){
  const source=lineSources([{character:"MARLA",lines:["Hello."]}])[0]!,plan=compileAudioLine(source,{schema:"hv-audio-voice/1",provider:"cartesia",language:"en",voice:{id:AUDIO_POLICY.voiceId,catalogueRevision:AUDIO_POLICY.catalogueRevision,permissionRevision:AUDIO_POLICY.permissionRevision},controls:{emotion:"calm",speed:1,volume:1},pronunciations:[]},{sourceHash:source.hash,beforeMs,afterMs,notes:"Synthetic conversion probe."});
  const pcm=Buffer.alloc(samples*2);for(let i=0;i<samples;i++)pcm.writeInt16LE(Math.round(Math.sin(2*Math.PI*frequency*i/48000)*8000),i*2);
  const tokens=[{text:"probe",startSec:0,endSec:samples/48000}];return createAudioDelivery(plan,crypto.randomUUID(),pcm,tokens,tokens);
}
test("48 kHz audition conversion retains original evidence, exact pauses and rescaled provider tokens without changing pitch",async()=>{
  const f=fixture(),original=Buffer.from(f.wav);let checks=0;const converted=await convertAudioToTimeline(f.wav,f.report,root,runtime,44100,async()=>{checks++;});
  expect(checks).toBe(2);expect(f.wav).toEqual(original);expect(converted.report.source).toEqual(f.report);expect(converted.report.sourceWavSha256).toBe(audioPcmHash(original));
  expect(validateAudioTimeline(converted.report,converted.pcm)).toEqual(converted.report);expect(converted.wav.readUInt32LE(24)).toBe(22050);expect(converted.wav.readUInt32LE(40)).toBe(converted.pcm.length);
  const count=timelineSampleCounts(f.report);expect(count).toEqual({before:816,speech:22050,after:2492,total:25358});
  expect(converted.report.alignment.words).toEqual([{text:"probe",startSample:816,endSample:22866}]);expect(converted.report.alignment.origin).toBe("line-start");
  expect(converted.pcm.subarray(0,816*2).every(b=>b===0)).toBe(true);expect(converted.pcm.subarray(22866*2).every(b=>b===0)).toBe(true);
  let real=0,imag=0;const n=22050-400;for(let i=200;i<22050-200;i++){const sample=converted.pcm.readInt16LE((i+816)*2);real+=sample*Math.cos(2*Math.PI*1000*i/22050);imag+=sample*Math.sin(2*Math.PI*1000*i/22050);}
  const amplitude=2*Math.hypot(real,imag)/n;expect(amplitude).toBeGreaterThan(7900);expect(amplitude).toBeLessThan(8100);
  expect(readdirSync(root)).toEqual([]);
});
test("conversion suppresses frequencies beyond timeline Nyquist instead of aliasing them into dialogue",async()=>{
  const f=fixture(48000,16000,0,0),converted=await convertAudioToTimeline(f.wav,f.report,root,runtime,22050,async()=>{});
  let sum=0;for(let i=200;i<22050-200;i++)sum+=converted.pcm.readInt16LE(i*2)**2;
  expect(Math.sqrt(sum/(22050-400))).toBeLessThan(10);
});
test("fractional and very short reads have rational sample lengths and deterministic repeated PCM",async()=>{
  for(const samples of [1,31,320,321,48001]){
    const f=fixture(samples,1000,0,0),count=Math.ceil(samples*147/320),a=await convertAudioToTimeline(f.wav,f.report,root,runtime,count,async()=>{}),b=await convertAudioToTimeline(f.wav,f.report,root,runtime,count,async()=>{});
    expect(a.pcm.length).toBe(count*2);expect(b.pcm).toEqual(a.pcm);expect(b.report).toEqual(a.report);expect(a.report.alignment.words[0]!.endSample).toBeLessThanOrEqual(count);
  }
});
test("overflow, corrupted bytes, fabricated timing and runtime changes fail before publication",async()=>{
  const f=fixture(),count=timelineSampleCounts(f.report);expect(()=>assertAudioTimelineWindow(f.report,count.total-1)).toThrow("available in the locked picture");
  let checks=0;await expect(convertAudioToTimeline(f.wav,f.report,root,runtime,count.total-1,async()=>{checks++;})).rejects.toThrow("Choose a shorter take");expect(checks).toBe(0);
  const bad=Buffer.from(f.wav);bad[4000]^=1;await expect(convertAudioToTimeline(bad,f.report,root,runtime,count.total,async()=>{})).rejects.toThrow("bytes");
  const wrongHeader=Buffer.from(f.wav);wrongHeader.writeUInt32LE(22050,24);await expect(convertAudioToTimeline(wrongHeader,f.report,root,runtime,count.total,async()=>{})).rejects.toThrow("WAV format");
  await expect(convertAudioToTimeline(f.wav,f.report,root,"ffmpeg-audio-"+"f".repeat(64),count.total,async()=>{})).rejects.toThrow("runtime changed");
  const converted=await convertAudioToTimeline(f.wav,f.report,root,runtime,count.total,async()=>{}),forged=structuredClone(converted.report);forged.alignment.words[0]!.endSample--;
  const {revision:_revision,...data}=forged;forged.revision=contentHash(data);expect(()=>validateAudioTimeline(forged)).toThrow("provider timing");
  const altered=Buffer.from(converted.pcm);altered[2000]^=1;expect(()=>validateAudioTimeline(converted.report,altered)).toThrow("PCM");expect(readdirSync(root)).toEqual([]);
});
test("cancellation and late permission withdrawal leave no converted artifacts",async()=>{
  const f=fixture(),count=timelineSampleCounts(f.report),abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{await expect(convertAudioToTimeline(f.wav,f.report,root,runtime,count.total,async()=>{timer=setTimeout(()=>abort.abort(new Error("stop conversion")),5);},abort.signal)).rejects.toThrow("stop conversion");}finally{clearTimeout(timer);}
  let checks=0;await expect(convertAudioToTimeline(f.wav,f.report,root,runtime,count.total,async()=>{if(++checks===2)throw new Error("permission withdrawn");})).rejects.toThrow("permission withdrawn");
  expect(checks).toBe(2);expect(readdirSync(root)).toEqual([]);expect(audioPcmHash(f.wav.subarray(44))).toBe(f.report.pcmSha256);
});
