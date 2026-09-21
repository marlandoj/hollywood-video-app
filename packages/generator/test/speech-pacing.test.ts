import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {synthesizeLines} from "../src/speech";
import {compilePerformances,lineDirections} from "../../planner/src/performances";
import {SPEECH_PACE,dialogueSeconds} from "../../planner/src/crew/production-plan";

/**
 * HV-030-05: the crew pins a shot's length to what the provider bills, and the render then refuses
 * that shot if the temporary speech does not fit inside it. So the crew's estimate of how long a
 * line takes to say is not a nicety — an estimate that runs short cancels a render before a single
 * image is requested, and the creator is told to lengthen a shot the studio chose for them.
 *
 * This holds `dialogueSeconds` to the engine it is estimating. Every case is synthesized by the same
 * function the worker runs, and the estimate must cover what came back, including the tail the
 * renderer pads. The corpus is deliberately awkward: one-word lines, punctuation-dense lines (where
 * the engine runs longest against its nominal pace), long plain sentences (where it runs shortest),
 * and lines directed down to the slowest pace the editor allows.
 */
const root=mkdtempSync(join(tmpdir(),"hv-speech-pacing-"));afterAll(()=>rmSync(root,{recursive:true,force:true}));
const speechTest=Bun.which("espeak-ng")?test:test.skip;
const LINES=[
  "No.",
  "You came back.",
  "Grandma! You kept it burning!",
  "We have time to walk through the garden.",
  "Stop, wait, listen: did you hear that? Something moved out there, beyond the rail.",
  "Welcome to the garden. We have plenty of stories to share today.",
  "I kept this light burning through forty winters and I will keep it burning through forty more, whatever the sea says.",
  "Listen to me. The harbour master signed the order at noon, and by the time the tide turns there will be nothing left of this place but the rocks and the gulls and whatever we manage to carry down the path.",
];
const spoken=(text:string)=>[{character:"NORA",lines:[text]}];
/** The same edit a directed line carries, so the estimate and the engine read one description. */
function directed(dialogue:{character:string;lines:string[]}[],over:{rateWpm?:number|null;beforeMs?:number;afterMs?:number}={}){
  const base=compilePerformances(dialogue,undefined);
  return compilePerformances(dialogue,base,lineDirections([{index:0,sourceHash:base[0]!.source.hash,
    rateWpm:null,pitch:null,level:null,beforeMs:0,afterMs:200,notes:"",...over}]));
}
/** What the renderer needs for this speech: the measured audio plus the tail speech.ts pads. */
async function measuredSeconds(name:string,dialogue:{character:string;lines:string[]}[],performances:ReturnType<typeof compilePerformances>):Promise<number>{
  const audio=await synthesizeLines(mkdtempSync(join(root,name+"-")),dialogue,performances,30,30,undefined,true);
  return audio.speech!.totalSamples/22050+.3;
}

speechTest("the crew's estimate covers what the speech engine actually produces, at every directed pace",async()=>{
  const cases:{rateWpm:number;measured:number;ratio:number}[]=[];
  for(const [index,text] of LINES.entries())for(const rateWpm of [80,120,175,300]){
    const dialogue=spoken(text),performances=directed(dialogue,{rateWpm});
    const measured=await measuredSeconds(`case-${index}-${rateWpm}`,dialogue,performances),estimate=dialogueSeconds(dialogue,performances);
    // The property the render depends on: the estimate is never shorter than the engine's own output.
    expect({text,rateWpm,estimate,measured,covered:estimate>=measured}).toMatchObject({covered:true});
    cases.push({rateWpm,measured,ratio:estimate/measured});
  }
  // An estimate that runs long is safe; one that runs very long is its own defect, because it keeps
  // the crew from pinning a shot to a billed clip that would in fact have held it. The headroom is
  // widest on a line too short to reach any billed ceiling, and on a line directed faster than the
  // engine's own default, where the fixed cost of a pause is charged at the slower nominal rate.
  expect(Math.min(...cases.map(entry=>entry.ratio))).toBeGreaterThan(1);
  expect(Math.max(...cases.map(entry=>entry.ratio))).toBeLessThan(3);
  // Where it counts — speech long enough to reach the shortest clip the configured provider bills,
  // at the engine's own pace or slower — the estimate stays within half as long again.
  const billable=cases.filter(entry=>entry.rateWpm<=175&&entry.measured>=5);
  expect(billable.length).toBeGreaterThan(8);
  expect(Math.max(...billable.map(entry=>entry.ratio))).toBeLessThan(1.5);
},180000);

speechTest("a slower pace is covered too, with the authored silence around the line",async()=>{
  const dialogue=spoken(LINES[4]!),slow=directed(dialogue,{rateWpm:80,beforeMs:1500,afterMs:3000});
  expect(dialogueSeconds(dialogue,slow)).toBeGreaterThanOrEqual(await measuredSeconds("slow",dialogue,slow));
},60000);

test("the estimate counts authored silence, pace and punctuation, and an empty shot costs nothing",()=>{
  expect(dialogueSeconds([])).toBe(0);
  expect(dialogueSeconds([{character:"NORA",lines:["   "]}])).toBe(0);
  const dialogue=spoken(LINES[4]!);
  // Three seconds of authored silence is three seconds the engine renders.
  expect(dialogueSeconds(dialogue,directed(dialogue,{beforeMs:3000,afterMs:0})))
    .toBeCloseTo(dialogueSeconds(dialogue,directed(dialogue,{beforeMs:0,afterMs:0}))+3,6);
  // Half the pace is more than half again as long: the words and the pauses both stretch.
  expect(dialogueSeconds(dialogue,directed(dialogue,{rateWpm:80}))).toBeGreaterThan(dialogueSeconds(dialogue,directed(dialogue))*1.5);
  // The slowest directed line sets the pace for the whole shot, so no line is estimated too fast.
  const two=[{character:"NORA",lines:["You came back."]},{character:"TEO",lines:["I never left."]}];
  const base=compilePerformances(two,undefined);
  const mixed=compilePerformances(two,base,lineDirections([{index:1,sourceHash:base[1]!.source.hash,rateWpm:80,pitch:null,level:null,beforeMs:0,afterMs:200,notes:""}]));
  expect(dialogueSeconds(two,mixed)).toBeGreaterThan(dialogueSeconds(two,compilePerformances(two,base)));
  // Punctuation is a real cost in the model, not decoration.
  expect(SPEECH_PACE.markSec).toBeGreaterThan(0);
  expect(dialogueSeconds(spoken("one two three four"))).toBeLessThan(dialogueSeconds(spoken("one, two, three, four.")));
});
