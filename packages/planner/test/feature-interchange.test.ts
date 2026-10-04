/**
 * HV-023-05 — the joined feature's cut, exported as OTIO and as a CMX 3600 EDL, reads back to every
 * shot of every sequence at the joined film's frames.
 *
 * HV-030-30's three-sequence fixture, with shot render records for each final, and real media: each
 * sequence film is made with ffmpeg from flat-colour shots joined the way the worker joins a final's
 * shots (a 15-frame dissolve), and the three films are joined by the real assembler
 * (`assembleFeatureFilm`) with an opening title and end credits. The exported cut is read back by the
 * independent readers of HV-023-04 and checked against frames worked by hand, against the joined
 * export's ffprobe length, and against the picture itself: the middle frame of every clip shows that
 * clip's shot.
 */
import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assembleFeatureFilm} from "../../assembler/src/feature-film";
import {editCmx3600,editOtio} from "../src/edit-interchange";
import {FEATURE_FILM_CROSSFADE_FRAMES,FINAL_SHOT_CROSSFADE_FRAMES} from "../src/feature-film";
import {featureInterchangeCut} from "../src/feature-interchange";
import {featureFixture} from "../../../test/fixtures/feature-film";
import {otioAsEvents,readEdl,readOtio} from "../../../test/fixtures/interchange-readers";

const TMP=mkdtempSync(join(tmpdir(),"hv-feature-interchange-"));
afterAll(()=>rmSync(TMP,{recursive:true,force:true}));
const run=(args:string[])=>{const result=Bun.spawnSync(args);if(result.exitCode)throw new Error(result.stderr.toString());return result.stdout;};
/** Each sequence's shots, in frames; every one a whole number of tenths of a second. */
const SHOTS=[[60,45,75],[90,51],[42,66,54]];
const COLORS=[["blue","green","yellow"],["cyan","magenta"],["white","orange","purple"]];
const RGB:Record<string,number[]>={blue:[0,0,255],green:[0,128,0],yellow:[255,255,0],cyan:[0,255,255],magenta:[255,0,255],white:[255,255,255],orange:[255,165,0],purple:[128,0,128],credits:[0x11,0x13,0x18],red:[255,0,0]};
const W=1280;

/** A sequence film as the worker assembles a final: its shots dissolve into each other over 15 frames. */
function sequenceFilm(number:number):string{
  const shots=SHOTS[number-1]!,colors=COLORS[number-1]!,path=join(TMP,"film-"+number+".mp4"),xf=FINAL_SHOT_CROSSFADE_FRAMES/30;
  const inputs=shots.flatMap((frames,index)=>["-f","lavfi","-i",`color=c=${colors[index]}:s=320x180:r=30:d=${(frames/30).toFixed(1)}`]);
  let filter="",last="[0:v]",offset=0;
  for(let index=1;index<shots.length;index++){offset+=shots[index-1]!/30-xf;const out=`[x${index}]`;filter+=`${last}[${index}:v]xfade=transition=fade:duration=${xf}:offset=${offset.toFixed(3)}${out};`;last=out;}
  const seconds=(shots.reduce((sum,frames)=>sum+frames,0)-FINAL_SHOT_CROSSFADE_FRAMES*(shots.length-1))/30;
  run(["ffmpeg","-y","-v","error",...inputs,"-f","lavfi","-i",`sine=frequency=440:sample_rate=44100:duration=${seconds}`,"-filter_complex",filter+`${last}format=yuv420p[v]`,
    "-map","[v]","-map",`${shots.length}:a`,"-c:v","libx264","-pix_fmt","yuv420p","-r","30","-c:a","aac","-shortest",path]);
  return path;
}
function graphic(name:string,frames:number,background:string){
  const path=join(TMP,name+".mkv");
  run(["ffmpeg","-y","-v","error","-f","lavfi","-i",`color=c=red:s=80x40:r=30,format=rgba,pad=320:180:0:0:color=${background}`,"-frames:v",String(frames),"-c:v","ffv1","-pix_fmt","bgra",path]);
  return {path,frames};
}
/** The colour at frame `frame` of the export, at (x, y), named by the nearest of the test's colours. */
function colour(path:string,frame:number,x:number,y:number):string{
  const raw=run(["ffmpeg","-v","error","-i",path,"-vf",`select=eq(n\\,${frame})`,"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","-"]),at=(y*W+x)*3,pixel=[raw[at]!,raw[at+1]!,raw[at+2]!];
  return Object.entries(RGB).map(([name,rgb])=>[name,rgb.reduce((sum,value,index)=>sum+(value-pixel[index]!)**2,0)] as const).sort((a,b)=>a[1]-b[1])[0]![0];
}

test("the joined feature's cut reads back from OTIO and EDL to every shot of every sequence, at the joined film's frames and length", async () => {
  expect([FINAL_SHOT_CROSSFADE_FRAMES,FEATURE_FILM_CROSSFADE_FRAMES]).toEqual([15,12]);
  const fixture=featureFixture("feature-project",SHOTS),plan=fixture.featurePlan(true);
  expect([plan.title!.frames,plan.credits!.frames]).toEqual([120,180]);
  const joined=await assembleFeatureFilm({films:[1,2,3].map(number=>({path:sequenceFilm(number),captionsPath:null})),title:graphic("title",plan.title!.frames,"black@0"),credits:graphic("credits",plan.credits!.frames,"0x111318"),
    width:plan.width,height:plan.height,crossfadeFrames:plan.crossfadeFrames,outDir:join(TMP,"joined"),projectId:"feature-project",assembledAt:"2026-10-04T00:00:00.000Z",record:{},c2pa:null});
  expect(joined.crossfadeSec).toBe(0.4);
  const job=fixture.featureFilmJob(plan,false,Number(joined.durationSec.toFixed(3))),cut=featureInterchangeCut(job);
  const otioText=editOtio(cut),edlText=editCmx3600(cut),otio=readOtio(otioText),edl=readEdl(edlText);

  // Worked by hand. Sequence films: 1 is 60+45+75 less two 15-frame dissolves = 150 frames, 2 is 126, 3 is 132.
  // They start at 0, 150-12 = 138 and 138+126-12 = 252, and end at 384; the credits run 384-564. Shots of one
  // film are cut at the middle of their dissolve (7 frames in); films at the middle of the join (6 frames in).
  const shot=(sequence:number,number:number,sourceIn:number,sourceOut:number,recordIn:number,dissolve=false)=>({name:`Sequence ${sequence} shot seq${sequence}-shot${number}`,jobId:`mix-${sequence}`,
    clipId:`s${sequence}-seq${sequence}-shot${number}`,sourceIn,sourceOut,recordIn,recordOut:recordIn+sourceOut-sourceIn,dissolveIn:dissolve?{before:6,after:6}:null});
  const v1=[
    shot(1,1,0,52,0),shot(1,2,52,82,52),shot(1,3,82,144,82),
    shot(2,1,6,82,144,true),shot(2,2,82,120,220),
    shot(3,1,6,34,258,true),shot(3,2,34,85,286),shot(3,3,85,132,337),
    {name:"End credits",jobId:"g-credits",clipId:"credits",sourceIn:0,sourceOut:180,recordIn:384,recordOut:564,dissolveIn:null},
  ];
  expect(otio.startFrame).toBe(108000);
  expect(otio.tracks.map(track=>[track.name,track.kind,track.frames])).toEqual([["V1","Video",564],["V2","Video",564]]);
  expect(otio.tracks[0]!.clips).toEqual(v1);
  expect(otio.tracks[1]!.clips).toEqual([{name:"Opening title",jobId:"g-title",clipId:"title",sourceIn:0,sourceOut:120,recordIn:0,recordOut:120,dissolveIn:null}]);
  // Every shot of every sequence, in order, each named by its final's render record.
  const records=[1,2,3].flatMap(number=>fixture.final(number).output!.shotRenders!.map(record=>({sequence:number,finalJobId:`final-${number}`,shotId:record.shotId,renderRevision:record.revision})));
  const clips=JSON.parse(otioText).tracks.children[0].children.filter((item:{OTIO_SCHEMA:string})=>item.OTIO_SCHEMA==="Clip.1");
  expect(clips.map((clip:{metadata:{hv:{shot?:unknown}}})=>clip.metadata.hv.shot).filter(Boolean)).toEqual(records);
  expect(records).toHaveLength(8);
  expect(otio.metadata).toMatchObject({hv:{schema:"hv-feature-interchange/1",featureFilmJobId:"feature-film-1",planRevision:plan.revision,width:1280,height:720}});
  expect((otio.metadata as {hv:{notCarried:string[]}}).hv.notCarried).toContain("The opening title is an overlay on picture layer 2 in the OTIO; the EDL carries picture layer 1 only.");

  // The EDL in CMX terms: each event starts where the dissolve into it starts, with the borrowed handle.
  expect(edl.title).toBe("Feature film");expect(edl.fcm).toBe("NON-DROP FRAME");
  const event=(jobId:string,sourceIn:number,sourceOut:number,recordIn:number,recordOut:number,dissolve:number|null=null)=>({jobId,sourceIn,sourceOut,recordIn,recordOut,dissolve});
  expect(edl.events).toEqual([
    event("mix-1",0,52,0,52),event("mix-1",52,82,52,82),event("mix-1",82,138,82,138),
    event("mix-2",0,82,138,220,12),event("mix-2",82,114,220,252),
    event("mix-3",0,34,252,286,12),event("mix-3",34,85,286,337),event("mix-3",85,132,337,384),
    event("g-credits",0,180,384,564),
  ]);
  expect(otioAsEvents(otio.tracks[0]!)).toEqual(edl.events);
  expect(edlText.split("\n").filter(line=>/^\d{3} /.test(line)).slice(3,5)).toEqual([
    "004  HV01     V     C        00:00:04:18 00:00:04:18 01:00:04:18 01:00:04:18",
    "004  HV02     V     D    012 00:00:00:00 00:00:02:22 01:00:04:18 01:00:07:10",
  ]);

  // The joined export is the length the cut says, to within a frame.
  const probe=JSON.parse(run(["ffprobe","-v","error","-count_frames","-select_streams","v:0","-show_entries","stream=nb_read_frames:format=duration","-of","json",joined.mp4Path]).toString());
  expect(Math.abs(Number(probe.streams[0].nb_read_frames)-564)).toBeLessThanOrEqual(1);
  expect(Math.abs(Number(probe.format.duration)*30-564)).toBeLessThanOrEqual(1);
  // And the picture agrees: the middle frame of every clip shows that clip's shot; the title is over the start only.
  const expected=[...COLORS.flat(),"credits"];
  expect(v1.map(clip=>colour(joined.mp4Path,Math.floor((clip.recordIn+clip.recordOut)/2),800,600))).toEqual(expected);
  expect([colour(joined.mp4Path,60,40,40),colour(joined.mp4Path,130,40,40)]).toEqual(["red","yellow"]);

  // Media is named by job id: no path, URL, file name or expiry in either file.
  for(const text of [otioText,edlText]){expect(text).toContain("urn:hv:job:mix-2");expect(text).not.toMatch(/:\/\/|feature-project\/|\.mp4|\.mkv|\.m3u8|expires|token/i);}
},120000);

test("a short film joins with a cut and its single shot needs no dissolve", () => {
  // Three one-shot films of 40 frames: under the 48 frames a 12-frame join needs, so the assembler cuts.
  const fixture=featureFixture("feature-project",[[40],[40],[40]]),cut=featureInterchangeCut(fixture.featureFilmJob(fixture.featurePlan(),false,4));
  const otio=readOtio(editOtio(cut)),edl=readEdl(editCmx3600(cut));
  expect(otio.tracks).toHaveLength(1);
  expect(otio.tracks[0]!.clips.map(clip=>[clip.jobId,clip.sourceIn,clip.sourceOut,clip.recordIn,clip.recordOut,clip.dissolveIn])).toEqual([["mix-1",0,40,0,40,null],["mix-2",0,40,40,80,null],["mix-3",0,40,80,120,null]]);
  expect(edl.events.every(event=>event.dissolve===null)).toBe(true);
});

test("a cut that can't be written exactly is refused by name", () => {
  const fixture=featureFixture("feature-project",SHOTS),plan=fixture.featurePlan(true),job=fixture.featureFilmJob(plan,false,(384+180)/30);
  expect(featureInterchangeCut(job).frames).toBe(564);
  // Not finished, or not a feature's film.
  expect(()=>featureInterchangeCut({...job,status:"running",output:undefined})).toThrow("The feature's film isn't finished. Export its cut after the join completes.");
  expect(()=>featureInterchangeCut(fixture.final(1))).toThrow("Only a feature's joined film is exported as the feature's cut.");
  // The records don't add up to the export's measured length.
  expect(()=>featureInterchangeCut(fixture.featureFilmJob(plan,false,20))).toThrow("The feature's film is 20 s long, but its shots' records add up to 18.800 s. Join the feature again before exporting its cut.");
  // A final with no shot records: its shots can't be placed.
  const bare=featureFixture("feature-project");
  expect(()=>featureInterchangeCut(bare.featureFilmJob())).toThrow("Sequence 1's final has no shot records, so its shots can't be placed in the feature's cut.");
  // A shot that isn't a whole number of frames, and a shot shorter than the dissolves around it.
  const ragged=featureFixture("feature-project",[[60,45.5,75],[90,51],[42,66,54]]);
  expect(()=>featureInterchangeCut(ragged.featureFilmJob(ragged.featurePlan(),false,18.8))).toThrow("Sequence 1's shot seq1-shot2 doesn't end on a whole frame at 30 fps, so its cut can't be written exactly.");
  const short=featureFixture("feature-project",[[60,15,75],[90,51],[42,66,54]]);
  expect(()=>featureInterchangeCut(short.featureFilmJob(short.featurePlan(),false,17.8))).toThrow("Sequence 1 shot seq1-shot2 is shorter than the dissolves around it, so the feature's cut can't be written exactly.");
  // A render record changed after the join was admitted.
  const tampered=structuredClone(job),record=tampered.featureFilm!.films[0]!.job.soundMix!.source.base.output!.shotRenders![0]!;record.clip.durationSec=3;
  expect(()=>featureInterchangeCut(tampered)).toThrow("The feature's film plan changed after admission.");
});
