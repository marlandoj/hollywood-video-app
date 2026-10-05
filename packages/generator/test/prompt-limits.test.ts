/**
 * HV-019-19 — each provider's prompt limit is declared in the catalogue, and an adapter refuses a prompt
 * over it before any request (Release 3's live run, G23: fal accepted a Kling final's submit and refused it
 * at result time, `422 string_too_long ... "String should have at most 2500 characters"`).
 */
import {describe,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describeProvider,promptCharLimit} from "../src/catalog";
import {FAL_KLING_MAX_PROMPT_CHARS,FAL_MODELS,FalVideoProvider,falPromptLimit,falReferenceNote} from "../src/fal";
import {FAL_IMAGE_MODELS} from "../src/fal-image";
import {DeterministicMockProvider,mockVideoPromptLimit} from "../src/index";
import {PromptLengthError,promptSize} from "../src/prompt-limits";

/** The header bytes `privatePngReferences` reads: a PNG signature and a 64x64 IHDR. */
const png="data:image/png;base64,"+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13]),Buffer.from("IHDR"),
  Buffer.from([0,0,0,64,0,0,0,64,8,6,0,0,0,0,0,0,0])]).toString("base64");
/** A fal queue that answers nothing and counts every request it is sent. */
function countingFal(){
  const requests:string[]=[];
  const fetchImpl=(async(input:RequestInfo|URL)=>{requests.push(String(input instanceof Request?input.url:input));return new Response("refused by the test",{status:500});}) as unknown as typeof fetch;
  return {requests,fetchImpl};
}
const words=(length:number)=>"word ".repeat(Math.ceil(length/5)).slice(0,length);

describe("the declared limits",()=>{
  /** fal's three Kling video entries take 2,500 characters, the 422's limit. FLUX Schnell and FLUX.2 edit have none on record here, so none is invented. */
  test("every fal Kling video model declares 2,500 characters, and the stills declare none",()=>{
    expect(FAL_KLING_MAX_PROMPT_CHARS).toBe(2500);
    for(const key of ["kling-v2.5-turbo-pro","kling-o3-standard-keyframes","kling-o3-standard-reference"])expect(FAL_MODELS[key]!.maxPromptChars).toBe(2500);
    expect(FAL_MODELS["veo3-fast"]!.maxPromptChars).toBeUndefined();
    for(const spec of Object.values(FAL_IMAGE_MODELS))expect(Object.keys(spec)).not.toContain("maxPromptChars");
    // Per shot: the vendor's limit less the reference note the adapter appends for its images.
    expect(falPromptLimit("kling-v2.5-turbo-pro",0)).toBe(2500);
    expect([0,1,4].map(count=>falPromptLimit("kling-o3-standard-reference",count))).toEqual([2500,2500-promptSize(falReferenceNote(1)),2315]);
    // HV-019-21: the note is counted as fal may: its line break escaped (2) and each @ImageN token 16 more.
    expect(promptSize(falReferenceNote(4))).toBe(185);
    expect(falReferenceNote(2)).toBe("\n@Image1 is reference image 1. @Image2 is reference image 2.");
    expect(promptCharLimit("final","fal:kling-o3-standard-reference",4)).toBe(2315);
    expect(promptCharLimit("final","fal:kling-v2.5-turbo-pro",0)).toBe(2500);
    expect(promptCharLimit("animatic","image:fal:flux-2-edit",4)).toBeNull();
    expect(promptCharLimit("animatic","image:fal:flux-schnell",0)).toBeNull();
    expect(promptCharLimit("final","anchor-storyboard",0)).toBeNull();
    // The mock video adapter stands in for the live video models: the strictest of them, its note counted.
    expect([0,4,8].map(count=>promptCharLimit("final","mock",count))).toEqual([2500,2315,2500-promptSize(falReferenceNote(8))]);
    expect(promptCharLimit("animatic","mock",0)).toBeNull();
  });

  /**
   * The limit lives in the catalogue, not the capability snapshot, so no admitted capability revision moves:
   * a provider plan made before this change has the same revision after it, and so does every shot's input
   * hash whose prompt was already within the limit (these are main's revisions at 8132909).
   */
  test("no capability revision moves",()=>{
    const revisions=Object.fromEntries([["final","fal:kling-o3-standard-reference"],["final","fal:kling-v2.5-turbo-pro"],["final","fal:kling-o3-standard-keyframes"],
      ["final","mock"],["animatic","image:fal:flux-2-edit"],["animatic","image:fal:flux-schnell"],["animatic","mock"]].map(([stage,spec])=>[stage+" "+spec,describeProvider(spec!,stage as "final"|"animatic",{}).snapshot.revision]));
    expect(revisions).toEqual(REVISIONS_AT_MAIN);
  });
});

describe("an adapter refuses an over-limit prompt locally",()=>{
  /** Zero requests: the refusal is the adapter's, before the submit, so nothing is queued or billed. */
  test("the fal adapter sends nothing for a prompt over the model's limit, its reference note counted",async()=>{
    const out=mkdtempSync(join(tmpdir(),"hv-prompt-limits-"));
    try{
      for(const [model,references,length] of [["kling-v2.5-turbo-pro",0,2501],["kling-o3-standard-reference",4,2316],["kling-o3-standard-reference",1,2454]] as const){
        const fal=countingFal(),provider=new FalVideoProvider({apiKey:"prompt-limit-fixture",model,fetchImpl:fal.fetchImpl,pollMs:1});
        const attempt=provider.generate(words(length),7,{seed:7,durationSec:5,widthxheight:"1280x720",referenceFrames:Array.from({length:references},()=>png)},join(out,"clip.mp4"));
        await expect(attempt).rejects.toBeInstanceOf(PromptLengthError);
        await expect(attempt).rejects.toThrow("Nothing was sent.");
        expect(fal.requests).toEqual([]);
      }
      // At the limit exactly, the request goes out (and the fixture's queue refuses it).
      for(const [model,references,length] of [["kling-v2.5-turbo-pro",0,2500],["kling-o3-standard-reference",4,2315]] as const){
        const fal=countingFal(),provider=new FalVideoProvider({apiKey:"prompt-limit-fixture",model,fetchImpl:fal.fetchImpl,pollMs:1});
        await expect(provider.generate(words(length),7,{seed:7,durationSec:5,widthxheight:"1280x720",referenceFrames:Array.from({length:references},()=>png)},join(out,"clip.mp4"))).rejects.toThrow("(500)");
        expect(fal.requests.length).toBe(1);
      }
    }finally{rmSync(out,{recursive:true,force:true});}
  });

  /** The mock holds a prompt to what the live models take, so a $0 rehearsal fails where a paid run would, and earlier. */
  test("the mock video adapter refuses what the live video models refuse",async()=>{
    const out=mkdtempSync(join(tmpdir(),"hv-prompt-limits-mock-"));
    try{
      const mock=new DeterministicMockProvider();
      expect(mockVideoPromptLimit(0)).toBe(2500);
      await expect(mock.generate(words(2501),7,{seed:7,durationSec:.2,widthxheight:"320x180"},join(out,"a.mp4"))).rejects.toBeInstanceOf(PromptLengthError);
      await expect(mock.generate(words(2316),7,{seed:7,durationSec:.2,widthxheight:"320x180",referenceFrames:Array.from({length:4},()=>png)},join(out,"b.mp4"))).rejects.toBeInstanceOf(PromptLengthError);
      expect((await mock.generate(words(2500),7,{seed:7,durationSec:.2,widthxheight:"320x180"},join(out,"c.mp4"))).provider).toBe("mock");
      // HV-019-21: counted as fal may: 2,492 characters with two curly quotes (6 each escaped) are 2,502.
      const quoted="“"+words(2490)+"”";
      expect([quoted.length,Buffer.byteLength(quoted),promptSize(quoted)]).toEqual([2492,2496,2502]);
      await expect(mock.generate(quoted,7,{seed:7,durationSec:.2,widthxheight:"320x180"},join(out,"d.mp4"))).rejects.toBeInstanceOf(PromptLengthError);
    }finally{rmSync(out,{recursive:true,force:true});}
  });
});

/** `describeProvider(spec, stage, {}).snapshot.revision` computed on main at 8132909, before this change. */
const REVISIONS_AT_MAIN:Record<string,string>={
  "final fal:kling-o3-standard-reference":"a3e29d7f6b113487b3da6c8b0316ef28b3ed95bc956815c8751c2e0b694730e4",
  "final fal:kling-v2.5-turbo-pro":"5b1ca8899db0c642d6fe5becb664bc2ad9f55427798b0bc0670fd198081cc6c3",
  "final fal:kling-o3-standard-keyframes":"05a7045b25c9feb8b7d778c08c60137c9a07e061fdeef10d8da8af1ea218ffec",
  "final mock":"90431e57908928c5e34d2d775059ab37e72e05da7a761a7ecdf629b83b1f60e3",
  "animatic image:fal:flux-2-edit":"0437984114676374a2b912b54057b5a9a9fa803e2ffd223034299ba89772bb58",
  "animatic image:fal:flux-schnell":"23e079efb756bad06eff305104c797995b75ce786193b8709bae7ba8de2dea4c",
  "animatic mock":"2efe2a6bcb34f3acbb4452af1598352c3c80b8db0db43b030a30a415b03c3f13",
};
