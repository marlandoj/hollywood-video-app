import {afterAll,beforeAll,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {existsSync,readFileSync,realpathSync,renameSync,writeFileSync} from "node:fs";
import {join,sep} from "node:path";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {currentFilmSourceClock} from "../../planner/src/current-film-source-clock";
import {validateEditSourceReceipt} from "../../planner/src/edit-sources";
import {contentHash as hash} from "../src/capabilities";
import {speechWavHeader} from "../src/speech";
import {soundWavHeader} from "../src/sound-audio";
import {editSourceRecipe,inspectEditSource,prepareEditSources,validatePreparedEditSources,verifyPreparedEditSources,type PreparedEditSources} from "../src/edit-source-media";
import type {DialogueArtifactReader} from "../src/dialogue-replacement";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,prepared:PreparedEditSources;
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
beforeAll(async()=>{f=await currentFilmSourceFixture();},240000);
afterAll(async()=>{await f?.close();});
test("V2 inspection verifies full original custody and normalizes retained native dialogue at measured frame offsets",async()=>{
  const {job,receipt}=f,root=f.studio.paths.artifactRoot,clock=currentFilmSourceClock(job),originalHash=hash(job);
  expect(receipt.schema).toBe("hv-edit-source/3");expect(receipt.facts.audio).toEqual(["mix","dialogue"]);expect(receipt.audio.dialogue).toEqual({kind:"current-film-dialogue"});expect(receipt.facts.media).toBeUndefined();expect(receipt.facts.voices).toEqual(clock.voices);
  expect(validateEditSourceReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);expect(editSourceRecipe([receipt]).schema).toBe("hv-edit-source-media/3");
  prepared=await prepareEditSources([receipt],root,join(root,"prepared-current"),async()=>{});const source=prepared.sources[0]!,conversion=source.conversions.find(value=>value.lane==="dialogue")!;
  const pcm=Buffer.alloc(clock.frames*735*2);for(const span of clock.spans){if(!span.record.clip.speech)continue;const wav=readFileSync(join(root,span.record.files.audio!.path));wav.subarray(44).copy(pcm,span.startFrame*735*2);}
  const native=Buffer.concat([speechWavHeader(clock.frames*735),pcm]);expect(conversion).toMatchObject({kind:"current-film-dialogue",inputSha256:digest(native),decodedSamples:clock.frames*1600,padSamples:0,discardSamples:0});
  const expectedInput=join(f.studio.root,"expected-current-native.wav"),expectedPcm=join(f.studio.root,"expected-current-48.pcm");writeFileSync(expectedInput,native);
  const child=Bun.spawn(["ffmpeg","-v","error","-nostdin","-i",expectedInput,"-af","pan=stereo|c0=c0|c1=c0,aresample=48000:resampler=swr:filter_size=64:phase_shift=10:exact_rational=1:dither_method=none","-c:a","pcm_s24le","-f","s24le",expectedPcm],{stdout:"ignore",stderr:"pipe"});const [code,error]=await Promise.all([child.exited,new Response(child.stderr).text()]);if(code)throw new Error(error);
  const expected=Buffer.concat([soundWavHeader(clock.frames*1600),readFileSync(expectedPcm)]),actual=readFileSync(join(root,source.media.audio.dialogue!.path));expect(actual.equals(expected)).toBe(true);expect(actual.length).toBe(44+clock.frames*1600*6);
  for(const copy of source.copies)expect(digest(readFileSync(join(root,copy.copy.path)))).toBe(copy.original.sha256);expect(hash(job)).toBe(originalHash);expect(existsSync(join(root,"prepared-current",job.id,"scratch"))).toBe(false);
},180000);
test("retained V2 copies independently reproduce after original removal and reject resealed canonical PCM corruption",async()=>{
  const root=realpathSync(f.studio.paths.artifactRoot),original=realpathSync(join(root,f.job.projectId,f.job.id)),hidden=original+"-hidden";
  if(!original.startsWith(root+sep)||!hidden.startsWith(root+sep))throw new Error("Unsafe current-source recovery fixture path");
  renameSync(original,hidden);try{await verifyPreparedEditSources(prepared,root,join(root,"prepared-current"),async()=>{});}finally{renameSync(hidden,original);}
  const source=prepared.sources[0]!,path=join(root,source.media.audio.dialogue!.path),before=readFileSync(path),changed=Buffer.from(before);changed[200]^=1;
  const forged=structuredClone(prepared),copy=forged.sources[0]!;copy.media.audio.dialogue!.sha256=digest(changed);copy.conversions.find(value=>value.lane==="dialogue")!.output.sha256=digest(changed);const {revision:_revision,...body}=forged;forged.revision=hash(body);
  validatePreparedEditSources(forged,"prepared-current");writeFileSync(path,changed);writeFileSync(join(root,"prepared-current/sources.json"),JSON.stringify(forged));
  try{await expect(verifyPreparedEditSources(forged,root,join(root,"prepared-current"),async()=>{})).rejects.toThrow("do not reproduce");}
  finally{writeFileSync(path,before);writeFileSync(join(root,"prepared-current/sources.json"),JSON.stringify(prepared));}
},180000);
test("V2 streaming inspection refuses changed provenance/body, cancellation and current-access withdrawal",async()=>{
  const root=f.studio.paths.artifactRoot,info=async(path:string)=>{const bytes=readFileSync(join(root,path));return {path,bytes:bytes.length,sha256:digest(bytes)};};
  const reader:DialogueArtifactReader={async response(projectId,jobId,path){expect([projectId,jobId]).toEqual([f.job.projectId,f.job.id]);const file=await info(path);return new Response(Bun.file(join(root,path)).stream(),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});}};
  expect(await inspectEditSource(f.job,f.receipt.facts.label,root,async()=>{},undefined,reader,info)).toEqual(f.receipt);
  const bad:DialogueArtifactReader={async response(...args){const response=(await reader.response(...args))!;response.headers.set("etag",'"'+"0".repeat(64)+'"');return response;}};
  await expect(inspectEditSource(f.job,"Changed body",root,async()=>{},undefined,bad,info)).rejects.toThrow();
  const manifest=join(root,f.job.output!.manifestPath),bytes=readFileSync(manifest),data=JSON.parse(bytes.toString());data.shots.reverse();writeFileSync(manifest,JSON.stringify(data));
  try{await expect(inspectEditSource(f.job,"Changed provenance",root,async()=>{})).rejects.toThrow("current-film picture provenance");}finally{writeFileSync(manifest,bytes);}
  const aborted=new AbortController();aborted.abort(new Error("Cancelled source read"));await expect(inspectEditSource(f.job,"Cancelled",root,async()=>{},aborted.signal)).rejects.toThrow("Cancelled source read");
  let reads=0;await expect(inspectEditSource(f.job,"Revoked",root,async()=>{if(++reads>=3)throw new Error("Current source permission withdrawn");})).rejects.toThrow("Current source permission withdrawn");
},120000);
test("actual no-speech final retains overlapping original spans and never invents an isolated waveform",async()=>{
  const final=await f.renderFinal(),clock=currentFilmSourceClock(final.job),root=f.studio.paths.artifactRoot;
  expect(final.receipt.facts.frames).toBe(final.job.output!.currentFilm!.assembly.frames);expect(clock.frames).toBe(final.job.checkpointFrame-15*(clock.spans.length-1));expect(final.job.output!.currentFilm!.assembly.effectiveOverlapFrames).toBe(15);
  for(let i=1;i<clock.spans.length;i++)expect(clock.spans[i-1]!.endFrame-clock.spans[i]!.startFrame).toBe(15);
  expect(clock.isolatedDialogue).toBe(false);expect(clock.voices).toEqual([]);expect(clock.unmeasuredAudio).toBe(true);expect(final.receipt.facts.audio).toEqual(["mix"]);expect(final.receipt.audio.dialogue).toBeUndefined();
  const output=await prepareEditSources([final.receipt],root,join(root,"prepared-current-final"),async()=>{});expect(output.sources[0]!.conversions).toHaveLength(1);expect(output.sources[0]!.media.audio.mix!.bytes).toBe(44+clock.frames*1600*6);
},180000);
