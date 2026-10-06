// HV-024-15: a feature's score fits in the project's sound library.
//
// Release 3's live run kept nine Composer cues (96–120 s, 16-bit originals with 24-bit normalized copies)
// and four 20-second ambience beds: 507 MiB. The tenth sequence's cue and its mix were refused with "The
// sound library exceeds its retained media limit." under the old 512 MiB bound. The records here have the
// same shapes and sizes as that library's.
import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {MAX_SOUND_LIBRARY_BYTES,emptySoundLibrary,soundRights,updateSoundLibrary,validateSoundLibrary,type SoundAsset,type SoundLibrary} from "../src/sound-assets";

const PROJECT="00000000-0000-4000-8000-0000000000aa";
const NOW=Date.parse("2026-10-06T04:00:00.000Z");
const rights={basis:"licensed",source:"Synthetic test cue",credit:"",terms:"Created solely for this closed test fixture.",attested:true};
/** A cue or bed as `normalizeSoundUpload` would record it: `seconds` of 48 kHz stereo, at the original's bit depth. */
function asset(n:number,seconds:number,encoding:"pcm_s16le"|"pcm_s24le"):SoundAsset{
  const frames=48000*seconds,width=encoding==="pcm_s16le"?4:6;
  const data={schema:"hv-sound-asset/1" as const,id:"00000000-0000-4000-8000-"+String(n).padStart(12,"0"),projectId:PROJECT,label:(encoding==="pcm_s16le"?"Composer music cue ":"Ambience bed ")+n,
    createdAt:new Date(NOW).toISOString(),rights:soundRights(rights,NOW),original:{sha256:n.toString(16).padStart(64,"0"),bytes:44+frames*width,sampleRate:48000,channels:2,frames,encoding},
    audio:{sha256:(n+1000).toString(16).padStart(64,"0"),bytes:44+frames*6,frames},engineVersion:"ffmpeg-sound-"+"c".repeat(64)};
  return {...data,revision:contentHash(data)};
}
const bytes=(library:SoundLibrary)=>library.assets.reduce((n,a)=>n+a.original.bytes+a.audio.bytes,0);
function add(library:SoundLibrary,item:SoundAsset):SoundLibrary{return updateSoundLibrary(library,PROJECT,library.version,item,NOW);}

test("a 20-minute feature's ten cues and four ambience beds are kept, where 512 MiB refused the tenth", () => {
  let library=emptySoundLibrary();
  for(let n=1;n<=4;n++)library=add(library,asset(100+n,20,"pcm_s24le"));
  for(let n=1;n<=10;n++)library=add(library,asset(n,120,"pcm_s16le"));
  expect(library.assets).toHaveLength(14);
  expect(bytes(library)).toBeGreaterThan(512*1024**2);
  expect(validateSoundLibrary(library,PROJECT).assets).toHaveLength(14);
});

test("the library still has a bound, and refuses media past it", () => {
  expect(MAX_SOUND_LIBRARY_BYTES).toBe(2*1024**3);
  let library=emptySoundLibrary();
  // 600-second cues (the longest sound kept): about 275 MiB each, so the eighth crosses 2 GiB.
  for(let n=1;n<=7;n++)library=add(library,asset(n,600,"pcm_s16le"));
  expect(bytes(library)).toBeLessThanOrEqual(MAX_SOUND_LIBRARY_BYTES);
  expect(()=>add(library,asset(8,600,"pcm_s16le"))).toThrow("The sound library exceeds its retained media limit.");
});
