import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DELIVERY_FORMATS,DELIVERY_REFRAME_RECIPE,deliveryReframePlan,validateDeliveryReframePlan} from "../../planner/src/delivery-reframe";
import {renderDeliveryReframe} from "../src/delivery-reframe";
import {measurePictureQc} from "../src/picture-qc";

const root=mkdtempSync(join(tmpdir(),"hv-delivery-reframe-"));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const access=async()=>{};
async function master(name:string,size:string,seconds:number):Promise<string>{
  const path=join(root,name);
  const child=Bun.spawn(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i","testsrc2=size="+size+":rate=30:duration="+seconds,
    "-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration="+seconds,"-map","0:v:0","-map","1:a:0",
    "-vf","scale=in_range=full:out_range=limited","-c:v","libx264","-pix_fmt","yuv420p","-r","30","-c:a","aac","-ac","2","-t",String(seconds),"-y",path],
    {cwd:root,stdin:"ignore",stdout:"ignore",stderr:"pipe"});
  const log=await new Response(child.stderr).text();
  expect({name,code:await child.exited,log}).toEqual({name,code:0,log:""});
  return path;
}

test("a cut keeps the master's lines and takes the width the format asks for, to the nearest even pixel",()=>{
  const hd={width:1920,height:1080,durationSec:14};
  const vertical=deliveryReframePlan(hd,"9:16");
  expect(vertical.output).toEqual({width:608,height:1080});
  expect(vertical.crop).toEqual({x:656,y:0,width:608,height:1080});
  expect(vertical.ratioDeviation).toBeLessThan(0.001);
  expect(vertical.filter).toBe("crop=608:1080:656:0,setsar=1");
  expect(deliveryReframePlan(hd,"1:1").output).toEqual({width:1080,height:1080});
  const ready={width:1280,height:720,durationSec:14};
  expect(deliveryReframePlan(ready,"9:16").output).toEqual({width:406,height:720});
  expect(deliveryReframePlan(ready,"1:1").output).toEqual({width:720,height:720});
  // Nothing is scaled, so a cut is never taller than the master it came from.
  for(const format of DELIVERY_FORMATS)for(const source of [hd,ready])
    expect(deliveryReframePlan(source,format).output.height).toBeLessThanOrEqual(source.height);
  // A master already narrower than the format keeps its columns instead of inventing any.
  expect(deliveryReframePlan({width:720,height:1280,durationSec:5},"9:16").output).toEqual({width:720,height:1280});
});

test("the frame can be placed across the master, and always on an even pixel",()=>{
  const hd={width:1920,height:1080,durationSec:14};
  expect(deliveryReframePlan(hd,"9:16",0).crop.x).toBe(0);
  expect(deliveryReframePlan(hd,"9:16",10000).crop.x).toBe(1312);
  expect(deliveryReframePlan(hd,"9:16",2500).crop.x).toBe(328);
  for(const anchor of [0,1,1234,5000,7777,9999,10000]){
    const plan=deliveryReframePlan(hd,"9:16",anchor);
    // 4:2:0 chroma is shared between pairs of pixels, so an odd offset is not a placement, it is a defect.
    expect(plan.crop.x%2).toBe(0);expect(plan.crop.y%2).toBe(0);
    expect(plan.crop.x+plan.crop.width).toBeLessThanOrEqual(hd.width);
  }
  const plan=deliveryReframePlan(hd,"9:16",2500);
  expect(validateDeliveryReframePlan(plan)).toEqual(plan);
  expect(()=>validateDeliveryReframePlan({...plan,output:{width:2,height:2}})).toThrow("does not match the master");
  expect(()=>validateDeliveryReframePlan({...plan,crop:{...plan.crop,x:0}})).toThrow("does not match the master");
});

test("a master that cannot carry the format is refused, and says what it would have been",()=>{
  // An animatic is 640x360: a vertical cut of it would be 202 pixels wide, which is not a deliverable.
  expect(()=>deliveryReframePlan({width:640,height:360,durationSec:5},"9:16")).toThrow("under the 256-pixel minimum");
  expect(()=>deliveryReframePlan({width:640,height:360,durationSec:5},"9:16")).toThrow("202 by 360");
  expect(deliveryReframePlan({width:640,height:360,durationSec:5},"1:1").output).toEqual({width:360,height:360});
  expect(()=>deliveryReframePlan({width:1920,height:1080,durationSec:14},"4:5" as never)).toThrow("Choose a delivery format");
  expect(()=>deliveryReframePlan({width:1920,height:1080,durationSec:0},"1:1")).toThrow("playable duration");
  expect(()=>deliveryReframePlan({width:1920.5,height:1080,durationSec:14},"1:1")).toThrow("whole number of pixels");
  expect(()=>deliveryReframePlan({width:1920,height:1080,durationSec:14},"1:1",10001)).toThrow("0 to 10000");
  expect(()=>deliveryReframePlan({width:1920,height:1080,durationSec:14},"1:1",1.5)).toThrow("0 to 10000");
});

test("a real master is cut to 9:16 and 1:1, keeping its length and its own soundtrack",async()=>{
  const path=await master("master.mp4","1280x720",3);
  const before=await measurePictureQc(path,root,access);
  for(const format of DELIVERY_FORMATS){
    const plan=deliveryReframePlan({width:1280,height:720,durationSec:before.programme.durationSec},format);
    const destination=join(root,"cut-"+format.replace(":","x")+".mp4");
    const result=await renderDeliveryReframe(path,plan,destination,root,access);
    expect(result.schema).toBe("hv-delivery-reframe-result/1");
    expect(result.delivered.width).toBe(plan.output.width);
    expect(result.delivered.height).toBe(plan.output.height);
    expect(result.file.sha256).toMatch(/^[a-f0-9]{64}$/);
    // The check built for delivered films is the one that reads this cut too.
    const after=await measurePictureQc(destination,root,access);
    expect(after.programme.width).toBe(plan.output.width);
    expect(after.programme.height).toBe(plan.output.height);
    expect(after.programme.pixelFormat).toBe("yuv420p");
    expect(after.programme.frameRate).toBe("30/1");
    expect(Math.abs(after.programme.durationSec-before.programme.durationSec)).toBeLessThan(0.2);
    // The sound is the master's own, copied: same codec, rate, channels and level.
    expect(after.programme.audio).toBe(before.programme.audio);
    expect(after.programme.sampleRate).toBe(before.programme.sampleRate);
    expect(after.programme.channels).toBe(before.programme.channels);
    expect(after.sound).not.toBeNull();expect(before.sound).not.toBeNull();
    expect(Math.abs(after.sound!.meanVolumeDb!-before.sound!.meanVolumeDb!)).toBeLessThan(0.1);
    expect(after.picture.blackSpans).toEqual([]);
    expect(after.findings.map(finding=>finding.code)).not.toContain("black-picture");
  }
},120_000);

test("a plan made for another master is refused before anything is encoded",async()=>{
  const path=await master("small.mp4","640x360",1);
  const plan=deliveryReframePlan({width:1280,height:720,durationSec:1},"1:1");
  await expect(renderDeliveryReframe(path,plan,join(root,"mismatch.mp4"),root,access)).rejects.toThrow("made for a 1280 by 720 master");
  expect(DELIVERY_REFRAME_RECIPE.scale).toContain("never upscaled");
},60_000);
