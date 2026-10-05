/**
 * HV-019-20 — the resumed live final's shot 9 is sent within fal's limit, counted the way fal counts it.
 *
 * Release 3's live run was resumed after HV-019-19 (G23). Sequence 1's final (job 9760e8b8) reused shots
 * 1-8 at $0 and failed again on shot 9 (`shot-2-1`, scene 2):
 * `fal ... failed (422): "prompt: size must be between 0 and 2500"`. HV-019-19 had fitted that prompt to
 * 2,495 characters with O3's image note, and its guard passed it. It was 2,503 UTF-8 bytes: the live crew's
 * cast direction quotes the script in curly quotes (“ ”), three bytes each.
 *
 * The fixture is that job's own body from staging (no secrets): the live crew's casting, direction and style
 * bible, the screenplay, the sequence, the admitted provider plan with the live pool and its shot reuse. The
 * shots are planned by the reuse path the worker checks itself against (`renderShots`, `validateReusePlan`),
 * compiled into the worker's recipe, and handed to the real fal adapter with a transport that records the
 * request body.
 */
import {describe,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {FalVideoProvider,FAL_KLING_MAX_PROMPT_CHARS,falReferenceNote} from "../../generator/src/fal";
import {PromptLengthError,promptSize} from "../../generator/src/prompt-limits";
import {parseFountain} from "../../parser/src/index";
import {directCast,validateCasting} from "../../planner/src/casting";
import {directShots,validateDirection} from "../../planner/src/direction";
import {inSequence,filmPlan} from "../../planner/src/sequences";
import {bibleShots} from "../../planner/src/style-bible";
import {poolReferenceBudget} from "../../planner/src/reference-budget";
import {renderInputHash,renderShots,validateReusePlan} from "../../planner/src/shot-reuse";
import {compileShotRenderRecipe,resolveShotRenderAttempt} from "../../planner/src/shot-render-recipe";
import {TIERS,type Job} from "../src/index";

const job=JSON.parse(readFileSync(join(import.meta.dir,"fixtures/g23-resumed-final-job.json"),"utf8")) as Job;
const now=Date.parse(job.startedAt!);
const parsed=parseFountain(job.scriptText);
/** The header bytes the fal adapter checks a reference image for: a PNG signature and a 64x64 IHDR. */
const png="data:image/png;base64,"+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13]),Buffer.from("IHDR"),
  Buffer.from([0,0,0,64,0,0,0,64,8,6,0,0,0,0,0,0,0])]).toString("base64");
/** The real fal adapter for a model, with a transport that records each submitted body and answers 500. */
function recordingFal(model:string){
  const bodies:Record<string,unknown>[]=[];
  const fetchImpl=(async(_input:RequestInfo|URL,init:RequestInit={})=>{bodies.push(JSON.parse(String(init.body)));return new Response("recorded by the test",{status:500});}) as unknown as typeof fetch;
  return {bodies,provider:new FalVideoProvider({apiKey:"g23-resumed-final-fixture",model,fetchImpl,pollMs:1})};
}
/** What the worker sends for a shot: its recipe's attempt-0 dispatch, through the model the router gives its images. */
async function sent(shot:ReturnType<typeof renderShots>[number],out:string){
  const recipe=compileShotRenderRecipe({projectId:job.projectId,stage:"final",shot,sceneHeading:parsed.scenes[shot.sceneIndex]!.heading,outputSize:TIERS[job.tier].maxResolution,
    providerPlan:job.providerPlan!,richAnimaticProviders:job.providerPlan!.pool.map(()=>false)});
  const attempt=resolveShotRenderAttempt(recipe,0),fal=recordingFal(recipe.references.length?"kling-o3-standard-reference":"kling-v2.5-turbo-pro");
  await expect(fal.provider.generate(attempt.prompt,attempt.seed,{...attempt.params,seed:attempt.seed,referenceFrames:recipe.references.map(()=>png)},join(out,"clip.mp4"))).rejects.toThrow("(500)");
  expect(fal.bodies.length).toBe(1);
  return {dispatched:attempt.prompt,body:String(fal.bodies[0]!.prompt),references:recipe.references.length};
}

describe("the resumed G23 final (job 9760e8b8)",()=>{
  /** The job as staging stored it: the live pool, eight reused shots, and fal's 422 on shot 9. */
  test("is the job that failed: the live pool, shots 1-8 reused, fal's byte-size 422 on shot 9",()=>{
    expect(job.providerPlan!.pool.map(entry=>entry.spec)).toEqual(["fal:kling-o3-standard-reference","fal:kling-v2.5-turbo-pro"]);
    expect(job.shotReuse!.shots.map(record=>record.shotId)).toEqual(["1","2","3","4","5","6","7","8"].map(n=>"shot-1-"+n));
    expect(job.failureReason).toContain("prompt: size must be between 0 and 2500");
    expect(job.failureReason).toContain('"input":{"prompt":"INT. CLOCK TOWER WORKSHOP - DAWN - CONTINUOUS. A round room full of gears');
  });

  /** Shots 1-8 are already rendered and reused: their recorded input hashes still match, so the worker's own reuse check passes. */
  test("shots 1-8 are planned byte for byte as they were rendered: every recorded input hash still matches",()=>{
    const shots=renderShots(job,now);
    for(const record of job.shotReuse!.shots)expect(renderInputHash(job,shots.find(shot=>shot.id===record.shotId)!)).toBe(record.inputHash);
    expect(()=>validateReusePlan(job.shotReuse!,job,now)).not.toThrow();
    expect(shots.slice(0,8).some(shot=>"promptFit" in shot)).toBe(false);
  });

  /**
   * Shot 9 as the worker builds and the adapter sends it. The string fal receives is the dispatched prompt and
   * O3's image note, nothing else; it is within 2,500 by UTF-8 bytes (so by characters too), and its fit record
   * says so. The same holds for every shot of the sequence.
   */
  test("shot 9's prompt, exactly as fal receives it, is within 2,500 UTF-8 bytes, and so is every shot's",async()=>{
    const out=mkdtempSync(join(tmpdir(),"hv-g23-resumed-"));
    try{
      const shots=renderShots(job,now),nine=shots[8]!;
      expect([nine.id,parsed.scenes[nine.sceneIndex]!.heading]).toEqual(["shot-2-1","INT. CLOCK TOWER WORKSHOP - DAWN - CONTINUOUS"]);
      const {dispatched,body,references}=await sent(nine,out);
      expect(references).toBe(4);
      expect(body).toBe(dispatched+falReferenceNote(4));
      expect(body.startsWith("INT. CLOCK TOWER WORKSHOP - DAWN - CONTINUOUS. A round room full of gears")).toBe(true);
      // The live crew's text is not ASCII: fal's byte count is larger than the character count.
      expect(promptSize(body)).toBeGreaterThan(body.length);
      expect(promptSize(body)).toBeLessThanOrEqual(FAL_KLING_MAX_PROMPT_CHARS);
      expect(nine.promptFit).toMatchObject({schema:"hv-prompt-fit/2",limit:FAL_KLING_MAX_PROMPT_CHARS-falReferenceNote(4).length,fittedBytes:promptSize(dispatched)});
      for(const shot of shots){const request=await sent(shot,out);expect(promptSize(request.body)).toBeLessThanOrEqual(FAL_KLING_MAX_PROMPT_CHARS);}
    }finally{rmSync(out,{recursive:true,force:true});}
  });

  /**
   * The guard checks the request body's prompt field in UTF-8 bytes. Shot 9 unfitted (the live crew's whole
   * prompt) and a prompt like the one fal refused (2,495 characters, 2,503 bytes) are refused before any request.
   */
  test("the adapter refuses shot 9's unfitted prompt and a 2,495-character, 2,503-byte prompt, with zero requests",async()=>{
    const casting=validateCasting(job.casting!,job.projectId),direction=validateDirection(job.direction!,job.projectId);
    const unfitted=bibleShots(inSequence(directShots(directCast(filmPlan(parsed,direction,TIERS[job.tier].maxShots,job.sequence),parsed,casting,now,direction,poolReferenceBudget(job.providerPlan!.pool)),direction),job.sequence),parsed,job.styleBible)[8]!;
    expect(unfitted.id).toBe("shot-2-1");
    // Like the prompt fal refused: four curly quotes in 2,375 characters, so 2,495 characters and 2,503 bytes with O3's note.
    const curly="“"+"a".repeat(1185)+"” “"+"a".repeat(1185)+"”";
    expect([curly.length+falReferenceNote(4).length,promptSize(curly+falReferenceNote(4))]).toEqual([2495,2503]);
    const cases=[unfitted.prompt,curly];
    const out=mkdtempSync(join(tmpdir(),"hv-g23-guard-"));
    try{
      for(const prompt of cases){
        const fal=recordingFal("kling-o3-standard-reference");
        await expect(fal.provider.generate(prompt,7,{seed:7,durationSec:5,widthxheight:"1280x720",referenceFrames:[png,png,png,png]},join(out,"clip.mp4"))).rejects.toBeInstanceOf(PromptLengthError);
        expect(fal.bodies).toEqual([]);
      }
    }finally{rmSync(out,{recursive:true,force:true});}
  });
});
