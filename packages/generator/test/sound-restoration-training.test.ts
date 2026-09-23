/**
 * HV-024-06 — the file a learned noise profile is trained on had its shape described in two places.
 *
 * A reference-trained restoration does not hand ffmpeg the stem. It hands it the reference, then a
 * gap of silence, then the stem, and trims the result back to the stem. Two places have to agree
 * about where the stem starts in that file:
 *
 *     // packages/planner/src/sound-restoration.ts
 *     const prefix=t.reference?t.reference.frames+RESTORATION_RECIPE.trainingGapFrames:0
 *
 *     // packages/generator/src/sound-restoration.ts
 *     writeFileSync(input,Buffer.concat([soundWavHeader(r.frames+2400+frames),bytes,Buffer.alloc(2400*6)]))
 *
 * One reads the gap from the recipe; the other spells its current value out, twice. Change
 * `trainingGapFrames` and the trim lands 2,400 samples — 50 ms — away from where the stem actually
 * begins, and **every check still passes**: `quantize` compares only the output's sample count with
 * the stem's, which `atrim` guarantees whatever it trims, and `validateRestorationReport` compares
 * the recorded filter with `restorationFilter`, which is one side of the disagreement comparing
 * itself with itself. The delivered stem would simply be out of sync with picture and with every
 * untreated stem beside it.
 *
 * Nor would the existing tests have shown it. The impulse-alignment test uses `settings()` with no
 * reference, so it never builds a training file at all; the reference test measures tone energy over
 * `i>100000 && i<190000` inside a tone spanning 96000–192000, which a 2,400-sample shift stays
 * comfortably inside.
 *
 * So: one function owns the layout, and the alignment claim is made with a reference for the first
 * time.
 */
import {expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,readFileSync as read,rmSync,writeFileSync} from "node:fs";
import {join,sep} from "node:path";
import {tmpdir} from "node:os";
import {soundWav} from "../src/sound-audio";
import {restoreSoundTracks} from "../src/sound-restoration";
import {RESTORATION_RECIPE,RESTORATION_STEMS,restorationFilter,restorationTraining,type SoundRestoration} from "../../planner/src/sound-restoration";

const GAP=RESTORATION_RECIPE.trainingGapFrames;

test("the trim and the file it trims are the same arithmetic, stated once",()=>{
  // What the two sides used to say separately. Read from the recipe on both sides now, and from one
  // function, so a change to the gap moves the file and the trim together or neither.
  for (const [referenceFrames,frames] of [[48000,144000],[12000,48001],[240000,480000],[600,600]] as const) {
    const layout=restorationTraining(referenceFrames,frames);
    expect(layout).toEqual({referenceFrames,gapFrames:GAP,prefixFrames:referenceFrames+GAP,
      totalFrames:referenceFrames+GAP+frames,startSample:referenceFrames+GAP+RESTORATION_RECIPE.delayFrames});
    // The filter trims from exactly there, and takes exactly the stem.
    const filter=restorationFilter({track:"ambience",amountDb:12,noiseFloorDb:-45,tracking:false,smoothing:5,
      reference:{start:0,frames:referenceFrames,attested:true}},frames);
    expect(filter).toContain("atrim=start_sample="+layout.startSample+":end_sample="+(layout.startSample+frames));
    // And the file it trims holds the reference, the gap and the stem, and nothing else.
    expect(layout.totalFrames).toBe(layout.prefixFrames+frames);
    expect(layout.startSample-layout.prefixFrames).toBe(RESTORATION_RECIPE.delayFrames);
  }
  // Without a reference there is no training file, and the trim is the processor's own delay.
  expect(restorationFilter({track:"ambience",amountDb:12,noiseFloorDb:-45,tracking:false,smoothing:5},48000))
    .toContain("atrim=start_sample="+RESTORATION_RECIPE.delayFrames+":end_sample="+(RESTORATION_RECIPE.delayFrames+48000));
});

test("and a track restored from a learned reference comes back in sync, sample for sample",async()=>{
  // The claim the arithmetic is for, made through the real pipeline: impulses come out where they
  // went in. A disagreement of one gap between the file and the trim moves every one of them by
  // 2,400 samples, and nothing else in this suite is looking at where they land.
  const frames=48000*3,marks=[60000,96000,143000];
  const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-restore-training-"))),original=join(root,"original");
  // Checked here rather than in the cleanup below, where a throw would overwrite the test's own.
  if (!root.startsWith(realpathSync(tmpdir())+sep)) throw new Error("Unsafe fixture root");
  mkdirSync(original);
  let seed=4133;
  const pcm=Buffer.alloc(frames*6);
  for (let i=0;i<frames;i++) for (let channel=0;channel<2;channel++) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const noise=(seed/4294967296-.5)*.004,value=marks.includes(i)?.2/(channel+1):noise;
    pcm.writeIntLE(Math.round(value*8388608),i*6+channel*3,3);
  }
  const zero=soundWav(Buffer.alloc(frames*6));
  for (const stem of RESTORATION_STEMS) writeFileSync(join(original,stem+".wav"),["ambience","me","mix"].includes(stem)?soundWav(pcm):zero);
  const peaks=Object.fromEntries(RESTORATION_STEMS.map(stem=>[stem,["ambience","me","mix"].includes(stem)?8388608:0])) as Record<string,number>;
  // A reference over the first second, which holds noise and none of the marks.
  const plan:SoundRestoration={schema:"hv-sound-restoration/1",tracks:[{track:"ambience",amountDb:.1,noiseFloorDb:-80,
    tracking:false,smoothing:5,reference:{start:0,frames:48000,attested:true}}]};
  try {
    const result=await restoreSoundTracks(original,join(root,"stems"),join(root,"restoration"),plan,frames,peaks as never,async()=>{});
    expect(result.report.tracks[0]!.referenceSha256).toBeDefined();
    const out=read(join(root,"stems","ambience.wav"));
    for (const at of marks) {
      let peak=0,index=-1;
      for (let i=Math.max(0,at-GAP-50);i<Math.min(frames,at+GAP+51);i++) {
        const value=Math.abs(out.readIntLE(44+i*6,3));
        if (value>peak) {peak=value;index=i;}
      }
      // Searched a whole gap either side, so a shift would be found rather than missed.
      expect({at,index}).toEqual({at,index:at});
      expect(peak).toBeGreaterThan(1_000_000);
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
},60_000);

test("and neither side of it spells the gap out again",()=>{
  // The guard on the shape. The gap is a number in the recipe; a file that writes its current value
  // is a second description of it, and this is the one that was wrong.
  const source=readFileSync(new URL("../src/sound-restoration.ts",import.meta.url),"utf8");
  const code=source.replaceAll(/^\s*(\*|\/\/).*$/gm,"");
  expect(code).not.toContain(String(GAP));
  expect(code).toContain("restorationTraining(r.frames,frames)");
  // And the planner's own use of it goes through the same function rather than re-adding the parts.
  const planner=readFileSync(new URL("../../planner/src/sound-restoration.ts",import.meta.url),"utf8");
  const filter=planner.slice(planner.indexOf("export function restorationFilter("),planner.indexOf("export function restorationFiles("));
  expect(filter).toContain("restorationTraining(t.reference.frames,frames).startSample");
  expect(filter).not.toContain("trainingGapFrames");
});
