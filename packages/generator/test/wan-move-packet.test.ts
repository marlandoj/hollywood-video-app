import {afterAll,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {compileWanMovePacket,verifyWanMovePacket,writeWanMovePacket} from "../src/wan-move-packet";
import type {SubjectMotionPlan} from "../../planner/src/subject-motion";
const root=mkdtempSync(join(tmpdir(),"hv-wan-move-"));afterAll(()=>rmSync(root,{recursive:true,force:true}));
const image=join(root,"source.png"),result=Bun.spawnSync(["ffmpeg","-y","-v","error","-f","lavfi","-i","color=white:s=832x480","-frames:v","1",image]);
if(result.exitCode)throw new Error(result.stderr.toString());
const png=readFileSync(image),hash=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const plan:SubjectMotionPlan={schema:"hv-subject-motion/1",source:{sha256:hash(png),width:832,height:480},prompt:"A red ball moves right.",seed:5,subjects:[{id:"ball",label:"Red ball",tracks:[{id:"center",keyframes:[{frame:0,x:0,y:10000,easing:"linear",visible:true},{frame:80,x:10000,y:0,easing:"linear",visible:true}]}]}]};
test("native packets preserve the exact source and produce immutable, verifiable inputs only",()=>{
  const packet=compileWanMovePacket(plan,png),directory=writeWanMovePacket(join(root,"packet"),packet),verified=verifyWanMovePacket(directory);
  expect(packet["source.png"]).toEqual(png);expect(verified).toMatchObject({subjects:1,tracks:1,rendered:false});
  const manifest=JSON.parse(packet["manifest.json"].toString());expect(manifest.status).toBe("inputs-only");expect(manifest.timeline).toEqual({frames:81,fps:16,lastSampleSeconds:5,encodedDurationSeconds:5.0625,nativeConditioningStride:4});
  expect(manifest.trackOrder).toEqual([{subjectId:"ball",trackId:"center"}]);expect(manifest.inputArguments).toContain("--track_visibility");
  expect(compileWanMovePacket(plan,png)).toEqual(packet);
  expect(()=>writeWanMovePacket(directory,packet)).toThrow();expect(verifyWanMovePacket(directory)).toEqual(verified);
  const changed=Buffer.from(packet["tracks.npy"]);changed[changed.length-1]^=1;writeFileSync(join(directory,"tracks.npy"),changed);
  expect(()=>verifyWanMovePacket(directory)).toThrow("tracks.npy");
  writeFileSync(join(directory,"tracks.npy"),packet["tracks.npy"]);writeFileSync(join(directory,"manifest.json"),"{}");
  expect(()=>verifyWanMovePacket(directory)).toThrow("manifest.json");
});
test("packet compilation refuses mismatched bytes, malformed PNGs and unsafe prompts before writing",()=>{
  const changed=Buffer.from(png);changed[changed.length-1]^=1;
  expect(()=>compileWanMovePacket(plan,changed)).toThrow("image changed");
  expect(()=>compileWanMovePacket({...plan,source:{...plan.source,sha256:hash(changed)}},changed)).toThrow("checksum");
  expect(()=>compileWanMovePacket({...plan,source:{...plan.source,width:480,height:832}},png)).toThrow("dimensions");
  const tail=Buffer.concat([png,Buffer.from("trailing")]);expect(()=>compileWanMovePacket({...plan,source:{...plan.source,sha256:hash(tail)}},tail)).toThrow("ending");
  const short=png.subarray(0,png.length-12);expect(()=>compileWanMovePacket({...plan,source:{...plan.source,sha256:hash(short)}},short)).toThrow("incomplete");
  expect(()=>compileWanMovePacket({...plan,prompt:"sex with a minor"},png)).toThrow();
});
test("operator CLI compiles and verifies paths containing spaces, refuses overwrite and creates no output on bad input",()=>{
  const file=join(root,"motion plan.json"),output=join(root,"compiled packet"),script=join(import.meta.dir,"../../../scripts/subject-motion.ts");writeFileSync(file,JSON.stringify(plan));
  const args=[process.execPath,script,"compile","--image",image,"--out",output,"--plan",file];
  const first=Bun.spawnSync(args);expect(first.exitCode).toBe(0);expect(JSON.parse(first.stdout.toString()).rendered).toBe(false);
  expect(Bun.spawnSync([process.execPath,script,"verify",output]).exitCode).toBe(0);
  expect(Bun.spawnSync(args).exitCode).not.toBe(0);
  writeFileSync(file,JSON.stringify({...plan,seed:-1}));const bad=join(root,"invalid packet");
  expect(Bun.spawnSync(args.map(value=>value===output?bad:value)).exitCode).not.toBe(0);expect(existsSync(bad)).toBe(false);
},15000);

test("the full six-subject, 48-track, 1008-keyframe plan survives serialization and packet verification",()=>{
  const maximum:SubjectMotionPlan={...plan,subjects:Array.from({length:6},(_,s)=>({id:"subject-"+s,label:"Subject "+s,tracks:Array.from({length:8},(_,t)=>({id:"track-"+t,keyframes:Array.from({length:21},(_,f)=>({frame:f*4,x:(s*8+t)*200,y:5000,easing:"smooth" as const,visible:true}))}))}))};
  const packet=compileWanMovePacket(maximum,png);expect(packet["plan.json"].length).toBeGreaterThan(128*1024);
  expect(verifyWanMovePacket(writeWanMovePacket(join(root,"maximum"),packet))).toMatchObject({subjects:6,tracks:48,rendered:false});
});

test("portrait packets retain pixel extents and top-left ordering",()=>{
  const portrait=join(root,"portrait.png"),made=Bun.spawnSync(["ffmpeg","-y","-v","error","-f","lavfi","-i","color=white:s=480x832","-frames:v","1",portrait]);expect(made.exitCode).toBe(0);
  const source=readFileSync(portrait),packet=compileWanMovePacket({...plan,source:{sha256:hash(source),width:480,height:832}},source),bytes=packet["tracks.npy"],start=10+bytes.readUInt16LE(8);
  expect(bytes.readFloatLE(start)).toBe(0);expect(bytes.readFloatLE(start+4)).toBe(831);
  expect(bytes.readFloatLE(bytes.length-8)).toBe(479);expect(bytes.readFloatLE(bytes.length-4)).toBe(0);
  expect(verifyWanMovePacket(writeWanMovePacket(join(root,"portrait-packet"),packet)).rendered).toBe(false);
});
