import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DeterministicMockProvider,DeterministicMockImageProvider,FalVideoProvider} from "../src/index";
import {parseFountain} from "../../parser/src/index";
import {planShots} from "../../planner/src/index";
import {castingSnapshot,characterRecord,directCast} from "../../planner/src/casting";
import {createScenePerformance} from "../../planner/src/performance-memory";
import {pictureBaseRevision,picturePerformancePrompt} from "../../planner/src/picture-performance";
import {directionEntry,directionSnapshot,directShots} from "../../planner/src/direction";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {PICTURE_SCRIPT} from "../../../test/fixtures/picture-studio";
import {referenceFal,REFERENCE_VIDEO_MODEL} from "../../../test/fixtures/reference-fal";
test("Kling receives effective character emotion, intensity and ordered gestures through its documented text prompt",async()=>{
  const root=mkdtempSync(join(tmpdir(),"hv-picture-wire-"));let wire:ReturnType<typeof Bun.serve>|undefined;
  try{
    const params={seed:7,widthxheight:"640x360",fps:30,durationSec:1},mp4=join(root,"source.mp4"),png=join(root,"reference.png");await new DeterministicMockProvider().generate("A fictional potato waits at a gate.",7,params,mp4);await new DeterministicMockImageProvider().generateFrame("A fictional potato at a gate.",7,params,png);
    const fixture=referenceFal(readFileSync(png),readFileSync(mp4)),realFetch=fetch,requests:{url:string;auth:boolean}[]=[];
    wire=Bun.serve({port:0,hostname:"127.0.0.1",async fetch(req){const target=req.headers.get("x-fixture-target")!;requests.push({url:target,auth:req.headers.has("authorization")});return fixture.fetchImpl(target,{method:req.method,headers:req.headers,...(req.method==="POST"?{body:await req.text()}:{})});}});
    const transport=(async(input:RequestInfo|URL,init:RequestInit={})=>{const target=String(input),url=new URL(target);if(!["https://queue.fal.run","https://v3.fal.media"].includes(url.origin))throw new Error("Unexpected fixture target");const headers=new Headers(init.headers);headers.set("x-fixture-target",target);return realFetch(wire!.url,{...init,headers});}) as typeof fetch;
    const parsed=parseFountain(PICTURE_SCRIPT),scene=parsed.scenes[0]!,raw=planShots(parsed),id=crypto.randomUUID(),character={...characterRecord(CAST_INPUT,id),scenePerformances:[createScenePerformance(id,scene,{picture:{emotion:"sad",intensity:"restrained",gestures:["hold-still"]}})]},cast=castingSnapshot("wire",1,[character]);
    const direction=directionSnapshot("wire",1,[directionEntry(raw[0]!,{picture:[{characterId:id,baseRevision:pictureBaseRevision(character,scene),controls:{emotion:"joyful",intensity:"heightened",gestures:["open-palms","nod"]}}]})]),shot=directShots(directCast(raw,parsed,cast,Date.now(),direction),direction)[0]!;
    const provider=new FalVideoProvider({model:"kling-o3-standard-reference",apiKey:"fixture-not-a-real-key",fetchImpl:transport,pollMs:1}),reference="data:image/png;base64,"+readFileSync(png).toString("base64");
    const output=await provider.generate(shot.prompt,7,{...params,referenceFrames:[reference]},join(root,"result.mp4"));expect(output.provider).toBe("fal");expect(output.durationSec).toBe(1);expect(fixture.submissions).toHaveLength(1);
    const submission=fixture.submissions[0]!;expect(submission.model).toBe(REFERENCE_VIDEO_MODEL);expect(submission.body.prompt).toBe(shot.prompt+"\n@Image1 is reference image 1.");expect(submission.body.prompt).toContain(picturePerformancePrompt(shot.picturePerformance!));expect(submission.body.prompt).not.toContain("emotion sad");expect(submission.body).not.toHaveProperty("emotion");expect(submission.body).not.toHaveProperty("intensity");expect(submission.body).not.toHaveProperty("gestures");expect(submission.body.image_urls).toEqual([reference]);expect(submission.body.generate_audio).toBe(false);expect(requests.find(r=>r.url.includes("/files/"))!.auth).toBe(false);
  }finally{await wire?.stop(true);rmSync(root,{recursive:true,force:true});}
},20000);
