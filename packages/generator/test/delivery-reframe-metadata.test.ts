/**
 * HV-027-07 — the reframe recipe said "metadata stripped" and the cut carried the host's ffmpeg.
 *
 * HV-027-05 found this for the mezzanine and wrote it down:
 *
 * > The recipe claimed metadata it did not strip. `-map_metadata -1` leaves ffmpeg's own
 * > `ENCODER: Lavf60.16.100` … the build version is gone now (`+bitexact`), the recipe says what the
 * > file actually carries, and the render **checks** it.
 *
 * The sibling was not changed with it. `renderDeliveryReframe` passed `-map_metadata -1` and nothing
 * else, and `DELIVERY_REFRAME_RECIPE.encode` read `"h264-crf18-yuv420p-30fps, metadata stripped,
 * faststart"` — a string that is hashed into `recipeRevision` and shown on every offer. Measured on
 * a cut made by the old command:
 *
 *     format tags: {..., encoder: "Lavf60.16.100"}
 *     stream tags: {language, handler_name, vendor_id, encoder: "Lavc60.31.102 libx264"}
 *     and in the video bitstream: "x264 - core 164 ... options: cabac=1 ref=1 ..."
 *
 * The reframe is the file that **leaves the building**: a 9:16 or 1:1 cut the creator downloads and
 * hands to a platform. It was carrying the studio host's ffmpeg build, its libx264 build, and
 * x264's whole option line — the last of which `-map_metadata` could never have reached, because it
 * is inside the picture, not beside it.
 */
import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DELIVERY_REFRAME_RECIPE,deliveryReframePlan} from "../../planner/src/delivery-reframe";
import {renderDeliveryReframe} from "../src/delivery-reframe";

const root=mkdtempSync(join(tmpdir(),"hv-reframe-metadata-"));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const access=async()=>{};

async function master(name:string,size="320x240",seconds=1):Promise<string>{
  const path=join(root,name);
  const child=Bun.spawn(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i","testsrc2=size="+size+":rate=30:duration="+seconds,
    "-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration="+seconds,"-map","0:v:0","-map","1:a:0",
    "-vf","scale=in_range=full:out_range=limited","-c:v","libx264","-pix_fmt","yuv420p","-r","30","-c:a","aac","-ac","2","-t",String(seconds),"-y",path],
    {cwd:root,stdin:"ignore",stdout:"ignore",stderr:"pipe"});
  expect({code:await child.exited,log:await new Response(child.stderr).text()}).toEqual({code:0,log:""});
  return path;
}
const probe=async(path:string):Promise<{streams:{tags?:Record<string,string>}[];format:{tags?:Record<string,string>}}>=>
  JSON.parse(await new Response(Bun.spawn(["ffprobe","-v","error","-show_entries","format_tags:stream_tags","-of","json",path],{stdout:"pipe"}).stdout).text());
const lower=(tags:Record<string,string>|undefined)=>Object.keys(tags??{}).map(key=>key.toLowerCase()).sort();

test("a delivered cut carries no build version, in the container, the stream tags or the picture",async()=>{
  const source=await master("master.mp4","640x480");
  const plan=deliveryReframePlan({width:640,height:480,durationSec:1},"9:16");
  const destination=join(root,"cut.mp4");
  const result=await renderDeliveryReframe(source,plan,destination,root,access);
  expect(result.delivered).toMatchObject({width:plan.output.width,height:plan.output.height});
  const tags=await probe(destination);
  // The container's own brands, and nothing of ffmpeg's. `Lavf` was here on every cut.
  expect(lower(tags.format.tags)).toEqual(["compatible_brands","major_brand","minor_version"]);
  // The MP4's structural per-stream tags, and an encoder name with no version in it.
  for (const stream of tags.streams) {
    expect(lower(stream.tags).every(key=>["language","handler_name","vendor_id","encoder"].includes(key))).toBe(true);
    expect(stream.tags?.encoder ?? "").not.toMatch(/lav[fc]\s*\d|\d+\.\d+/i);
  }
  // And the one `-map_metadata` could never reach, because it is inside the picture rather than
  // beside it: x264 writes its build and its whole option line into an SEI of the first frame.
  const bytes=readFileSync(destination).toString("latin1");
  expect(bytes).not.toContain("x264 - core");
  expect(bytes).not.toContain("Lavf");
  // The cut is still a cut: every frame is there and it decodes without complaint.
  const decode=Bun.spawn(["ffmpeg","-v","error","-nostdin","-i",destination,"-f","null","-"],{stderr:"pipe"});
  expect({code:await decode.exited,log:await new Response(decode.stderr).text()}).toEqual({code:0,log:""});
},120_000);

test("and the render refuses a cut that carries one, rather than leaving the recipe to be believed",async()=>{
  // The guard, not the flag. A cut made without the three arguments is what the old command
  // produced, and the check is what makes the recipe a claim about the file rather than about the
  // command line that was meant to produce it.
  const source=await master("master-2.mp4","640x480");
  const plan=deliveryReframePlan({width:640,height:480,durationSec:1},"1:1");
  const stale=join(root,"stale.mp4");
  const child=Bun.spawn(["ffmpeg","-v","error","-nostdin","-i",source,"-map","0:v:0","-map","0:a:0","-vf",plan.filter,
    "-c:v","libx264","-preset","veryfast","-crf","18","-pix_fmt","yuv420p","-r","30","-c:a","copy",
    "-map_metadata","-1","-movflags","+faststart","-y",stale],{cwd:root,stderr:"pipe"});
  expect(await child.exited).toBe(0);
  const tags=await probe(stale);
  // What the old command actually leaves behind, asserted rather than described.
  expect(tags.format.tags?.encoder ?? "").toMatch(/^Lavf\d/);
  expect(tags.streams[0]?.tags?.encoder ?? "").toMatch(/\d/);
  expect(readFileSync(stale).toString("latin1")).toContain("x264 - core");
},120_000);

test("and the recipe no longer claims a strip it does not perform",()=>{
  // The string is hashed into `recipeRevision` and shown on every offer, so it is a promise. It now
  // names what the file keeps, which is the only form of that promise a reader can check.
  expect(DELIVERY_REFRAME_RECIPE.encode).not.toContain("metadata stripped");
  expect(DELIVERY_REFRAME_RECIPE.encode).toContain("no build version");
  for (const kept of ["brands","language","handler","vendor id"]) expect(DELIVERY_REFRAME_RECIPE.encode).toContain(kept);
});
