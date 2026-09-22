import {afterAll,expect,test} from "bun:test";
import {existsSync,mkdirSync,mkdtempSync,readdirSync,rmSync,statSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {contentHash} from "../src/capabilities";
import {editFrameHashes} from "../src/edit-conform";
import {soundWavHeader} from "../src/sound-audio";
import {renderDeliveryMezzanine} from "../src/delivery-mezzanine";
import {DELIVERY_MEZZANINE_RECIPE,deliveryMezzaninePlan,mezzanineSource,validateDeliveryMezzaninePlan,type MezzanineSource} from "../../planner/src/delivery-mezzanine";

const root=mkdtempSync(join(tmpdir(),"hv-mezzanine-"));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const access=async()=>{};
const PARTS=3,PART_FRAMES=30,FRAMES=PARTS*PART_FRAMES,WIDTH=320,HEIGHT=240;

async function ffmpeg(args:string[],cwd:string):Promise<void>{
  const child=Bun.spawn(["ffmpeg","-v","error","-nostdin",...args],{cwd,stdin:"ignore",stdout:"ignore",stderr:"pipe"});
  const log=await new Response(child.stderr).text();
  expect({code:await child.exited,log}).toEqual({code:0,log:""});
}
/**
 * A conform directory as `conformEditPicture` and `conformEditAudio` leave one: FFV1 yuv420p parts
 * under an ffconcat list, and a canonical stereo 48 kHz 24-bit mix. The plan's frame hashes are
 * built the way the conform builds them — **per part, concatenated** — and the test asserts that is
 * the same list as a decode of the whole picture master, because the plan carries the conform's list
 * and the render measures the whole file.
 */
async function conform(name:string,pattern:string):Promise<{directory:string;source:MezzanineSource;frames:string[]}>{
  const directory=join(root,name),picture=join(directory,"picture"),audio=join(directory,"audio");
  mkdirSync(picture,{recursive:true});mkdirSync(audio,{recursive:true});
  const parts:string[]=[],frames:string[]=[];
  for(let index=0;index<PARTS;index++){
    const file="part-"+String(index).padStart(5,"0")+".mkv";
    await ffmpeg(["-f","lavfi","-i",pattern+"=size="+WIDTH+"x"+HEIGHT+":rate=30:duration="+PART_FRAMES/30,
      "-vf","settb=1/30,setpts=N","-frames:v",String(PART_FRAMES),"-an","-r","30","-c:v","ffv1","-level","3",
      "-threads","1","-pix_fmt","yuv420p","-map_metadata","-1","-y",join(picture,file)],picture);
    parts.push(file);
    frames.push(...await editFrameHashes(join(picture,file),PART_FRAMES,join(picture,"part-hashes.txt"),picture,access));
  }
  rmSync(join(picture,"part-hashes.txt"),{force:true});
  writeFileSync(join(picture,"index.ffconcat"),"ffconcat version 1.0\n"+parts.map(file=>"file '"+file+"'\nduration "+PART_FRAMES/30+"\n").join(""));
  const samples=FRAMES*1600,pcm=Buffer.alloc(samples*6);
  for(let sample=0;sample<samples;sample++){const value=Math.round(Math.sin(sample/24)*0x200000);
    pcm.writeIntLE(value,sample*6,3);pcm.writeIntLE(value,sample*6+3,3);}
  writeFileSync(join(audio,"final.wav"),Buffer.concat([soundWavHeader(samples),pcm]));
  const pictureBytes=parts.reduce((total,file)=>total+statSync(join(picture,file)).size,0);
  return {directory,source:{width:WIDTH,height:HEIGHT,frames:FRAMES,pictureFramesSha256:contentHash(frames),pictureBytes,mixBytes:44+samples*6},frames};
}

test("a mezzanine is the conform's own two streams, copied, and it proves it",async()=>{
  const made=await conform("film",'testsrc2');
  // The plan's proof comes from the conform's own per-part hashes; the render measures the whole
  // file. They have to be the same list or the proof would be of something else.
  expect(await editFrameHashes(join(made.directory,"picture/index.ffconcat"),FRAMES,join(root,"whole.txt"),root,access)).toEqual(made.frames);
  const plan=deliveryMezzaninePlan(made.source);
  expect(plan.output).toEqual({width:WIDTH,height:HEIGHT,frames:FRAMES,durationSec:3,video:"ffv1",pixelFormat:"yuv420p",audio:"pcm_s24le",sampleRate:48000,channels:2});
  expect(validateDeliveryMezzaninePlan(plan)).toEqual(plan);

  const destination=join(root,"mezzanine.mkv");
  const result=await renderDeliveryMezzanine(made.directory,plan,destination,root,access);
  expect(result.delivered).toMatchObject({width:WIDTH,height:HEIGHT,frames:FRAMES,video:"ffv1",pixelFormat:"yuv420p",audio:"pcm_s24le",sampleRate:48000,channels:2});
  expect(result.delivered.durationSec).toBeCloseTo(3,2);
  // Not merely a file of the right shape: the conform's own frames, and it says so in the result.
  expect(result.pictureFramesSha256).toBe(made.source.pictureFramesSha256);
  expect(result.recipeRevision).toBe(contentHash(DELIVERY_MEZZANINE_RECIPE));
  expect(result.file.bytes).toBe(statSync(destination).size);
  // Copying costs the streams and the container's bookkeeping, which is what the plan estimated.
  expect(result.file.bytes).toBeGreaterThan(made.source.pictureBytes);
  expect(result.file.bytes).toBeLessThanOrEqual(plan.estimatedBytes);

  // The thesis, measured: a lossy master of the same picture is smaller and is *not* the same
  // picture. That is why the mezzanine is a copy of the picture master and not a re-encode of the
  // delivered file, and why it is not ProRes either.
  const lossy=join(root,"lossy.mp4");
  await ffmpeg(["-f","concat","-safe","1","-i",join(made.directory,"picture/index.ffconcat"),"-map","0:v:0","-an",
    "-c:v","libx264","-preset","veryfast","-crf","18","-pix_fmt","yuv420p","-r","30","-y",lossy],root);
  expect(statSync(lossy).size).toBeLessThan(result.file.bytes);
  const lossyFrames=await editFrameHashes(lossy,FRAMES,join(root,"lossy.txt"),root,access);
  expect(lossyFrames.filter((value,index)=>value!==made.frames[index]).length).toBe(FRAMES);
},120_000);

test("the plan refuses what a mezzanine cannot honestly be",()=>{
  const source:MezzanineSource={width:1920,height:1080,frames:900,pictureFramesSha256:"a".repeat(64),pictureBytes:1024,mixBytes:44+900*1600*6};
  expect(deliveryMezzaninePlan(source).output.durationSec).toBe(30);
  expect(()=>deliveryMezzaninePlan({...source,width:1919})).toThrow("even export dimensions");
  expect(()=>deliveryMezzaninePlan({...source,height:1082})).toThrow("must be a whole number from 16 to 1080");
  expect(()=>deliveryMezzaninePlan({...source,frames:0})).toThrow("must be a whole number from 1 to 108000");
  expect(()=>deliveryMezzaninePlan({...source,pictureFramesSha256:"nope"})).toThrow("recorded picture frame hashes");
  expect(()=>deliveryMezzaninePlan({...source,pictureBytes:0})).toThrow("must have a size");
  // The mix's size is arithmetic, not a report: a mix of the wrong length means this plan is not
  // describing this conform, whatever it says it is describing.
  expect(()=>deliveryMezzaninePlan({...source,mixBytes:source.mixBytes+6})).toThrow("do not agree");
  // A lossless master of a long film does not fit beside the film, and the refusal says the number.
  const long={...source,frames:108000,mixBytes:44+108000*1600*6,pictureBytes:DELIVERY_MEZZANINE_RECIPE.limits.maximumBytes};
  expect(()=>deliveryMezzaninePlan(long)).toThrow("does not fit beside it");
  expect(()=>validateDeliveryMezzaninePlan({...deliveryMezzaninePlan(source),estimatedBytes:1})).toThrow("does not match the conform it names");
});

test("a conform that is not the one the plan names is refused, and nothing is left behind",async()=>{
  const made=await conform("named",'testsrc2'),plan=deliveryMezzaninePlan(made.source);
  const scratch=mkdtempSync(join(root,"work-"));
  const before=readdirSync(scratch);
  // A different picture of the same size and length: every check but the frame hashes passes, and
  // the frame hashes are the one that matters.
  const other=await conform("other",'smptebars');
  await expect(renderDeliveryMezzanine(other.directory,plan,join(scratch,"wrong.mkv"),scratch,access))
    .rejects.toThrow("not copied from this film's picture master");
  // A conform with nothing in it is refused by name before anything runs.
  const empty=join(root,"empty");mkdirSync(empty,{recursive:true});
  await expect(renderDeliveryMezzanine(empty,plan,join(scratch,"none.mkv"),scratch,access)).rejects.toThrow("no retained picture master");
  // And a plan made for a longer film than the conform holds.
  const short=deliveryMezzaninePlan({...made.source,frames:FRAMES-30,mixBytes:44+(FRAMES-30)*1600*6});
  await expect(renderDeliveryMezzanine(made.directory,short,join(scratch,"short.mkv"),scratch,access)).rejects.toThrow("frame count");
  // The probe and the frame list are the check's own, not the caller's to clean up.
  expect(readdirSync(scratch).filter(name=>!before.includes(name)).sort()).toEqual(["wrong.mkv"]);
  expect(existsSync(join(scratch,"none.mkv"))).toBe(false);
},180_000);

test("the source is read off the conform's own record, and the three counts have to agree",()=>{
  const conform={pictureFrames:Array.from({length:FRAMES},(_,index)=>String(index).padStart(64,"0")),
    picture:{parts:Array.from({length:PARTS},()=>({frames:PART_FRAMES}))}};
  const timeline={width:WIDTH,height:HEIGHT,frames:FRAMES},parts=Array.from({length:PARTS},()=>4096);
  const source=mezzanineSource(conform,timeline,parts);
  expect(source).toEqual({width:WIDTH,height:HEIGHT,frames:FRAMES,pictureFramesSha256:contentHash(conform.pictureFrames),
    pictureBytes:PARTS*4096,mixBytes:44+FRAMES*1600*6});
  expect(deliveryMezzaninePlan(source).source).toEqual(source);
  // A conform whose parts do not add up to its timeline is not a film to make a master of, and the
  // refusal names all three numbers rather than picking one to believe.
  expect(()=>mezzanineSource({...conform,picture:{parts:conform.picture.parts.slice(1)}},timeline,parts.slice(1))).toThrow("They have to agree");
  expect(()=>mezzanineSource({...conform,pictureFrames:conform.pictureFrames.slice(1)},timeline,parts)).toThrow("They have to agree");
  expect(()=>mezzanineSource(conform,timeline,parts.slice(1))).toThrow("were found on disk");
  expect(()=>mezzanineSource(conform,timeline,[4096,0,4096])).toThrow("must have a size");
  expect(()=>mezzanineSource({pictureFrames:[],picture:{parts:[]}},timeline,[])).toThrow("no picture master to deliver");
});

test("the operator can make one from a rendered job, and is told what it does not carry",async()=>{
  const made=await conform("operator",'testsrc2');
  const parts=Array.from({length:PARTS},(_,index)=>({file:"picture/part-"+String(index).padStart(5,"0")+".mkv",frames:PART_FRAMES}));
  writeFileSync(join(made.directory,"conform.json"),JSON.stringify({pictureFrames:made.frames,picture:{parts}}));
  writeFileSync(join(made.directory,"timeline.json"),JSON.stringify({width:WIDTH,height:HEIGHT,frames:FRAMES}));
  const script=fileURLToPath(new URL("../../../scripts/delivery-mezzanine.ts",import.meta.url));
  const out=join(root,"operator.mkv");
  const child=Bun.spawn([process.execPath,script,"--conform",made.directory,"--out",out],{cwd:root,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({code,stderr}).toEqual({code:0,stderr:""});
  expect(stdout).toContain("320x240 90 frames, 3.00 s, ffv1 yuv420p + pcm_s24le 48000 Hz 2 ch");
  expect(stdout).toContain("every frame is this film's own");
  // What it does not carry is printed on every run, not only in the documentation.
  expect(stdout).toContain("a timecode track");
  expect(statSync(out).size).toBeGreaterThan(made.source.pictureBytes);
  // A conform it cannot read is an exit 1 with a message and nothing on stdout.
  const missing=Bun.spawn([process.execPath,script,"--conform",join(root,"nowhere")],{cwd:root,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  const [failed,quiet,said]=await Promise.all([missing.exited,new Response(missing.stdout).text(),new Response(missing.stderr).text()]);
  expect({failed,quiet}).toEqual({failed:1,quiet:""});
  expect(said).toContain("The mezzanine could not be made");
},180_000);
