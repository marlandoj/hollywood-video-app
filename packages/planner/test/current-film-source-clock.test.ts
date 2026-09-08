import {afterAll,beforeAll,expect,test} from "bun:test";
import {currentFilmSourceFixture} from "./current-film-source.fixture";
import {currentFilmSourceClock} from "../src/current-film-source-clock";
import {contentHash as hash} from "../../generator/src/capabilities";

let fixture:Awaited<ReturnType<typeof currentFilmSourceFixture>>;
beforeAll(async()=>{fixture=await currentFilmSourceFixture();},240000);
afterAll(async()=>{await fixture?.close();});
test("actual current source binds opaque and repeated physical lines to retained frame and native PCM clocks",()=>{
  const {job}=fixture,before=hash(job),clock=currentFilmSourceClock(job);
  expect(clock.sourceId).toBe(job.id);expect(clock.sourceOutputRevision).toBe(hash(job.output));expect(clock.documentRevision).toBe(job.currentFilm!.materialization.documentRevision);
  expect(clock.spans.map(span=>span.renderId)).toEqual(job.currentFilm!.materialization.slots.map(slot=>slot.renderId));expect(clock.spans.some(span=>span.slot.original===null&&span.renderId.startsWith("shot-v2-"))).toBe(true);
  expect(clock.isolatedDialogue).toBe(true);expect(clock.unmeasuredAudio).toBe(false);expect(clock.frames).toBe(job.output!.currentFilm!.assembly.frames);
  const repeat=clock.spans.flatMap(span=>span.spoken).filter(line=>line.source.text==="Welcome home.");expect(repeat).toHaveLength(2);expect(new Set(repeat.map(line=>line.lineId)).size).toBe(2);expect(new Set(repeat.map(line=>line.voiceId)).size).toBe(2);
  for(const span of clock.spans){expect([span.startSample,span.endSample]).toEqual([span.startFrame*1600,span.endFrame*1600]);
    for(const line of span.spoken){const original=span.record.clip.speech!.lines.find(value=>value.source.hash===line.source.hash)!;
      expect(line.nativeStartSample).toBe(span.startFrame*735+original.startSample);expect(line.nativeEndSample).toBe(span.startFrame*735+original.endSample);
      expect(line.startSample).toBe(Math.round(line.nativeStartSample*320/147));expect(line.endSample).toBe(Math.round(line.nativeEndSample*320/147));
      expect(clock.voices.find(voice=>voice.id===line.voiceId)).toEqual({id:line.voiceId,lane:"dialogue",start:line.startSample,end:line.endSample});
      expect(span.slot.physical.spoken.find(value=>value.lineId===line.lineId)?.source).toEqual(original.source);expect(line.pcmSha256).toBe(original.pcmSha256);
    }
  }
  clock.spans[0]!.slot.shot.prompt="Changed returned clone";clock.voices[0]!.end++;expect(hash(job)).toBe(before);expect(currentFilmSourceClock(job).spans[0]!.slot.shot.prompt).not.toBe("Changed returned clone");
});
test("source clocks refuse reordered custody, missing routes, tampered target, forged assembly offsets and hostile getters",()=>{
  const before=hash(fixture.job),changes:((job:typeof fixture.job)=>void)[]=[job=>{job.status="running";},job=>{job.currentFilmCheckpoint!.rows.reverse();},job=>{job.routeDecisions=[];},job=>{job.currentFilm!.materialization.slots[0]!.physical.headingLineId="f".repeat(64);},job=>{job.output!.currentFilm!.assembly.spans[1]!.startFrame++;},job=>{job.completedAt="not-a-date";}];
  for(const change of changes){const job=structuredClone(fixture.job);change(job);expect(()=>currentFilmSourceClock(job)).toThrow();}
  const hostile=structuredClone(fixture.job);let reads=0;Object.defineProperty(hostile,"currentFilm",{enumerable:true,get(){reads++;throw new Error("Accessor executed");}});expect(()=>currentFilmSourceClock(hostile)).toThrow();expect(reads).toBe(0);expect(hash(fixture.job)).toBe(before);
});
