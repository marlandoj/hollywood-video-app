import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FalImageProvider, falImageCapability } from "../src/fal-image";
import { FalVideoProvider, falVideoCapability } from "../src/fal";
import { DeterministicMockImageProvider } from "../src/image";
import { matchCapability, videoRequirements } from "../src/capabilities";
import { richAnimaticCapability } from "../src/animatic";
const root=mkdtempSync(join(tmpdir(),"hv-reference-provider-"));let reference:string;
beforeAll(async()=>{reference="data:image/png;base64,"+readFileSync((await new DeterministicMockImageProvider().generateFrame("A fictional potato",1,{},join(root,"reference.png"))).path).toString("base64");});
afterAll(()=>rmSync(root,{recursive:true,force:true}));
test("reference providers refuse missing, excessive, remote and malformed inputs before any request",async()=>{
  let requests=0;const fetchImpl=(async(_input:RequestInfo | URL):Promise<Response>=>{requests++;throw new Error("unexpected inference");}) as typeof fetch;
  const image=new FalImageProvider({model:"flux-2-edit",apiKey:"fixture",fetchImpl});
  const video=new FalVideoProvider({model:"kling-o3-standard-reference",apiKey:"fixture",fetchImpl});
  for(const refs of [[],Array(5).fill(reference),["https://example.test/private.png"],["data:image/png;base64,AAAA"],[reference+"!"], [reference.replace("image/png","image/jpeg")]]) {
    await expect(image.generateFrame("A fictional potato",1,{referenceFrames:refs},join(root,"unused.png"))).rejects.toThrow();
    await expect(video.generate("A fictional potato",1,{seed:1,referenceFrames:refs},join(root,"unused.mp4"))).rejects.toThrow();
  }
  for(const provider of [new FalImageProvider({apiKey:"fixture",fetchImpl}),new FalVideoProvider({apiKey:"fixture",fetchImpl})]) {
    const params={seed:1,referenceFrames:[reference]};
    await expect(provider instanceof FalImageProvider ? provider.generateFrame("A fictional potato",1,params,join(root,"unused.png")) : provider.generate("A fictional potato",1,params,join(root,"unused.mp4"))).rejects.toThrow();
  }
  expect(requests).toBe(0);
});
test("reference routing uses input costs and billed duration, refusing impossible reference counts and budgets",()=>{
  const image=richAnimaticCapability(falImageCapability("flux-2-edit")),video=falVideoCapability("kling-o3-standard-reference");
  const req=videoRequirements({widthxheight:"640x360",durationSec:2,referenceFrames:[reference]});
  expect(matchCapability(image,req,1)).toMatchObject({eligible:true,estimateUsd:.024});
  expect(matchCapability(video,req,1)).toMatchObject({eligible:true,estimateUsd:.252,billedDurationSec:3});
  for(const provider of [image,video]) {
    expect(matchCapability(provider,{...req,referenceFrames:0},1).reasons).toContain("references");
    expect(matchCapability(provider,{...req,referenceFrames:5},1).reasons).toContain("references");
    expect(matchCapability(provider,req,.01).reasons).toContain("price");
    expect(matchCapability(provider,{...req,identityLocks:1},1).reasons).toContain("identity");
  }
  expect(matchCapability(image,{...req,referenceFrames:4,width:1024,height:1024},1).estimateUsd).toBe(.072);
  expect(()=>falImageCapability("flux-2-edit",.003)).toThrow();
});
