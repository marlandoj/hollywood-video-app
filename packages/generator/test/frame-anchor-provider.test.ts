import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {FalVideoProvider,falVideoCapability} from "../src/fal";
import {FailoverGenerator,sunkCostsOf,type CostRecord} from "../src/index";
import {matchCapability,videoRequirements} from "../src/capabilities";
import {referenceFal} from "../../../test/fixtures/reference-fal";
const root=mkdtempSync(join(tmpdir(),"hv-anchor-provider-"));afterAll(()=>rmSync(root,{recursive:true,force:true}));
const run=(args:string[])=>{const p=Bun.spawnSync(args);if(p.exitCode)throw new Error(p.stderr.toString());return p.stdout;};
const images=["red","blue"].map(color=>{const path=join(root,color+".png");run(["ffmpeg","-y","-v","error","-f","lavfi","-i","color="+color+":s=320x180","-frames:v","1",path]);return "data:image/png;base64,"+readFileSync(path).toString("base64");});
const frameAnchors={frames:[{at:0,image:images[0]!},{at:10000,image:images[1]!}],mode:"native" as const};
const params={seed:7,durationSec:121/30,fps:30,widthxheight:"640x360",frameAnchors};
test("native anchor capability refuses unanchored, intermediate and unsupported provider requests",async()=>{
  const capability=falVideoCapability("kling-o3-standard-keyframes");
  expect(matchCapability(capability,videoRequirements(params),1)).toMatchObject({eligible:true,billedDurationSec:5,estimateUsd:.42,adaptations:expect.arrayContaining(["retime-preserving-generated-endpoints"])});
  expect(matchCapability(capability,videoRequirements({}),1).reasons).toContain("frame-anchors");
  expect(matchCapability(falVideoCapability("kling-o3-standard-reference"),videoRequirements({...params,referenceFrames:images}),1).reasons).toContain("frame-anchors");
  expect(matchCapability(capability,videoRequirements({...params,frameAnchors:{...frameAnchors,frames:[{at:0},{at:5000}]}}),1).reasons).toContain("frame-anchors");
  let requests=0;const fetchImpl=(async()=>{requests++;throw new Error("No request expected.");}) as unknown as typeof fetch,provider=new FalVideoProvider({model:"kling-o3-standard-keyframes",apiKey:"closed-fixture",fetchImpl});
  for(const value of [undefined,{frames:[{at:10000,image:images[1]!}],mode:"native"},{frames:[{at:0,image:"https://example.test/private.png"}],mode:"native"}])
    await expect(provider.generate("A garden",7,{...params,frameAnchors:value as typeof frameAnchors},join(root,"refused.mp4"))).rejects.toMatchObject({name:"FrameAnchorError"});
  await expect(new FalVideoProvider({model:"kling-o3-standard-reference",apiKey:"closed-fixture",fetchImpl}).generate("A garden",7,{...params,referenceFrames:images},join(root,"old.mp4"))).rejects.toMatchObject({name:"FrameAnchorError"});
  expect(requests).toBe(0);
});
test("first and last PNG bytes reach native inputs and generated endpoints survive billed-duration normalization",async()=>{
  const raw=join(root,"raw.mp4");run(["ffmpeg","-y","-v","error","-f","lavfi","-i","color=green:s=320x180:r=30:d=5,drawbox=color=red:t=fill:enable='eq(n,0)',drawbox=color=blue:t=fill:enable='eq(n,149)'","-c:v","libx264","-pix_fmt","yuv420p",raw]);
  const http=referenceFal(Buffer.from(images[0]!.slice(22),"base64"),readFileSync(raw)),provider=new FalVideoProvider({model:"kling-o3-standard-keyframes",apiKey:"closed-fixture",pollMs:0,fetchImpl:http.fetchImpl});
  const clip=await provider.generate("A garden",7,{...params,referenceFrames:[images[0]!]},join(root,"framed.mp4"));expect(http.submissions).toHaveLength(1);
  expect(http.submissions[0]!.body).toMatchObject({start_image_url:images[0],end_image_url:images[1],image_urls:[images[0]],duration:"5",generate_audio:false});
  expect(clip.cost.total_cost_usd).toBe(.42);expect(clip.frameAnchorControl).toEqual({mode:"native",positions:[0,10000],timing:{sourceFrames:150,outputFrames:121}});
  const pixels=run(["ffmpeg","-v","error","-i",clip.path,"-vf","select='eq(n,0)+eq(n,120)',scale=1:1","-fps_mode","passthrough","-pix_fmt","rgb24","-f","rawvideo","-"]);
  expect(pixels.length).toBe(6);expect(pixels[0]!).toBeGreaterThan(245);expect(pixels[5]!).toBeGreaterThan(245);
},10000);
test("a completed but unusable anchored render retains its bill exactly once and stops paid failover",async()=>{
  const http=referenceFal(Buffer.from(images[0]!.slice(22),"base64"),Buffer.from("corrupted video")),provider=new FalVideoProvider({model:"kling-o3-standard-keyframes",apiKey:"closed-fixture",pollMs:0,fetchImpl:http.fetchImpl});
  const costs:CostRecord[]=[];let failure:unknown;
  try{await new FailoverGenerator(provider,provider).generate("A garden",7,{...params,onAttemptCost:cost=>{costs.push(cost);}},join(root,"broken.mp4"));}catch(error){failure=error;}
  expect(failure).toMatchObject({name:"FrameAnchorError"});expect(http.submissions).toHaveLength(1);expect(costs.map(c=>c.total_cost_usd)).toEqual([.42]);expect(sunkCostsOf(failure)).toEqual(costs);
});
