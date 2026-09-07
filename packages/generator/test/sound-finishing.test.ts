import {expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {soundWav,verifySoundWav} from "../src/sound-audio";
import {finishSoundMaster,measureSound,completeSoundFinishing,verifyFinishingRecords} from "../src/sound-finishing";
import {soundFinishing,validateSoundFinishingReport,type SoundFinishing} from "../../planner/src/sound-finishing";
const measure:SoundFinishing={schema:"hv-sound-finishing/1",mode:"measure"},target:SoundFinishing={schema:"hv-sound-finishing/1",mode:"normalize",targetLufs:-23,ceilingDbtp:-2,rangeLu:7};
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-finish-")));return {root,folder(name:string){const dir=join(root,name);mkdirSync(dir);return dir;},wav(name:string,seconds:number,sample:(i:number)=>number){const frames=Math.round(seconds*48000),pcm=Buffer.alloc(frames*6);for(let i=0;i<frames;i++){const s=Math.round(sample(i)*8388607);pcm.writeIntLE(s,i*6,3);pcm.writeIntLE(s,i*6+3,3);}const path=join(root,name+".wav");writeFileSync(path,soundWav(pcm));return {path,frames};},close(){if(!root.startsWith(realpathSync(tmpdir())+sep))throw new Error("Unsafe fixture cleanup");rmSync(root,{recursive:true,force:true});}};}
const sine=(amplitude:number)=>(i:number)=>amplitude*Math.sin(2*Math.PI*1000*i/48000);
test("full-program loudness retains gates, completed windows, silence and unprocessed waveform identity",async()=>{
  const f=fixture();try{
    // EBU Tech 3341 minimum-reference stereo 1 kHz level relationship; no claim of a complete meter qualification.
    const tone=f.wav("tone",20,sine(.1)),dir=f.folder("tone-result"),r=await finishSoundMaster(tone.path,tone.frames,dir,measure,async()=>{});
    for(const value of [r.before.integratedLufs,r.before.truePeakDbtp,r.before.momentaryMaxLufs,r.before.shortTermMaxLufs])expect(Math.abs(value!+20)).toBeLessThanOrEqual(.1);expect(r.before.rangeStable).toBe(false);expect(r.masterSha256).toBe(r.inputSha256);expect(r.after).toEqual(r.before);
    const gated=f.wav("gated",30,i=>i<10*48000?0:sine(.1)(i)),g=await measureSound(gated.path,gated.frames,f.folder("gated-result"),"before",async()=>{});expect(Math.abs(g.integratedLufs!-r.before.integratedLufs!)).toBeLessThan(.15);
    for(const seconds of [1/30,.2,2,5,158/30]){const silence=f.wav("silence"+seconds,seconds,()=>0),s=await measureSound(silence.path,silence.frames,f.folder("silence-result"+seconds),"before",async()=>{});expect(s.silent).toBe(true);expect(s.integratedLufs).toBeNull();expect(s.truePeakDbtp).toBeNull();expect(s.momentaryMaxLufs).toBeNull();expect(s.shortTermMaxLufs).toBeNull();}
    const veryQuiet=f.wav("quiet",5,sine(.00001)),q=await measureSound(veryQuiet.path,veryQuiet.frames,f.folder("quiet-result"),"before",async()=>{});expect(q.silent).toBe(false);expect(q.integratedLufs).toBeNull();expect(q.truePeakDbtp).toBeLessThan(-90);
  }finally{f.close();}
},60000);
test("reviewed linear normalization reaches the target and retains the original samples separately",async()=>{
  const f=fixture();try{const tone=f.wav("tone",20,i=>sine(i<480000?.1:.07)(i)),original=readFileSync(tone.path),dir=f.folder("result"),r=await finishSoundMaster(tone.path,tone.frames,dir,target,async()=>{});expect(r.mode).toBe("linear");expect(r.after.integratedLufs).toBeCloseTo(-23,1);expect(Math.abs(r.after.truePeakDbtp!-(r.before.truePeakDbtp!-23-r.before.integratedLufs!))).toBeLessThan(.1);expect(r.masterSha256).not.toBe(r.inputSha256);expect(readFileSync(tone.path)).toEqual(original);expect(verifySoundWav(readFileSync(join(dir,"master.wav")),tone.frames).length).toBe(tone.frames*6);
    const encoded=await measureSound(join(dir,"master.wav"),tone.frames,dir,"encoded",async()=>{}),report=completeSoundFinishing(r,encoded);validateSoundFinishingReport(report,target,tone.frames,r.inputSha256,r.engineVersion);verifyFinishingRecords(report,dir);expect(report.pcmTargetsMet).toBe(true);expect(report.encodedTargetsMet).toBe(true);
    const bad=structuredClone(report);bad.after.integratedLufs=-19;expect(()=>verifyFinishingRecords(bad,dir)).toThrow("meter evidence");bad.pcmTargetsMet=true;expect(()=>validateSoundFinishingReport(bad,target,tone.frames,r.inputSha256,r.engineVersion)).toThrow("misstates");
  }finally{f.close();}
},60000);
test("true-peak measurements detect intersample overs and dynamic normalization limits a crest-heavy mix",async()=>{
  const f=fixture();try{const peak=f.wav("intersample",5,i=>.8*Math.sin(2*Math.PI*12000*i/48000+Math.PI/4)),p=await measureSound(peak.path,peak.frames,f.folder("peak-result"),"before",async()=>{});expect(p.truePeakDbtp!).toBeGreaterThan(20*Math.log10(.8/Math.sqrt(2))+2);
    const transient=f.wav("transient",10,i=>i%24000===0?.7:sine(.015)(i)),settings:SoundFinishing={...target,targetLufs:-16},r=await finishSoundMaster(transient.path,transient.frames,f.folder("limited"),settings,async()=>{});expect(r.mode).toBe("dynamic");expect(r.after.truePeakDbtp!).toBeLessThanOrEqual(-1.95);expect(r.after.integratedLufs!).toBeGreaterThan(r.before.integratedLufs!);expect(r.after.frames).toBe(transient.frames);
  }finally{f.close();}
},60000);
test("finishing refuses excessive gain, short or gated sources, invalid targets and cancelled access",async()=>{
  const f=fixture();try{
    expect(()=>soundFinishing({...target,ceilingDbtp:0})).toThrow();expect(()=>soundFinishing({...measure,targetLufs:-23})).toThrow();expect(()=>soundFinishing({...target,targetLufs:NaN})).toThrow();
    const quiet=f.wav("quiet",5,sine(.001));await expect(finishSoundMaster(quiet.path,quiet.frames,f.folder("excess"),target,async()=>{})).rejects.toThrow("20 dB");
    const short=f.wav("short",2,sine(.1));await expect(finishSoundMaster(short.path,short.frames,f.folder("short-result"),target,async()=>{})).rejects.toThrow("three seconds");
    const silence=f.wav("silent",5,()=>0);await expect(finishSoundMaster(silence.path,silence.frames,f.folder("silence-result"),target,async()=>{})).rejects.toThrow("three seconds");
    const abort=new AbortController();abort.abort();await expect(measureSound(short.path,short.frames,f.folder("abort"),"before",async()=>{},abort.signal)).rejects.toThrow();await expect(measureSound(short.path,short.frames,f.folder("revoked"),"before",async()=>{throw new Error("permission withdrawn");})).rejects.toThrow("permission withdrawn");
  }finally{f.close();}
},60000);
