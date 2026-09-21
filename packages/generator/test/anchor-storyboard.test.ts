import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {AnchorStoryboardProvider} from "../src/anchor-storyboard";
import {FailoverGenerator} from "../src/index";
import {createProviderPlan,withAnchorStoryboard,instantiateProviderPlan} from "../src/catalog";
import {matchCapability,videoRequirements} from "../src/capabilities";
const root=mkdtempSync(join(tmpdir(),"hv-anchor-storyboard-"));afterAll(()=>rmSync(root,{recursive:true,force:true}));
const run=(args:string[])=>{const p=Bun.spawnSync(args);if(p.exitCode)throw new Error(p.stderr.toString());return p.stdout;};
function png(color:string){return "data:image/png;base64,"+run(["ffmpeg","-v","error","-f","lavfi","-i",`color=${color}:s=320x180`,"-frames:v","1","-f","image2pipe","-vcodec","png","-"]).toString("base64");}
test("provided first, middle and last images survive fixed timing and deterministic local presentation",async()=>{
  const provider=new AnchorStoryboardProvider(),frames=["red","lime","blue"].map((color,i)=>({at:i*5000,image:png(color)}));
  const params={seed:1,widthxheight:"320x180",fps:30,durationSec:61/30,frameAnchors:{frames,mode:"storyboard" as const}};
  const clip=await provider.generate("A colorful garden.",1,params,join(root,"colors.mp4"));
  expect(clip.cost.total_cost_usd).toBe(0);expect(clip.frameAnchorControl).toEqual({mode:"storyboard",positions:[0,5000,10000]});
  const probe=JSON.parse(run(["ffprobe","-v","error","-show_streams","-of","json",clip.path]).toString());
  expect(probe.streams.find((s:{codec_type:string})=>s.codec_type==="video").nb_frames).toBe("61");expect(probe.streams.some((s:{codec_name:string})=>s.codec_name==="aac")).toBe(true);
  const pixels=run(["ffmpeg","-v","error","-i",clip.path,"-vf","select='eq(n,0)+eq(n,30)+eq(n,60)',scale=1:1","-fps_mode","passthrough","-pix_fmt","rgb24","-f","rawvideo","-"]);
  expect(pixels.length).toBe(9);for(let i=0;i<9;i++)if(i===0||i===4||i===8)expect(pixels[i]!).toBeGreaterThan(245);else expect(pixels[i]!).toBeLessThan(10);
  const repeat=await provider.generate("A colorful garden.",1,params,join(root,"repeat.mp4"));expect(readFileSync(repeat.path)).toEqual(readFileSync(clip.path));
  expect(()=>videoRequirements({...params,frameAnchors:{...params.frameAnchors,frames:[{at:0},{at:1}]}})).toThrow("collide");
  await expect(provider.generate("A garden.",1,{...params,frameAnchors:{frames,mode:"native"}},join(root,"refused.mp4"))).rejects.toMatchObject({name:"FrameAnchorError"});
},30000);
test("anchor plans retain ordinary jobs and explicitly disclose that cast images are not reapplied",()=>{
  const env={HV_ANIMATIC_PROVIDER_POOL:'["legacy-mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"},plain=createProviderPlan("animatic",1,undefined,env);
  expect(withAnchorStoryboard(plain,false,env)).toBe(plain);
  const anchored=withAnchorStoryboard(plain,true,env);expect(anchored.pool.map(e=>e.spec)).toEqual(["legacy-mock","anchor-storyboard"]);expect(instantiateProviderPlan(anchored,env)).toHaveLength(2);
  const cap=anchored.pool[1]!.snapshot;expect(cap.input.referenceFrames).toBe(0);
  const match=matchCapability(cap,videoRequirements({widthxheight:"640x360",referenceFrames:["cast"],frameAnchors:{frames:[{at:0}],mode:"storyboard"}}),0);
  expect(match.eligible).toBe(true);expect(match.adaptations).toContain("provided images are unchanged; cast references are not reapplied");
  expect(matchCapability(cap,videoRequirements({}),0).eligible).toBe(false);
});
test("crop is applied once before captions and retains the raw first image",async()=>{
  const provider=new AnchorStoryboardProvider({captions:true}),source="data:image/png;base64,"+run(["ffmpeg","-v","error","-f","lavfi","-i","color=red:s=640x360,drawbox=x=320:y=0:w=320:h=360:color=blue:t=fill","-frames:v","1","-f","image2pipe","-vcodec","png","-"]).toString("base64");
  const clip=await new FailoverGenerator(provider,provider).generate("A garden.",1,{seed:1,widthxheight:"640x360",durationSec:1,framing:{x:5000,y:2500,size:5000},dialogue:[{character:"SPUD",lines:["Hello."]}],frameAnchors:{mode:"storyboard",frames:[{at:0,image:source}]}},join(root,"crop.mp4"));
  expect(readFileSync(clip.sourcePosterPath!)).toEqual(Buffer.from(source.slice(22),"base64"));expect(clip.framing).toEqual({x:5000,y:2500,size:5000});
  const pixel=run(["ffmpeg","-v","error","-i",clip.path,"-vf","crop=iw:ih/2:0:0,scale=1:1","-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","-"]);expect(pixel[2]!).toBeGreaterThan(245);expect(pixel[0]!).toBeLessThan(10);
},10000);
const speechTest=Bun.which("espeak-ng")?test:test.skip;
speechTest("anchor narration expands automatic timing, preserves audible audio and refuses speech beyond a fixed duration",async()=>{
  const provider=new AnchorStoryboardProvider({narration:true,captions:true}),frames=[{at:0,image:png("red")},{at:10000,image:png("blue")}];
  const params={seed:1,widthxheight:"320x180",fps:30,durationSec:1,dialogue:[{character:"SPUD",lines:["Welcome to the garden. We have plenty of stories to share today."]}],frameAnchors:{frames,mode:"storyboard" as const}};
  // HV-030-05: the refusal reports what it measured, so the creator is given the number to set.
  await expect(provider.generate("A garden.",1,{...params,exactDuration:true},join(root,"too-short.mp4"))).rejects
    .toMatchObject({name:"ShotDurationError",message:expect.stringMatching(/^Temporary dialogue needs \d+\.\d s and this shot is set to 1\.0 s\. Set the duration to at least \d+\.\d s,/)});
  const clip=await provider.generate("A garden.",1,params,join(root,"speech.mp4"));expect(clip.durationSec).toBeGreaterThan(1);expect(clip.audioMode).toBe("provided");
  const pcm=run(["ffmpeg","-v","error","-i",clip.path,"-map","0:a:0","-f","s16le","-"]);expect(pcm.some(value=>value!==0)).toBe(true);
  expect(clip.cost.output_frames).toBe(Math.round(clip.durationSec*30));
},15000);
