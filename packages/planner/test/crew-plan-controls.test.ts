/**
 * HV-030-13 — a crew plan with a control character was paid for, then refused with a false reason.
 *
 * HV-030-12 gated every shot field at the direction's own length, so an over-long field is refused
 * inside `validateCrewPlan`, where `runPlan` falls back to the stand-in plan. Length was not the only
 * rule the later validators apply: `directionSettings` and `characterRecord` also refuse C0 control
 * characters (other than tab, line feed and carriage return), and `characterRecord` refuses DEL. The
 * crew's gate did not, so a plan whose light read "Soft\fwindow light" or whose wardrobe read
 * "Blue\fapron":
 *
 * - passed `validateCrewPlan` and came back as `source: "anthropic"`, recorded against the crew's
 *   budget;
 * - threw from `crewChanges` -- "keyLight must be text of at most 240 characters.", "Wardrobe must be
 *   text up to 600 characters." -- which the plan route does not catch.
 *
 * The same paid-then-refused failure, now with a reason that is not even true. The gate refuses those
 * characters too, so such a plan falls back to the stand-in plan like any other the studio cannot use.
 */
import {expect,test} from "bun:test";
import {CrewLedger} from "../../operator/src/crew-ledger";
import {parseFountain} from "../../parser/src/index";
import {castingSnapshot} from "../src/casting";
import {crewChanges,runPlan,standInPlan,validateCrewPlan} from "../src/crew/production-plan";
import {readThroughFacts} from "../src/crew/read-through";
import {directionSnapshot} from "../src/direction";
import {sourcePlan} from "../src/scene-cuts";

const SCRIPT="INT. KITCHEN - DAY\n\nMaya pours tea.\n\nMAYA\nYou came back.\n\nEXT. GARDEN - NIGHT\n\nLeo waits in the rain.\n\nLEO\nI never left.";
const parsed=parseFountain(SCRIPT),shots=sourcePlan(parsed,undefined,7000,24);
const facts=readThroughFacts(SCRIPT,parsed,{format:"reel",tone:""});
const now=Date.parse("2026-09-28T22:00:00.000Z");
let counter=0;
const newId=()=>`00000000-0000-4000-8000-${String(++counter).padStart(12,"0")}`;
const cast=castingSnapshot("p1",0,[],now),direction=directionSnapshot("p1",0,[],now);
const refused=(plan:object)=>{try{validateCrewPlan(JSON.stringify(plan),facts,shots);return false;}catch{return true;}};

test("a control character in any shot or cast field the crew writes is refused at the gate",()=>{
  // The plan it is changed from is one the gate accepts, so each refusal below is the character's.
  expect(refused(standInPlan(parsed,facts,shots))).toBe(false);
  expect(standInPlan(parsed,facts,shots).cast.map(entry=>entry.name)).toEqual(["MAYA","LEO"]);
  for(const [field,character] of [["keyLight","\f"],["timeOfDay","\u0007"],["performance","\u001b"],["soundIntent","\u0000"],["transitionIntent","\u007f"]] as const){
    const plan=standInPlan(parsed,facts,shots);plan.shots[0]={...plan.shots[0]!,[field]:"Soft"+character+"window light"};
    expect({field,refused:refused(plan)}).toEqual({field,refused:true});
  }
  for(const field of ["appearance","ageRange","wardrobe"] as const){
    const plan=standInPlan(parsed,facts,shots);plan.cast[0]={...plan.cast[0]!,[field]:"Blue\fapron"};
    expect({field,refused:refused(plan)}).toEqual({field,refused:true});
  }
});

test("and tabs, line feeds and carriage returns are still text, as the direction reads them",()=>{
  const plan=standInPlan(parsed,facts,shots);plan.shots[0]={...plan.shots[0]!,keyLight:"Soft window light,\tthen\nthe lamp\r\nbeside her"};
  expect(()=>crewChanges(validateCrewPlan(JSON.stringify(plan),facts,shots),cast,direction,newId,now)).not.toThrow();
});

test("a paid plan with a control character falls back to the stand-in plan instead of failing the step",async()=>{
  const plan=standInPlan(parsed,facts,shots);plan.cast[0]={...plan.cast[0]!,wardrobe:"Blue\fapron"};
  const ledger=new CrewLedger();
  const model={name:"anthropic" as const,model:"claude-test",complete:async()=>({text:JSON.stringify(plan),model:"claude-test",usage:{inputTokens:10,outputTokens:20},costUsd:0.02})};
  const result=await runPlan({scriptText:SCRIPT,parsed,facts,input:{format:"reel",tone:"",answers:[]},shots,projectId:"p1",model,ledger,now:()=>new Date(now)});
  expect({source:result.source,reason:result.fallbackReason,usd:result.crewSpend.usd}).toEqual({source:"stand-in",reason:"model_unusable",usd:0.02});
  expect(()=>crewChanges(result.plan,cast,direction,newId,now)).not.toThrow();
});
