import {afterAll,describe,expect,test} from "bun:test";
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AMBIENCE_PRESETS,AMBIENCE_RECIPE,ambiencePreset} from "../../planner/src/sound-ambience";
import {ambienceFilter,renderAmbience} from "../src/sound-ambience";
import {inspectSoundWav,soundWavHeader} from "../src/sound-audio";

// HV-024-12: the studio renders its ambience beds itself, with FFmpeg's seeded sources. These tests
// render every preset for real (no network, no provider) and measure them with FFmpeg's own meters.
const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-ambience-")));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const L=AMBIENCE_RECIPE.loopFrames;
const sample=(wav:Buffer,frame:number,channel:number)=>wav.readIntLE(44+frame*6+channel*3,3);

/** Integrated loudness and true peak from FFmpeg's EBU R128 meter, as the finishing lane measures them. */
function meter(wav:Buffer,name:string):{lufs:number;truePeak:number;maxVolume:number}{
  const path=join(root,name+".wav");writeFileSync(path,wav);
  const result=Bun.spawnSync(["ffmpeg","-nostats","-hide_banner","-i",path,"-af","ebur128=peak=true:framelog=quiet,volumedetect","-f","null","-"],{stdout:"pipe",stderr:"pipe"});
  const log=result.stderr.toString(),read=(pattern:RegExp)=>{const match=pattern.exec(log);if(!match)throw new Error("FFmpeg did not report "+pattern+": "+log.slice(-400));return Number(match[1]);};
  return {lufs:read(/^\s+I:\s+(-?[0-9.]+) LUFS/m),truePeak:read(/^\s+Peak:\s+(-?[0-9.]+) dBFS/m),maxVolume:read(/max_volume: (-?[0-9.]+) dB/)};
}

describe("rendering the studio's ambience beds", () => {
  /** Two renders of one preset, minutes apart or not, are byte-for-byte the same file. */
  test("the same preset and seed render identical bytes", async () => {
    for(const preset of AMBIENCE_PRESETS){const first=await renderAmbience(preset.id,root),second=await renderAmbience(preset.id,root);expect([preset.id,first.equals(second)]).toEqual([preset.id,true]);}
  },120000);

  /** The seed is what decides the noise: a different seed is a different bed, and the presets differ from each other. */
  test("a different seed or preset renders different bytes", async () => {
    const surf=ambiencePreset("surf"),first=await renderAmbience(surf,root),reseeded=await renderAmbience({...surf,seed:surf.seed+100},root);
    expect(first.equals(reseeded)).toBe(false);expect(first.equals(await renderAmbience("wind",root))).toBe(false);
  },60000);

  /** Every bed is exactly the recipe's twenty seconds of canonical 48 kHz stereo 24-bit audio, with the canonical header. */
  test("a bed is exactly the loop's length in the canonical format", async () => {
    for(const preset of AMBIENCE_PRESETS){const wav=await renderAmbience(preset.id,root);
      expect(wav.length).toBe(44+L*6);expect(wav.subarray(0,44).equals(soundWavHeader(L))).toBe(true);
      expect(inspectSoundWav(wav)).toMatchObject({sampleRate:48000,channels:2,frames:L,encoding:"pcm_s24le"});}
  },120000);

  /**
   * Loudness is bounded: every bed peaks at the recipe's -18 dBFS less its preset's trim, its true
   * peak stays under -17 dBTP, and its integrated loudness lands between -34 and -28 LUFS, so under
   * the session's -6 dB cue gain a bed sits well below dialogue.
   */
  test("every bed's peak and loudness stay within bounds", async () => {
    for(const preset of AMBIENCE_PRESETS){const wav=await renderAmbience(preset.id,root),target=Math.round(8388607*10**((AMBIENCE_RECIPE.peakDbfs+preset.trimDb)/20));let peak=0;for(let i=0;i<L;i++)for(let ch=0;ch<2;ch++)peak=Math.max(peak,Math.abs(sample(wav,i,ch)));
      expect([preset.id,peak]).toEqual([preset.id,target]);const measured=meter(wav,preset.id);
      expect(measured.maxVolume).toBeLessThanOrEqual(-17.95);expect(measured.truePeak).toBeLessThanOrEqual(-17);
      expect([preset.id,measured.lufs,measured.lufs>=-34&&measured.lufs<=-28]).toEqual([preset.id,measured.lufs,true]);}
  },120000);

  /** The loop repeats without a click: the step from its last frame back to its first is no bigger than steps inside it. */
  test("a bed loops without a click at its seam", async () => {
    for(const preset of AMBIENCE_PRESETS){const wav=await renderAmbience(preset.id,root);
      for(let ch=0;ch<2;ch++){let largest=0;for(let i=1;i<L;i++)largest=Math.max(largest,Math.abs(sample(wav,i,ch)-sample(wav,i-1,ch)));
        expect([preset.id,ch,Math.abs(sample(wav,0,ch)-sample(wav,L-1,ch))<=largest]).toEqual([preset.id,ch,true]);}
      // The two channels are separately seeded, so the bed is wide rather than mono.
      let same=0;for(let i=0;i<L;i+=97)if(sample(wav,i,0)===sample(wav,i,1))same++;expect(same).toBeLessThan(L/97/10);}
  },120000);

  /** The graph names every source's seed, so nothing in it falls back to FFmpeg's random seed. */
  test("every noise source in a preset's graph carries its seed", () => {
    for(const preset of AMBIENCE_PRESETS){const graph=ambienceFilter(preset,L);
      expect(graph.match(/anoisesrc=/g)).toHaveLength(2);expect(graph).toContain(`seed=${preset.seed}:`);expect(graph).toContain(`seed=${preset.seed+1}:`);expect(graph).toContain(`atrim=end_sample=${L}`);}
  });
});
