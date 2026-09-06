import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {normalizeAnchoredClip} from "../src/frame-anchor-media";
const root=mkdtempSync(join(tmpdir(),"hv-anchor-media-"));afterAll(()=>rmSync(root,{recursive:true,force:true}));
const run=(args:string[])=>{const p=Bun.spawnSync(args);if(p.exitCode)throw new Error(p.stderr.toString());return p.stdout;};
test("endpoint-preserving normalization keeps distinct first and last frames when shortening or extending a clip",async()=>{
  for(const [fps,duration]of [[30,5],[24,3]]){
    const raw=join(root,"source-"+fps+".mp4"),target=join(root,"target-"+fps+".mp4"),last=fps!*duration!-1;
    run(["ffmpeg","-y","-v","error","-f","lavfi","-i",`color=green:s=320x180:r=${fps}:d=${duration},drawbox=color=red:t=fill:enable='eq(n,0)',drawbox=color=blue:t=fill:enable='eq(n,${last})'`,
      "-c:v","libx264","-pix_fmt","yuv420p",raw]);
    const timing=await normalizeAnchoredClip(raw,target,{width:640,height:360,fps:30,durationSec:121/30});expect(timing).toEqual({sourceFrames:last+1,outputFrames:121});
    const probe=JSON.parse(run(["ffprobe","-v","error","-select_streams","v:0","-show_streams","-of","json",target]).toString()).streams[0];expect([probe.width,probe.height,Number(probe.nb_frames)]).toEqual([640,360,121]);
    const pixels=run(["ffmpeg","-v","error","-i",target,"-vf","select='eq(n,0)+eq(n,120)',scale=1:1","-fps_mode","passthrough","-pix_fmt","rgb24","-f","rawvideo","-"]);
    expect(pixels.length).toBe(6);expect(pixels[0]!).toBeGreaterThan(245);expect(pixels[1]!).toBeLessThan(10);expect(pixels[2]!).toBeLessThan(10);
    expect(pixels[5]!).toBeGreaterThan(245);expect(pixels[3]!).toBeLessThan(10);expect(pixels[4]!).toBeLessThan(10);
  }
},15000);
test("missing source, invalid target and cancellation preserve terminal local errors",async()=>{
  await expect(normalizeAnchoredClip(join(root,"missing.mp4"),join(root,"bad.mp4"),{width:320,height:180,fps:30,durationSec:1})).rejects.toMatchObject({name:"FrameAnchorError"});
  await expect(normalizeAnchoredClip("unused","unused",{width:320,height:180,fps:0,durationSec:1})).rejects.toMatchObject({name:"FrameAnchorError"});
  const controller=new AbortController();controller.abort(new Error("stop"));
  await expect(normalizeAnchoredClip("unused","unused",{width:320,height:180,fps:30,durationSec:1},controller.signal)).rejects.toThrow("stop");
});
