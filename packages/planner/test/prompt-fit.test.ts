/**
 * HV-019-19 — a shot's prompt fitted to its provider's prompt limit (Release 3's live run, G23: fal's Kling
 * refused a final's prompt at result time, "String should have at most 2500 characters"). The rule is in
 * packages/planner/src/prompt-fit.ts; the whole feature on the referenced profile is
 * packages/api/test/feature-prompt-limits.test.ts, and the adapters' own refusals are
 * packages/generator/test/prompt-limits.test.ts.
 */
import {describe,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {parseFountain} from "../../parser/src/index";
import {describeProvider} from "../../generator/src/catalog";
import {falReferenceNote} from "../../generator/src/fal";
import {CAST_DIRECTION_HEADER,REFERENCE_MAP_HEADER,castingSnapshot,characterDirectionFields,characterRecord,directCast} from "../src/casting";
import {applyShotDirection,DIRECTION_PROMPT_HEADER} from "../src/direction";
import {referenceLockRecord} from "../src/reference-lock";
import {filmPlan} from "../src/sequences";
import {bibleShots,STYLE_FIELDS,STYLE_PROMPT_HEADER,styleBible} from "../src/style-bible";
import {ACTION_MIN_CHARS,fitShotPrompt,fitShotPrompts,poolPromptLimits,PromptFitError,PROMPT_FIT_SCHEMA} from "../src/prompt-fit";

const now=Date.UTC(2026,9,5);
const image=(seed:string)=>({schema:"hv-reference/1" as const,id:"11111111-2222-4333-8444-"+seed.repeat(12).slice(0,12),projectId:"project-1",
  sha256:seed.repeat(64).slice(0,64),originalSha256:"b".repeat(64),bytes:4096,width:512,height:512,contentType:"image/png" as const,
  createdAt:new Date(now).toISOString(),attestedAt:new Date(now).toISOString()});
const permitted={status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()};
const ADA="aaaaaaaa-1111-4111-8111-111111111111",BEN="aaaaaaaa-1111-4111-8111-222222222222";
/** ADA is locked to four views; BEN is unlocked and has no images. Each has notes long enough to matter. */
const casting=(adaNotes="Keeps her copper goggles pushed up on her forehead.",adaLook="")=>{
  const views=["a1","a2","a3","a4"].map(image);
  const ada=characterRecord({...CAST_INPUT,name:"ADA",aliases:[],permission:permitted,sceneBindings:[],references:views,appearance:"A wiry inventor with ink-stained fingers. "+adaNotes,...(adaLook?{hairMakeup:adaLook.slice(0,400),expressions:adaLook.slice(0,400),movement:adaLook.slice(0,400)}:{}),
    referenceLock:referenceLockRecord({assetIds:views.map(view=>view.id),label:"ADA turnaround",note:""},views,now)},ADA,now,true);
  const ben=characterRecord({...CAST_INPUT,name:"BEN",aliases:[],permission:permitted,sceneBindings:[],appearance:"A tall ferryman in a salt-stained wool coat, with a grey beard trimmed short and a voice like gravel.",
    relationships:"Ada's oldest friend, who rows her across the harbour every morning before the market opens."},BEN,now,true);
  return castingSnapshot("project-1",1,[ada,ben],now);
};
const SCRIPT="INT. WORKSHOP - DAY\n\nAda and Ben lean over a long bench covered in brass gears, springs and half-built clockwork birds while rain streams down the tall windows behind them and a kettle begins to whistle on the stove in the corner. Ada winds a tiny key, a bird twitches its tin wings, and Ben laughs so hard he knocks a jar of screws across the floor.\n\nEXT. YARD - NIGHT\n\nThe gate swings.";
const parsed=parseFountain(SCRIPT);
const bible=styleBible({version:1,scriptVersion:1,source:"stand-in",characters:[],locations:[{name:"WORKSHOP",description:"A cluttered brick workshop with a skylight, shelves of jars and a cast-iron stove."}],
  look:"Warm and tactile, with practical light and slow, observant camera moves that let scenes breathe.",palette:"Copper, brass and deep teal, with warm skin tones and inky shadows.",
  lighting:"Motivated window light by day; lamps and the stove's glow by night.",lens:"Wide to open a place, medium for action, close-ups for dialogue.",tone:"Curious and tender.",
  sound:"A ticking motif under the score; rain and kettles carry scenes."});
/** The chain the worker runs: plan, cast, direct (one shot's direction), the style bible. */
const planned=(cast=casting())=>{
  const shots=directCast(filmPlan(parsed,undefined,24),parsed,cast,now,undefined,4);
  const directed=shots.map(shot=>shot.id==="shot-1-1"?applyShotDirection(shot,{size:"medium",angle:"eye-level",soundIntent:"Rain on glass and the kettle rising",
    transitionIntent:"Cut on the kettle's whistle",keyLight:"Soft window light from screen left",blocking:"Ada leans in; Ben stays at the far end of the bench",seed:shot.seed}):shot);
  return {shots:bibleShots(directed,parsed,{...bible,locations:bible.locations}),cast};
};
const sha=(text:string)=>createHash("sha256").update(text).digest("hex");

describe("a prompt within its limit",()=>{
  /** A shot that already fits is the very same object: no text changes, no record, so its input hash and any render of it stand. */
  test("is returned unchanged, byte for byte, with no record",()=>{
    const {shots,cast}=planned();
    const fitted=fitShotPrompts(shots,Array.from({length:33},()=>5000),{parsed,casting:cast,styleBible:bible});
    expect(fitted.every((shot,index)=>shot===shots[index])).toBe(true);
    expect(fitted.some(shot=>"promptFit" in shot)).toBe(false);
    // No declared limit (a stills pool, a pool of FLUX models): nothing is touched either.
    expect(fitShotPrompts(shots,null,{parsed,casting:cast,styleBible:bible})).toBe(shots);
    expect(fitShotPrompt(shots[0]!,null,{parsed,casting:cast,styleBible:bible})).toBe(shots[0]!);
  });
});

describe("an over-limit prompt",()=>{
  /**
   * Cut only as far as the limit needs, in the documented order: style location, style sound, the shot's
   * sound and transition intent, the rest of the style bible, the rest of the shot direction, then unlocked
   * characters, then the action. The locked character's cast direction and the reference map are never cut.
   */
  test("is cut in the documented order, at word boundaries, and the record says what was cut",()=>{
    const {shots,cast}=planned(),shot=shots[0]!;
    expect(shot.prompt.length).toBeGreaterThan(1500);
    const lookSentences=characterDirectionFields(cast.characters[0]!,1).filter(field=>!["Relationships","Character arc"].includes(field.label)).map(field=>field.text);
    expect(lookSentences.length).toBeGreaterThanOrEqual(5);
    const order:string[]=[];
    let previous=0;
    let refused=false;
    for(let limit=shot.prompt.length-1;limit>=0&&!refused;limit-=25){
      let fitted:typeof shot;
      try{fitted=fitShotPrompt(shot,limit,{parsed,casting:cast,styleBible:bible});}catch(error){expect(error).toBeInstanceOf(PromptFitError);refused=true;continue;}
      const fit=fitted.promptFit!;
      expect(fitted.prompt.length).toBeLessThanOrEqual(limit);
      expect(fit).toMatchObject({schema:PROMPT_FIT_SCHEMA,limit,originalChars:shot.prompt.length,fittedChars:fitted.prompt.length,
        originalSha256:sha(shot.prompt),fittedSha256:sha(fitted.prompt)});
      // The record accounts for every character removed.
      expect(fit.trimmed.reduce((sum,cut)=>sum+cut.fromChars-cut.toChars,0)).toBe(shot.prompt.length-fitted.prompt.length);
      // Never cut: the heading, the cast header, every sentence of the locked character's look, the reference map.
      expect(fitted.prompt.startsWith("INT. WORKSHOP - DAY. ")).toBe(true);
      expect(fitted.prompt).toContain("\n"+CAST_DIRECTION_HEADER+"\nADA. "+lookSentences[0]);
      for(const sentence of lookSentences)expect(fitted.prompt).toContain(" "+sentence);
      expect(fitted.prompt).toContain("\n"+REFERENCE_MAP_HEADER+"\n"+[1,2,3,4].map(n=>"Reference image "+n+" depicts ADA.").join("\n"));
      // A shortened part ends at a whole word and says so; nothing is cut mid-word.
      for(const piece of fitted.prompt.split("…").slice(0,-1))expect(shot.prompt.includes(piece.slice(-30)+" ")||shot.prompt.includes(piece.slice(-30)+"\n")||shot.prompt.includes(piece.slice(-30)+",")).toBe(true);
      // Cuts only ever deepen as the limit tightens: each record extends the previous one's order.
      for(const cut of fit.trimmed){const key=cut.part+":"+cut.label;if(!order.includes(key))order.push(key);}
      expect(fit.trimmed.length).toBeGreaterThanOrEqual(previous);previous=fit.trimmed.length;
    }
    expect(order).toEqual(["style:location","style:Sound","direction:soundIntent","direction:transitionIntent","style:Tone","style:Lens and framing","style:Palette",
      "style:Lighting","style:Look","style:header","direction:keyLight","direction:blocking","direction:angle","direction:size","direction:header","cast-unlocked:BEN","cast-locked:ADA: Relationships","cast-locked:ADA: Character arc","action:action"]);
    // Past the action's floor nothing else may go: the shot is refused rather than cut further.
    expect(refused).toBe(true);
  });

  /** The style and direction blocks lose their headers with their last line; the cast block keeps its header (its instruction) always. */
  test("loses an emptied block's header, never the cast direction's",()=>{
    const {shots,cast}=planned(),shot=shots[0]!;
    const fitted=fitShotPrompt(shot,1000,{parsed,casting:cast,styleBible:bible});
    expect(fitted.prompt).not.toContain(STYLE_PROMPT_HEADER);
    expect(fitted.prompt).not.toContain(DIRECTION_PROMPT_HEADER);
    expect(fitted.prompt).toContain(CAST_DIRECTION_HEADER);
    // BEN keeps at least his name in the cast direction; the action keeps its opening.
    expect(fitted.prompt).toContain("\nBEN.");
    const action=parsed.scenes[0]!.action.join(" ");
    expect(fitted.prompt).toContain(action.slice(0,ACTION_MIN_CHARS-20));
  });

  /** When even the parts never cut don't fit, the shot is refused before anything is sent, and says what to shorten. */
  test("that can't fit without cutting a locked character's direction is refused, naming the character",()=>{
    const cast=casting("Her look runs long. ".repeat(45),"Copper curls pinned with clock hands. ".repeat(11)),{shots}=planned(cast);
    expect(()=>fitShotPrompt(shots[0]!,2380,{parsed,casting:cast,styleBible:bible})).toThrow(PromptFitError);
    expect(()=>fitShotPrompt(shots[0]!,2380,{parsed,casting:cast,styleBible:bible})).toThrow(/Shot shot-1-1's prompt is \d+ characters after every cut the planner may make, and its provider takes at most 2380\. .*locked characters \(ADA\).*Nothing was sent\./);
  });

  /** A prompt the planner can't match to the parts it built (here, text appended by hand) is cut only in its action, never guessed at. */
  test("whose parts can't be matched exactly is never split by guesswork",()=>{
    const {shots,cast}=planned(),shot={...shots[0]!,prompt:shots[0]!.prompt+"\nSomething else."};
    expect(()=>fitShotPrompt(shot,1500,{parsed,casting:cast,styleBible:bible})).toThrow(PromptFitError);
  });
});

describe("the limit a shot is fitted to",()=>{
  const pool=(stage:"animatic"|"final",specs:string[])=>specs.map(spec=>describeProvider(spec,stage,{}));
  /**
   * The smallest declared limit among the providers that take the shot's image count, as the router chooses
   * among them: Kling O3 reference (2,500 less its numbered image note) for 1-4 images, Kling 2.5 for none.
   * The stills declare none; the mock stands in for the live video models and takes what the strictest does.
   */
  test("is the referenced profile's for its images, none for the stills, and the mock's is the live models'",()=>{
    const finals=poolPromptLimits("final",pool("final",["fal:kling-o3-standard-reference","fal:kling-v2.5-turbo-pro"]))!;
    expect(finals[0]).toBe(2500);
    for(const count of [1,2,3,4])expect(finals[count]).toBe(2500-falReferenceNote(count).length);
    expect(finals[4]).toBe(2380);
    expect(poolPromptLimits("animatic",pool("animatic",["image:fal:flux-2-edit","image:fal:flux-schnell"]))).toBeNull();
    expect(poolPromptLimits("animatic",pool("animatic",["mock"]))).toBeNull();
    const mock=poolPromptLimits("final",pool("final",["mock"]))!;
    expect([mock[0],mock[4],mock[8]]).toEqual([2500,2380,2500-falReferenceNote(8).length]);
    expect(poolPromptLimits("final",[])).toBeNull();
    expect(poolPromptLimits("final",undefined)).toBeNull();
    expect(STYLE_FIELDS.length).toBe(6);
  });
});
