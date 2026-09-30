/**
 * HV-030-21 — the plan step gated each answer on its own, and sent them to the crew model together.
 *
 * The prompt gate's paired rules (FR-054: minor terms beside sexual terms) are about a request as a
 * whole. `planInput` put the tone and each question, proposal and reply through the gate one string
 * at a time, and `runPlan` then sent all of them to the model in one prompt, beside the script. So
 * a tone of "Tense, with teenagers" and a reply of "explicit nude close-ups" each passed, and reached
 * the paid crew model together -- a request the gate refuses when it is shown the two side by side.
 * HV-030-19 closed the same gap for the read-through; this is the plan step, where it predates it.
 *
 * Now the creator's answers are checked together before anything else, and the prompt the model
 * would receive is checked whole before it is sent or spent. Safety refusals only grow.
 */
import {expect,test} from "bun:test";
import {CrewLedger} from "../../operator/src/crew-ledger";
import {parseFountain} from "../../parser/src/index";
import {planInput,runPlan} from "../src/crew/production-plan";
import {readThroughFacts} from "../src/crew/read-through";
import {sourcePlan} from "../src/scene-cuts";

const answer=(id:string,reply:string)=>({id,persona:"director",question:"How should it feel?",proposal:"Quiet and hopeful.",accepted:false,reply});

/** A crew model that records what it is asked. */
function recorder(){
  const sent:string[]=[];
  return {sent,model:{name:"anthropic" as const,model:"claude-test",complete:async(request:{messages:{content:string}[]})=>{sent.push(request.messages.map(message=>message.content).join("\n"));
    return {text:"{}",model:"claude-test",usage:{inputTokens:1,outputTokens:1},costUsd:0.01};}}};
}

test("a tone and a reply that pass one by one but not together are refused, with nothing sent",()=>{
  expect(()=>planInput({format:"reel",tone:"Tense, with teenagers",answers:[answer("q1","Keep it warm.")]})).not.toThrow();
  expect(()=>planInput({format:"reel",tone:"Warm.",answers:[answer("q1","explicit nude close-ups")]})).not.toThrow();
  expect(()=>planInput({format:"reel",tone:"Tense, with teenagers",answers:[answer("q1","explicit nude close-ups")]})).toThrow("nothing was sent to the crew");
});

test("answers that pass together but not beside the script are planned by the stand-in, and the model is asked nothing",async()=>{
  const SCRIPT="INT. HALL - DAY\n\nThe teenager walks home.";
  const parsed=parseFountain(SCRIPT),shots=sourcePlan(parsed,undefined,7000,24),facts=readThroughFacts(SCRIPT,parsed,{format:"reel",tone:""});
  expect(facts.concerns).toEqual([]);
  const input=planInput({format:"reel",tone:"",answers:[answer("q1","explicit nude close-ups")]});
  const r=recorder();
  const result=await runPlan({scriptText:SCRIPT,parsed,facts,input,shots,projectId:"p1",model:r.model,ledger:new CrewLedger()});
  expect({source:result.source,reason:result.fallbackReason,usd:result.crewSpend.usd}).toEqual({source:"stand-in",reason:"content_policy",usd:0});
  expect(r.sent).toEqual([]);
});

test("ordinary answers still reach the crew model",async()=>{
  const SCRIPT="INT. KITCHEN - DAY\n\nMaya pours tea.";
  const parsed=parseFountain(SCRIPT),shots=sourcePlan(parsed,undefined,7000,24),facts=readThroughFacts(SCRIPT,parsed,{format:"reel",tone:""});
  const r=recorder();
  const result=await runPlan({scriptText:SCRIPT,parsed,facts,input:planInput({format:"reel",tone:"Warm.",answers:[answer("q1","Keep it quiet.")]}),shots,projectId:"p1",model:r.model,ledger:new CrewLedger()});
  expect(r.sent.length).toBe(1);
  expect(result.fallbackReason).toBe("model_unusable");
});
