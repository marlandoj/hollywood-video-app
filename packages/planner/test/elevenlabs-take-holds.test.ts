import {expect,test} from "bun:test";
import {ProjectService} from "../../api/src/index";
import {DurableJobStore} from "../../queue/src/index";
import {currentCasting} from "../src/casting";
import {parseFountain} from "../../parser/src/index";
import {lineSources} from "../src/performances";
import {compileAudioLine} from "../src/audio-performances";
import {audioPolicy,audioTakeHoldUsd,audioTakePlan,elevenLabsLineHoldUsd,validateAudioTake,type AudioPolicy} from "../src/audio-jobs";
import {elevenLabsTakeHoldUsd} from "../../generator/src/elevenlabs-policy-catalogue";
import {elevenLabsLineRequest} from "../../generator/src/elevenlabs-request";
import {ELEVENLABS_MAX_LINE_CHARACTERS} from "../../generator/src/elevenlabs-capability";
import {DEFAULT_VOICE_VENDOR_CAP_USD,assertVoiceVendorBudget} from "../../operator/src/voice-vendor-budget";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {AUDIO_POLICY} from "../../../test/fixtures/audio";
import {AZURE_POLICY,AZURE_PROFILE} from "../../../test/fixtures/azure-audio";
import {ELEVENLABS_POLICY,ELEVENLABS_PROFILE} from "../../../test/fixtures/elevenlabs-audio";

/**
 * HV-022-21 — an ElevenLabs take holds the price of its own line, not of 10,000 characters.
 *
 * The catalogue prices a voice as the plan's rate times the line ceiling. On the operator's plan
 * ($5 for 90,000 characters, docs/evidence/release-2/elevenlabs-voiced.json) that is $0.555556 a
 * take whatever the line says, so the $25 voice line had room for 44 takes in all; a 15-20 minute
 * feature has 150-250 lines. Release 3 build step 6 sizes each take's hold to its own line at the
 * same authorized rate, and raises no limit.
 */
// The operator's own plan, as the catalogue derives it from the saved evidence.
const OPERATOR_POLICY:AudioPolicy=audioPolicy({...policyInput(ELEVENLABS_POLICY),heldUsd:elevenLabsTakeHoldUsd(5,90_000)});
function policyInput(policy:AudioPolicy){
  const {schema:_s,model:_m,permissionRevision:_p,priceRevision:_r,revision:_v,...input}=policy;return input;
}
const FORTY="I kept every light on for you all night.";

function setup(text:string,policy:AudioPolicy=OPERATOR_POLICY,profile=ELEVENLABS_PROFILE){
  process.env.HV_TOKEN_SECRET="elevenlabs-holds-fixture-secret-at-least-thirty-two-characters";
  const projects=new ProjectService(),owner=projects.createAnonymousProject(),script="INT. GARDEN - DAY\n\nMarla waves.\n\nMARLA\n"+text,characterId=crypto.randomUUID();
  projects.editScript(owner.token,script);projects.attestRights(owner.token);projects.saveCharacter(owner.token,characterId,{...CAST_INPUT,name:"Marla",aliases:[]},0);
  const project=projects.snapshot().projects[0]!,casting=currentCasting(project.id,project.castingHistory),source=lineSources(parseFountain(script).scenes[0]!.dialogue)[0]!;
  const voice={...profile,voice:{id:policy.voiceId,catalogueRevision:policy.catalogueRevision,permissionRevision:policy.permissionRevision}};
  const line=compileAudioLine(source,voice,{sourceHash:source.hash,beforeMs:250,afterMs:500});
  const take=audioTakePlan(0,characterId,line,policy,"local");
  const job=(heldUsd:number,audioTake=take)=>({id:crypto.randomUUID(),projectId:project.id,idempotencyKey:"fixture",tier:"free" as const,stage:"audio-take" as const,scriptVersion:1,scriptText:script,casting,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,
    totalFrames:0,costCapUsd:heldUsd,budgetReservedUsd:heldUsd,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:180000,audioTake});
  return {line,take,job,characterId};
}

test("a 40-character line holds 40 characters at the authorized rate, rounded up to the micro-dollar",()=>{
  const f=setup(FORTY);
  expect(f.line.spokenText).toBe(FORTY);
  expect(FORTY.length).toBe(40);
  // $0.555556 per 10,000 characters: 40 characters are 2,222.224 micro-dollars, held as 2,223.
  expect(OPERATOR_POLICY.heldUsd).toBe(0.555556);
  expect(f.take.heldUsd).toBe(0.002223);
  expect(audioTakeHoldUsd(f.take)).toBe(0.002223);
  // At the fixture's round $0.50 per 10,000 characters there is nothing to round: exactly $0.002.
  expect(audioTakeHoldUsd(setup(FORTY,ELEVENLABS_POLICY).take)).toBe(0.002);
  // The count is the text the request sends, which is what the vendor bills.
  expect(elevenLabsLineRequest(f.line).body.text.length).toBe(40);
});

test("a longer line holds more, and no line holds more than the policy's own ceiling",()=>{
  const short=audioTakeHoldUsd(setup(FORTY).take),long=audioTakeHoldUsd(setup(FORTY.repeat(10)).take);
  expect(long).toBeGreaterThan(short);
  // 400 characters: 22,222.24 micro-dollars, held as 22,223.
  expect(long).toBe(0.022223);
  // The ceiling line holds exactly the ceiling: integer micro-dollars, no floating-point drift.
  expect(elevenLabsLineHoldUsd(OPERATOR_POLICY,ELEVENLABS_MAX_LINE_CHARACTERS)).toBe(OPERATOR_POLICY.heldUsd);
  for(const characters of [1,7,39,40,41,999,4_321,9_999])
    expect(elevenLabsLineHoldUsd(OPERATOR_POLICY,characters)).toBeLessThanOrEqual(OPERATOR_POLICY.heldUsd);
  // Rounded up, never down: the hold is never below the line's exact price.
  for(const characters of [1,7,39,40,41,999,4_321,9_999]){
    const held=elevenLabsLineHoldUsd(OPERATOR_POLICY,characters);
    expect(held*1e6).toBeGreaterThanOrEqual(OPERATOR_POLICY.heldUsd*1e6*characters/ELEVENLABS_MAX_LINE_CHARACTERS-1e-6);
    expect(Number(held.toFixed(6))).toBe(held);
  }
  // A line past the ceiling, or no line at all, is refused rather than priced.
  for(const characters of [0,-1,1.5,ELEVENLABS_MAX_LINE_CHARACTERS+1])expect(()=>elevenLabsLineHoldUsd(OPERATOR_POLICY,characters)).toThrow("price policy");
});

test("about 200 typical lines fit the $25 voice line, where the ceiling hold fitted 44",()=>{
  // 120 characters is a long screenplay line; a feature's lines are mostly shorter.
  const text="Then tell me why the boat was gone before the tide turned, and why nobody in this town will say one word about it to me.";
  expect(text.length).toBe(120);
  const typical=audioTakeHoldUsd(setup(text).take);
  expect(typical).toBe(0.006667);
  let committed=0,admitted=0;
  for(let line=0;line<250;line++){
    try{assertVoiceVendorBudget({provider:"elevenlabs",spentUsd:0,heldUsd:committed,capUsd:DEFAULT_VOICE_VENDOR_CAP_USD},typical);}catch{break;}
    committed=Number((committed+typical).toFixed(6));admitted++;
  }
  // All 250 of a long feature's lines, for $1.67 of the line's $25.
  expect(admitted).toBe(250);
  expect(committed).toBeLessThan(2);
  // The same walk at the ceiling hold every take used to carry: the 45th take was refused.
  let ceiling=0,fitted=0;
  for(let line=0;line<250;line++){
    try{assertVoiceVendorBudget({provider:"elevenlabs",spentUsd:0,heldUsd:ceiling,capUsd:DEFAULT_VOICE_VENDOR_CAP_USD},OPERATOR_POLICY.heldUsd);}catch{break;}
    ceiling=Number((ceiling+OPERATOR_POLICY.heldUsd).toFixed(6));fitted++;
  }
  expect(fitted).toBe(44);
});

test("an admitted take's job carries exactly its line's hold; the ceiling or a forged hold is refused",()=>{
  const f=setup(FORTY),hold=audioTakeHoldUsd(f.take);
  const queue=DurableJobStore.fromJobs([]);
  expect(queue.enqueue(f.job(hold)).budgetReservedUsd).toBe(hold);
  expect(()=>validateAudioTake(f.job(hold))).not.toThrow();
  // The job may not reserve or cap at a different figure than the take records.
  expect(()=>validateAudioTake(f.job(OPERATOR_POLICY.heldUsd))).toThrow("Invalid isolated audio audition job");
  // And the take's own hold is re-derived from its line and policy, never trusted.
  for(const forged of [0.000001,hold/2,OPERATOR_POLICY.heldUsd])
    expect(()=>validateAudioTake(f.job(forged,{...f.take,heldUsd:forged}))).toThrow();
});

test("an ElevenLabs take admitted before this holds its ceiling and still validates; other vendors are unchanged",()=>{
  const f=setup(FORTY);
  // A stored take from before HV-022-21: no hold of its own, the policy's whole ceiling reserved.
  const {heldUsd:_held,revision:_revision,...data}=f.take,legacy=audioTakePlan(f.take.sceneIndex,f.characterId,f.line,OPERATOR_POLICY,"local",Date.parse(f.take.admittedAt),f.take.requestHash,undefined,true);
  expect(legacy).toEqual({...data,revision:legacy.revision});
  expect(audioTakeHoldUsd(legacy)).toBe(OPERATOR_POLICY.heldUsd);
  expect(()=>validateAudioTake(f.job(OPERATOR_POLICY.heldUsd,legacy))).not.toThrow();
  expect(()=>validateAudioTake(f.job(0.002223,legacy))).toThrow("Invalid isolated audio audition job");
  // Cartesia and Azure takes keep their per-take hold and carry no line hold.
  const cartesia=setup("Hello.",AUDIO_POLICY,{schema:"hv-audio-voice/1",provider:"cartesia",language:"en",voice:ELEVENLABS_PROFILE.voice,controls:{speed:1,volume:1,emotion:"calm"},pronunciations:[]} as typeof ELEVENLABS_PROFILE);
  const azure=setup("Hello.",AZURE_POLICY,AZURE_PROFILE as typeof ELEVENLABS_PROFILE);
  for(const [other,policy] of [[cartesia,AUDIO_POLICY],[azure,AZURE_POLICY]] as const){
    expect(other.take.heldUsd).toBeUndefined();
    expect(audioTakeHoldUsd(other.take)).toBe(policy.heldUsd);
    expect(()=>validateAudioTake(other.job(policy.heldUsd))).not.toThrow();
    expect(()=>validateAudioTake(other.job(0.000001,{...other.take,heldUsd:0.000001}))).toThrow();
  }
});
