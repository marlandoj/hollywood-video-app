/**
 * HV-030-14 — the crew's cast passed its gate alone and was refused beside the scene it was cast for.
 *
 * The stand-in crew checks what it writes beside the script's action, because the render prompt puts
 * them together (`standInCast`: "the cast can never be what turns a scene into a refusal"). The
 * model's plan was checked field by field, alone. In a scene that reads "The crowd is close to
 * violence.", the model's appearance "A councillor who can incite a room with a look." passed
 * `validateCrewPlan` and `crewChanges`, was saved to the cast, and the render prompt that `applyCast`
 * builds from both was refused as violent incitement -- every shot of the scene, after the crew's
 * plan had been paid for. The stand-in's own test rejects the same text. Shot direction had the same
 * gap: a performance note is rendered beside its shot's action and was gated without it.
 *
 * The model's cast and each shot's direction are now gated beside the action as the stand-in's are,
 * so a plan that would be refused at render falls back to the stand-in plan here.
 */
import {expect,test} from "bun:test";
import {CrewLedger} from "../../operator/src/crew-ledger";
import {parseFountain} from "../../parser/src/index";
import {checkPrompt} from "../../safety/src/index";
import {castingSnapshot,characterRecord,describeCharacter} from "../src/casting";
import {crewChanges,runPlan,standInPlan,validateCrewPlan} from "../src/crew/production-plan";
import {readThroughFacts} from "../src/crew/read-through";
import {directionSnapshot} from "../src/direction";
import {sourcePlan} from "../src/scene-cuts";

const SCRIPT="INT. TOWN HALL - NIGHT\n\nThe crowd is close to violence.\n\nMARA\nEveryone, sit down.\n";
const parsed=parseFountain(SCRIPT),shots=sourcePlan(parsed,undefined,7000,24),facts=readThroughFacts(SCRIPT,parsed,{format:"reel",tone:""});
const now=Date.parse("2026-09-28T22:00:00.000Z");
const INCITING="A councillor who can incite a room with a look.";
const plan=(cast:object[],shotChanges:object={})=>JSON.stringify({...standInPlan(parsed,facts,shots),cast,shots:standInPlan(parsed,facts,shots).shots.map(shot=>({...shot,...shotChanges}))});

test("what the defect did, measured: the cast passes alone and its scene's render prompt is refused",()=>{
  expect(checkPrompt(SCRIPT).allowed).toBe(true);
  expect(checkPrompt(INCITING).allowed).toBe(true);
  const record=characterRecord({name:"MARA",aliases:[],kind:"original-fictional",appearance:INCITING,ageRange:"40s",ethnicity:"",body:"",hairMakeup:"",expressions:"",movement:"",relationships:"",arcNotes:"",prohibitedChanges:"",
    wardrobe:[],sceneBindings:[],permission:{status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()}},"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",now,true);
  expect(checkPrompt(shots[0]!.prompt+"\n"+describeCharacter(record,1)).category).toBe("violent_incitement");
});

test("a cast that would be refused beside its scene is refused at the gate",()=>{
  expect(()=>validateCrewPlan(plan([{name:"MARA",appearance:INCITING,ageRange:"40s",wardrobe:""}]),facts,shots)).toThrow("The crew's cast for MARA is not usable beside the script.");
});

test("and so is a shot's direction",()=>{
  expect(()=>validateCrewPlan(plan([],{performance:"She means to incite the room."}),facts,shots)).toThrow("is not usable beside the script.");
});

test("an ordinary plan for the same scene is used, and the paid refusal falls back to the stand-in plan",async()=>{
  const ordinary=validateCrewPlan(plan([{name:"MARA",appearance:"A councillor in her forties with a steady voice.",ageRange:"40s",wardrobe:"A grey suit."}]),facts,shots);
  expect(()=>crewChanges(ordinary,castingSnapshot("p1",0,[],now),directionSnapshot("p1",0,[],now),()=>crypto.randomUUID(),now)).not.toThrow();
  const model={name:"anthropic" as const,model:"claude-test",complete:async()=>({text:plan([{name:"MARA",appearance:INCITING,ageRange:"40s",wardrobe:""}]),model:"claude-test",usage:{inputTokens:10,outputTokens:20},costUsd:0.02})};
  const result=await runPlan({scriptText:SCRIPT,parsed,facts,input:{format:"reel",tone:"",answers:[]},shots,projectId:"p1",model,ledger:new CrewLedger(),now:()=>new Date(now)});
  expect({source:result.source,reason:result.fallbackReason,usd:result.crewSpend.usd}).toEqual({source:"stand-in",reason:"model_unusable",usd:0.02});
});
