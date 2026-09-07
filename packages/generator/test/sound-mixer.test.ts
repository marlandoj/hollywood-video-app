import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {soundFixture,soundCue,SOUND_RIGHTS} from "../../../test/fixtures/sound";
import {soundSession,SOUND_STEMS,type SoundSession,type SoundStem} from "../../planner/src/sound-session";
import {mixSoundSession,type VoiceWindow} from "../src/sound-mixer";
import {inspectSoundWav,normalizeSoundUpload} from "../src/sound-audio";
import {speechWavHeader} from "../src/speech";
async function mixed(session:SoundSession,pcm:Buffer,windows:VoiceWindow[]=[]){const chunks=Object.fromEntries(SOUND_STEMS.map(s=>[s,[] as Buffer[]])) as Record<SoundStem,Buffer[]>,peaks=await mixSoundSession(session,(_stem,_offset,frames)=>Buffer.alloc(frames*6),new Map(session.cues.map(c=>[c.asset.id,pcm])),windows,async(_offset,part)=>{for(const stem of SOUND_STEMS)chunks[stem].push(part[stem]);});return {peaks,stems:Object.fromEntries(SOUND_STEMS.map(s=>[s,Buffer.concat(chunks[s])])) as Record<SoundStem,Buffer>};}
test("sound stems preserve stereo trim/loop timing, fades and balance without changing dry voices",async()=>{
  const f=soundFixture(undefined,100,100000,200000),cue={...soundCue(f.asset),start:50,frames:200,trimIn:25,trimOut:75,loop:true,fadeIn:20,fadeOut:20,balance:.5},session=soundSession({reviewed:true,dialogueGainDb:0,narrationGainDb:0,cues:[cue]},f.asset.projectId,300),out=await mixed(session,f.pcm),sample=(stem:SoundStem,frame:number,ch=0)=>out.stems[stem].readIntLE(frame*6+ch*3,3);
  expect(sample("music",49)).toBe(0);expect(sample("music",50)).toBe(0);expect(sample("music",60)).toBe(25000);expect(sample("music",70)).toBe(50000);expect(sample("music",70,1)).toBe(200000);expect(sample("music",200)).toBe(50000);expect(sample("music",249)).toBe(0);expect(sample("music",250)).toBe(0);expect(out.stems.music.equals(out.stems.me)).toBe(true);expect(out.stems.me.equals(out.stems.mix)).toBe(true);expect(out.stems.dialogue.every(b=>b===0)).toBe(true);expect(out.peaks.mix).toBe(200000);
  expect(()=>soundSession({reviewed:true,dialogueGainDb:0,narrationGainDb:0,cues:[{...cue,loop:false}]},f.asset.projectId,300)).toThrow("looping");expect(()=>soundSession({reviewed:true,dialogueGainDb:0,narrationGainDb:0,cues:[{...cue,fadeIn:101,fadeOut:100}]},f.asset.projectId,300)).toThrow("fades");
});
test("overlapping voice windows use one duck envelope and overlapping sound cues reject clipping",async()=>{
  const f=soundFixture(undefined,48000,1000000,1000000),cue={...soundCue(f.asset),duckDb:-6,duckAttack:4800,duckRelease:4800},session=soundSession({reviewed:true,dialogueGainDb:0,narrationGainDb:0,cues:[cue]},f.asset.projectId,48000),out=await mixed(session,f.pcm,[{start:9600,end:24000},{start:12000,end:20000}]);const sample=(i:number)=>out.stems.music.readIntLE(i*6,3);
  expect(sample(0)).toBe(1000000);expect(sample(7200)).toBeCloseTo(750593,0);expect(sample(14000)).toBeCloseTo(501187,0);expect(sample(26400)).toBeCloseTo(750594,0);expect(sample(30000)).toBe(1000000);
  const loud=soundFixture(f.asset.projectId,48000,7000000,7000000),loudCue=soundCue(loud.asset),clipped=soundSession({reviewed:true,dialogueGainDb:0,narrationGainDb:0,cues:[loudCue,{...loudCue,id:crypto.randomUUID()}]},loud.asset.projectId,48000);await expect(mixed(clipped,loud.pcm)).rejects.toThrow("clip");
  const abort=new AbortController();abort.abort();await expect(mixSoundSession(session,(_s,_o,n)=>Buffer.alloc(n*6),new Map([[f.asset.id,f.pcm]]),[],async()=>{},async()=>{},abort.signal)).rejects.toThrow();
});
test("bounded WAV normalization retains source identity and converts mono rate with exact rational duration",async()=>{
  const root=mkdtempSync(join(tmpdir(),"hv-sound-normalize-"));try{const original=Buffer.concat([speechWavHeader(2205),Buffer.alloc(4410)]);for(let i=0;i<2205;i++)original.writeInt16LE(Math.round(Math.sin(i*2*Math.PI/50)*5000),44+i*2);const id=crypto.randomUUID(),converted=await normalizeSoundUpload(original,id,"Fixture voice",SOUND_RIGHTS,root,async()=>{});
    expect(converted.asset.original.sampleRate).toBe(22050);expect(converted.asset.original.channels).toBe(1);expect(converted.asset.audio.frames).toBe(4800);expect(inspectSoundWav(converted.audio).channels).toBe(2);for(let i=100;i<4000;i+=100)expect(converted.audio.readIntLE(44+i*6,3)).toBe(converted.audio.readIntLE(47+i*6,3));
    const malformed=Buffer.from(original);malformed.writeUInt32LE(original.length+1000,40);expect(()=>inspectSoundWav(malformed)).toThrow("chunk");expect(()=>inspectSoundWav(Buffer.from("playlist"))).toThrow("WAV");
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);

test("trimmed sample order and loop phase remain exact across streaming chunk boundaries",async()=>{
  const f=soundFixture(undefined,113),pcm=Buffer.alloc(113*6);for(let i=0;i<113;i++){pcm.writeIntLE(i*100,6*i,3);pcm.writeIntLE(-i*100,6*i+3,3);}
  const cue={...soundCue(f.asset),start:65520,frames:200,trimIn:17,trimOut:96,loop:true},session=soundSession({reviewed:true,dialogueGainDb:0,narrationGainDb:0,cues:[cue]},f.asset.projectId,65750),out=await mixed(session,pcm);
  for(const at of [65519,65520,65535,65536,65598,65599,65600,65719,65720]){const expected=at<65520||at>=65720?0:(17+(at-65520)%79)*100;expect(out.stems.music.readIntLE(at*6,3)).toBe(expected);expect(out.stems.music.readIntLE(at*6+3,3)).toBe(expected===0?0:-expected);}
});
