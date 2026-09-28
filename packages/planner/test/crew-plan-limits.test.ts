/**
 * HV-030-12 — the crew was paid for a plan the direction then refused.
 *
 * `validateCrewPlan` gated every shot text field at `intent: 300`. `crewChanges` then runs each of
 * those values through `directionSettings`, whose own table allows `keyLight` and `transitionIntent`
 * only 240. So a plan with a 241–300-character light or transition:
 *
 * - passed `validateCrewPlan` and was returned as `source: "anthropic"`;
 * - had already been recorded against the crew's budget by `runPlan`;
 * - threw `keyLight must be text of at most 240 characters.` from `crewChanges`, which the plan route
 *   does not catch -- a 400 at "Plan the film", about a field the creator never saw, paid again on
 *   every retry.
 *
 * docs/CREW.md: "Anything else falls back to the stand-in plan." It did not, because the refusal
 * came after the gate rather than at it. The shot fields are now gated to the direction's own limits,
 * so an over-long field is refused where the stand-in fallback is.
 */
import {expect,test} from "bun:test";
import {CrewLedger} from "../../operator/src/crew-ledger";
import {parseFountain} from "../../parser/src/index";
import {castingSnapshot} from "../src/casting";
import {crewChanges,runPlan,standInPlan,validateCrewPlan} from "../src/crew/production-plan";
import {readThroughFacts} from "../src/crew/read-through";
import {DIRECTION_TEXT_LIMITS,directionSnapshot} from "../src/direction";
import {sourcePlan} from "../src/scene-cuts";

const SCRIPT="INT. KITCHEN - DAY\n\nMaya pours tea.\n\nMAYA\nYou came back.\n\nEXT. GARDEN - NIGHT\n\nLeo waits in the rain.\n\nLEO\nI never left.";
const parsed=parseFountain(SCRIPT),shots=sourcePlan(parsed,undefined,7000,24);
const facts=readThroughFacts(SCRIPT,parsed,{format:"reel",tone:""});
const now=Date.parse("2026-09-19T22:00:00.000Z");
let counter=0;
const newId=()=>`00000000-0000-4000-8000-${String(++counter).padStart(12,"0")}`;
const cast=castingSnapshot("p1",0,[],now),direction=directionSnapshot("p1",0,[],now);
/** A sentence of exactly `length` characters that the safety gate reads as ordinary direction. */
const words=(length:number)=>"soft warm window light across the table ".repeat(20).slice(0,length).padEnd(length,"x");
const FIELDS=["keyLight","performance","soundIntent","transitionIntent","timeOfDay"] as const;

test("every shot field the crew writes is gated at the direction's own limit",()=>{
  for (const field of FIELDS) {
    const limit=DIRECTION_TEXT_LIMITS[field];
    const at=standInPlan(parsed,facts,shots);at.shots[0]={...at.shots[0]!,[field]:words(limit)};
    // At the limit: the model's plan is used, and the changes it makes are ones the direction accepts.
    const plan=validateCrewPlan(JSON.stringify(at),facts,shots);
    expect(()=>crewChanges(plan,cast,direction,newId,now)).not.toThrow();
    // One over: refused here, where the stand-in plan takes over, not later where nothing does.
    const over=standInPlan(parsed,facts,shots);over.shots[0]={...over.shots[0]!,[field]:words(limit+1)};
    expect({field,refused:(()=>{try{validateCrewPlan(JSON.stringify(over),facts,shots);return false;}catch{return true;}})()}).toEqual({field,refused:true});
  }
});

test("and a paid plan with an over-long light falls back to the stand-in plan instead of failing the step",async()=>{
  // The case that used to reach the route as a 400: 287 characters of key light.
  const plan=standInPlan(parsed,facts,shots);plan.shots[0]={...plan.shots[0]!,keyLight:words(287)};
  const ledger=new CrewLedger();
  const model={name:"anthropic" as const,model:"claude-test",complete:async()=>({text:JSON.stringify(plan),model:"claude-test",usage:{inputTokens:10,outputTokens:20},costUsd:0.02})};
  const result=await runPlan({scriptText:SCRIPT,parsed,facts,input:{format:"reel",tone:"",answers:[]},shots,projectId:"p1",model,ledger,now:()=>new Date(now)});
  expect({source:result.source,reason:result.fallbackReason,usd:result.crewSpend.usd}).toEqual({source:"stand-in",reason:"model_unusable",usd:0.02});
  // And the stand-in plan it falls back to is one the direction accepts.
  expect(()=>crewChanges(result.plan,cast,direction,newId,now)).not.toThrow();
});
