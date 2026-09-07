import {afterAll,beforeAll,expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {retainAudition,type RetainedAudition} from "../../planner/src/retained-auditions";
import {narrationTrack,validateNarrationTrack} from "../../planner/src/narration-mix";
import {createAudioTimelineReport} from "../../planner/src/audio-timeline";
import {mixNarrationPCM} from "../src/narration-mix";
let f:Awaited<ReturnType<typeof dubStudio>>,take:RetainedAudition;
beforeAll(async()=>{f=await dubStudio();take=retainAudition(await f.seedNarration("A second story begins."));},30000);
afterAll(async()=>{await f?.close();});
const pcm=(samples:number,amplitude:number)=>{const bytes=Buffer.alloc(samples*2);for(let i=0;i<samples;i++)bytes.writeInt16LE(amplitude,i*2);return bytes;};
const cue=(patch={})=>({id:crypto.randomUUID(),role:"narration",startSample:22050,gainDb:0,duckDb:-6,attackMs:1000,releaseMs:1000,audition:take,...patch});
const length=()=>f.film.output!.shotRenders!.reduce((sum,r)=>sum+Math.round(r.clip.durationSec*30)*735,0);
const track=(cues:ReturnType<typeof cue>[])=>narrationTrack(f.film,{language:"en",reviewed:true,cues},length(),"en");
// Known-amplitude prepared PCM isolates the mix arithmetic from the separately
// qualified resampler. These samples do not claim to be a real voice performance.
const read=(cueId:string,amplitude=1000)=>{const bytes=pcm(22050,amplitude),report=createAudioTimelineReport(take.output.report,take.output.files.find(f=>f.path===take.output.wavPath)!.sha256,"ffmpeg-audio-"+"a".repeat(64),bytes);return {cueId,pcm:bytes,report};};
test("duck attack, held level and release follow measured speech while dry dialogue remains byte-identical",async()=>{
  const c=cue(),t=track([c]),dry=pcm(length(),10000),original=Buffer.from(dry),result=await mixNarrationPCM(dry,t,[read(c.id)]),at=(b:Buffer,seconds:number)=>b.readInt16LE(Math.round(seconds*22050)*2);
  expect(dry).toEqual(original);expect(at(result.ducked,0)).toBe(10000);expect(at(result.ducked,.5)).toBe(7506);expect(at(result.ducked,1.5)).toBe(5012);expect(at(result.ducked,2.5)).toBe(7506);expect(at(result.ducked,3)).toBe(10000);
  expect(at(result.narration,.5)).toBe(0);expect(at(result.narration,1.5)).toBe(1000);expect(at(result.narration,2)).toBe(0);expect(at(result.mix,1.5)).toBe(6012);expect(at(result.mix,3)).toBe(10000);
});
test("overlapping narration sums once and uses the strongest duck without repeated attenuation",async()=>{
  const a=cue(),b=cue({startSample:33075,gainDb:-6,duckDb:-12,role:"voice-over"}),t=track([a,b]),result=await mixNarrationPCM(pcm(length(),10000),t,t.cues.map(c=>read(c.id)));
  expect(result.ducked.readInt16LE(Math.round(1.75*22050)*2)).toBe(2512);expect(result.mix.readInt16LE(Math.round(1.75*22050)*2)).toBe(4013);
  const duplicate=structuredClone(t);duplicate.cues[1]!.id=duplicate.cues[0]!.id;expect(()=>validateNarrationTrack(f.film,duplicate,length(),"en")).toThrow();
});
test("clipping, invalid controls, corrupt converted samples and cancellation cannot publish a mix; clearing restores dry dialogue",async()=>{
  const c=cue({duckDb:0}),t=track([c]);await expect(mixNarrationPCM(pcm(length(),30000),t,[read(c.id,10000)])).rejects.toThrow("would clip");
  for(const patch of [{gainDb:1},{gainDb:NaN},{duckDb:-37},{attackMs:1001},{releaseMs:-1},{startSample:length()},{audition:{...take,take:{...take.take,narration:undefined}}}])expect(()=>track([cue(patch)])).toThrow();
  const bad=read(c.id);bad.pcm[100]^=1;await expect(mixNarrationPCM(pcm(length(),10000),t,[bad])).rejects.toThrow("PCM");
  const abort=new AbortController();abort.abort(new Error("stop narration"));await expect(mixNarrationPCM(pcm(length(),10000),t,[read(c.id)],undefined,abort.signal)).rejects.toThrow("stop narration");
  const dry=pcm(length(),15000),cleared=await mixNarrationPCM(dry,track([]),[]);expect(cleared.mix).toEqual(dry);expect(cleared.ducked).toEqual(dry);expect(cleared.narration.every(b=>b===0)).toBe(true);
});
