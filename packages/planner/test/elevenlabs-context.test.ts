import {expect,test} from "bun:test";
import {ProjectService} from "../../api/src/index";
import {currentCasting} from "../src/casting";
import {parseFountain} from "../../parser/src/index";
import {lineSources,type LineSource} from "../src/performances";
import {compileAudioLine,validateAudioLinePlan,type AudioLinePlan} from "../src/audio-performances";
import {elevenLabsBilledCharacters,elevenLabsContext,elevenLabsLineContext} from "../src/elevenlabs-performance";
import {audioPolicy,audioTakeHoldUsd,audioTakePlan,elevenLabsLineHoldUsd,validateAudioTake,type AudioPolicy} from "../src/audio-jobs";
import {narrationLineSource,narrationRead} from "../src/narration-read";
import {elevenLabsTakeHoldUsd} from "../../generator/src/elevenlabs-policy-catalogue";
import {elevenLabsLineRequest} from "../../generator/src/elevenlabs-request";
import {ELEVENLABS_AUDIO_CAPABILITY,ELEVENLABS_CONTEXT_CAPABILITY,ELEVENLABS_MAX_CONTEXT_CHARACTERS,ELEVENLABS_MAX_LINE_CHARACTERS,ELEVENLABS_MODEL} from "../../generator/src/elevenlabs-capability";
import {AUDIO_CAPABILITIES,audioCapability} from "../../generator/src/audio-capabilities";
import {contentHash} from "../../generator/src/capabilities";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {AZURE_PROFILE} from "../../../test/fixtures/azure-audio";
import {ELEVENLABS_POLICY,ELEVENLABS_PROFILE} from "../../../test/fixtures/elevenlabs-audio";

/**
 * HV-022-22 — ElevenLabs lines are read in conversation.
 *
 * The review of "The Tide Clock" (docs/evidence/release-3/release-run.json) heard the voices as a
 * robot. Every ElevenLabs line was sent alone, with no neighbouring dialogue and the speaker boost
 * off. A new, additive contract sends the scene's lines either side as `previous_text`/`next_text`,
 * turns the boost on, and holds the context characters as if the vendor bills them. Nothing here
 * dispatches.
 */
const SCRIPT="INT. PIER - NIGHT\n\nMarla looks at the water.\n\nMARLA\nIs the tide in yet?\n\nTEO\nNot for an hour.\n\nMARLA\n(quietly)\nThen we wait.\n";
const OPERATOR_POLICY:AudioPolicy=audioPolicy({...policyInput(ELEVENLABS_POLICY),heldUsd:elevenLabsTakeHoldUsd(5,90_000)});
function policyInput(policy:AudioPolicy){const {schema:_s,model:_m,permissionRevision:_p,priceRevision:_r,revision:_v,...input}=policy;return input;}
const sources=(script=SCRIPT,scene=0)=>lineSources(parseFountain(script).scenes[scene]!.dialogue);
const voice=(policy:AudioPolicy)=>({...ELEVENLABS_PROFILE,voice:{id:policy.voiceId,catalogueRevision:policy.catalogueRevision,permissionRevision:policy.permissionRevision}});

/** What the take route does: compile, then derive the context from the scene for the line's own length. */
function routeLine(all:LineSource[],index:number,policy:AudioPolicy=ELEVENLABS_POLICY):AudioLinePlan{
  const source=all[index]!,first=compileAudioLine(source,voice(policy),{sourceHash:source.hash,context:{}});
  return compileAudioLine(source,voice(policy),{sourceHash:source.hash,context:elevenLabsLineContext(all,index,first.spokenText.length,policy.maxCharacters)});
}
function setup(script=SCRIPT,policy:AudioPolicy=ELEVENLABS_POLICY){
  process.env.HV_TOKEN_SECRET="elevenlabs-context-fixture-secret-at-least-thirty-two-characters";
  const projects=new ProjectService(),owner=projects.createAnonymousProject(),characterId=crypto.randomUUID();
  projects.editScript(owner.token,script);projects.attestRights(owner.token);projects.saveCharacter(owner.token,characterId,{...CAST_INPUT,name:"Marla",aliases:[]},0);
  const project=projects.snapshot().projects[0]!,casting=currentCasting(project.id,project.castingHistory);
  const job=(take:ReturnType<typeof audioTakePlan>)=>({id:crypto.randomUUID(),projectId:project.id,idempotencyKey:"fixture",tier:"free" as const,stage:"audio-take" as const,scriptVersion:1,scriptText:script,casting,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,
    totalFrames:0,costCapUsd:audioTakeHoldUsd(take),budgetReservedUsd:audioTakeHoldUsd(take),retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:180000,audioTake:take});
  return {characterId,job,take:(line:AudioLinePlan,sceneIndex=0)=>audioTakePlan(sceneIndex,characterId,line,policy,"local")};
}

test("a line given context compiles to the contextual contract and sends its neighbours with the speaker boost on",()=>{
  const all=sources(),line=compileAudioLine(all[1]!,ELEVENLABS_PROFILE,{sourceHash:all[1]!.hash,context:{previousText:"Is the tide in yet?",nextText:"Then we wait."}});
  expect(line.schema).toBe("hv-audio-line/7");
  expect(line.capabilityRevision).toBe(ELEVENLABS_CONTEXT_CAPABILITY.revision);
  expect(line.context).toEqual({previousText:"Is the tide in yet?",nextText:"Then we wait."});
  expect(line.spokenText).toBe("Not for an hour.");
  expect(validateAudioLinePlan(line)).toEqual(line);
  expect(elevenLabsLineRequest(line).body).toEqual({text:"Not for an hour.",previous_text:"Is the tide in yet?",next_text:"Then we wait.",
    model_id:ELEVENLABS_MODEL,apply_text_normalization:"auto",voice_settings:{stability:.5,similarity_boost:.75,style:0,use_speaker_boost:true,speed:1}});
  // A line with no neighbours is still on the contextual contract: no context fields, the boost on.
  const alone=compileAudioLine(all[1]!,ELEVENLABS_PROFILE,{sourceHash:all[1]!.hash,context:{}});
  expect(alone.schema).toBe("hv-audio-line/7");
  expect(validateAudioLinePlan(alone)).toEqual(alone);
  expect(elevenLabsLineRequest(alone).body).toEqual({text:"Not for an hour.",model_id:ELEVENLABS_MODEL,apply_text_normalization:"auto",
    voice_settings:{stability:.5,similarity_boost:.75,style:0,use_speaker_boost:true,speed:1}});
  // The contract is additive and carries no emotion control: both capabilities are listed, and
  // the earlier one keeps the revision every recorded plan pins.
  expect(audioCapability(ELEVENLABS_CONTEXT_CAPABILITY.revision)).toBe(ELEVENLABS_CONTEXT_CAPABILITY);
  expect(AUDIO_CAPABILITIES).toContain(ELEVENLABS_AUDIO_CAPABILITY);
  expect(ELEVENLABS_AUDIO_CAPABILITY.revision).toBe("21655e9ebabe8e8db29d81466d838914977e1942ef93faa1dc8b3a7385b2059d");
  expect(ELEVENLABS_CONTEXT_CAPABILITY.controls.emotion).toBe(false);
  expect(()=>compileAudioLine(all[1]!,{...ELEVENLABS_PROFILE,controls:{...ELEVENLABS_PROFILE.controls,emotion:"sad"}},{sourceHash:all[1]!.hash,context:{}})).toThrow("emotion control");
});

test("a line without context keeps the original contract and exactly its original request",()=>{
  const all=sources(),line=compileAudioLine(all[1]!,ELEVENLABS_PROFILE);
  expect(line.schema).toBe("hv-audio-line/6");
  expect(line.capabilityRevision).toBe(ELEVENLABS_AUDIO_CAPABILITY.revision);
  expect(line).not.toHaveProperty("context");
  expect(validateAudioLinePlan(line)).toEqual(line);
  expect(elevenLabsLineRequest(line).body).toEqual({text:"Not for an hour.",model_id:ELEVENLABS_MODEL,apply_text_normalization:"auto",
    voice_settings:{stability:.5,similarity_boost:.75,style:0,use_speaker_boost:false,speed:1}});
  // Byte for byte, key order included: `toEqual` and `contentHash` both ignore key order, so the body
  // as sent and the dispatch receipt's `requestSha256` are pinned to what main built before HV-022-22.
  expect(line.revision).toBe("a04030793bea70d55ef6bbdee3b0eb346a3b5e9b949418f4d77440968fa09223");
  expect(JSON.stringify(elevenLabsLineRequest(line).body)).toBe('{"text":"Not for an hour.","model_id":"eleven_multilingual_v2","apply_text_normalization":"auto",'
    +'"voice_settings":{"stability":0.5,"similarity_boost":0.75,"style":0,"use_speaker_boost":false,"speed":1}}');
  expect(contentHash(elevenLabsLineRequest(line))).toBe("3b555247dd8c8e437b1c789ed1176c945a07e0a09cc53e4e207c4c3c897b54df");
  // A recorded plan cannot be moved between the two contracts, or given context, without re-compiling it.
  const {revision:_r,...data}=line;
  for(const forged of [{...data,schema:"hv-audio-line/7"},{...data,capabilityRevision:ELEVENLABS_CONTEXT_CAPABILITY.revision},{...data,context:{}}])
    expect(()=>validateAudioLinePlan({...forged,revision:contentHash(forged)} as AudioLinePlan)).toThrow();
  const contextual=compileAudioLine(all[1]!,ELEVENLABS_PROFILE,{sourceHash:all[1]!.hash,context:{previousText:"Is the tide in yet?"}});
  const {revision:_c,...withContext}=contextual,{context:_x,...noContext}=withContext;
  for(const forged of [{...withContext,capabilityRevision:ELEVENLABS_AUDIO_CAPABILITY.revision},{...noContext}])
    expect(()=>validateAudioLinePlan({...forged,revision:contentHash(forged)} as AudioLinePlan)).toThrow();
  // Changing the context without re-compiling changes the plan, and is refused.
  expect(()=>validateAudioLinePlan({...contextual,context:{previousText:"Something else."}})).toThrow("changed");
});

test("context is plain neighbouring dialogue: bounded, tag-free, trimmed, gated, and only for ElevenLabs",()=>{
  const all=sources(),compile=(context:unknown)=>compileAudioLine(all[1]!,ELEVENLABS_PROFILE,{sourceHash:all[1]!.hash,context:context as never});
  expect(compile({previousText:"x".repeat(ELEVENLABS_MAX_CONTEXT_CHARACTERS)}).context!.previousText).toHaveLength(ELEVENLABS_MAX_CONTEXT_CHARACTERS);
  for(const context of [{previousText:"x".repeat(ELEVENLABS_MAX_CONTEXT_CHARACTERS+1)},{nextText:"<break time=\"1s\"/>"},{previousText:" padded"},{nextText:""},
    {previousText:"bell\u0007"},{previousText:42},{speaker:"TEO"},[],"Is the tide in yet?"])
    expect(()=>compile(context)).toThrow();
  expect(elevenLabsContext({})).toEqual({});
  // Another vendor's line has no context field at all.
  expect(()=>compileAudioLine(all[1]!,AZURE_PROFILE,{sourceHash:all[1]!.hash,context:{}} as never)).toThrow("supported audio performance fields");
});

test("the route's context is the scene's lines either side, whoever speaks, left out rather than cut",()=>{
  const all=sources();
  expect(all.map(source=>[source.character,source.text])).toEqual([["MARLA","Is the tide in yet?"],["TEO","Not for an hour."],["MARLA","Then we wait."]]);
  expect(elevenLabsLineContext(all,0,19,10000)).toEqual({nextText:"Not for an hour."});
  expect(elevenLabsLineContext(all,1,16,10000)).toEqual({previousText:"Is the tide in yet?",nextText:"Then we wait."});
  // The parenthetical is a cue, not speech, and is not context either.
  expect(elevenLabsLineContext(all,2,13,10000)).toEqual({previousText:"Not for an hour."});
  // Only as much as fits under the policy's ceiling with the spoken line: previous first, then next.
  expect(elevenLabsLineContext(all,1,10000-19,10000)).toEqual({previousText:"Is the tide in yet?"});
  expect(elevenLabsLineContext(all,1,10000-18,10000)).toEqual({nextText:"Then we wait."});
  expect(elevenLabsLineContext(all,1,10000,10000)).toEqual({});
  // A neighbour that is too long, tagged or refused by the safety gate is left out, never shortened.
  const long="Wait. ".repeat(200).trim(),odd=sources("INT. PIER - NIGHT\n\nMARLA\n"+long+"\n\nTEO\nNot for an hour.\n\nMARLA\nIt is <loud> out here.\n");
  expect(long.length).toBeGreaterThan(ELEVENLABS_MAX_CONTEXT_CHARACTERS);
  expect(elevenLabsLineContext(odd,1,16,10000)).toEqual({});
});

test("a take holds its context characters too, at the line's rate, and an earlier line's hold is unchanged",()=>{
  const all=sources(),f=setup(),contextual=routeLine(all,2),earlier=compileAudioLine(all[2]!,voice(ELEVENLABS_POLICY));
  expect(contextual.context).toEqual({previousText:"Not for an hour."});
  // 13 spoken and 16 context characters: 29 at $0.50 per 10,000 is exactly $0.00145.
  expect(elevenLabsBilledCharacters(contextual)).toBe(29);
  expect(audioTakeHoldUsd(f.take(contextual))).toBe(0.00145);
  expect(audioTakeHoldUsd(f.take(earlier))).toBe(0.00065);
  expect(elevenLabsBilledCharacters(earlier)).toBe(earlier.spokenText.length);
  // On the operator's plan the hold is rounded up to the micro-dollar, never down: 1,611.1124 is held as 1,612.
  const operator=setup(SCRIPT,OPERATOR_POLICY),line=routeLine(all,2,OPERATOR_POLICY);
  expect(audioTakeHoldUsd(operator.take(line))).toBe(0.001612);
  expect(elevenLabsLineHoldUsd(OPERATOR_POLICY,29)).toBe(0.001612);
  // Every take's hold is checked again at admission.
  for(const [fixture,take] of [[f,f.take(contextual)],[f,f.take(earlier)],[operator,operator.take(line)]] as const)
    expect(()=>validateAudioTake(fixture.job(take))).not.toThrow();
});

test("a ceiling-length line drops the context that would not fit, so no take holds more than the policy's price",()=>{
  const spoken="a".repeat(ELEVENLABS_MAX_LINE_CHARACTERS-10),script=SCRIPT.replace("Then we wait.",spoken),all=sources(script),f=setup(script);
  const line=routeLine(all,2);
  expect(line.spokenText).toHaveLength(ELEVENLABS_MAX_LINE_CHARACTERS-10);
  expect(line.context).toEqual({});
  const take=f.take(line);
  expect(audioTakeHoldUsd(take)).toBeLessThanOrEqual(ELEVENLABS_POLICY.heldUsd);
  expect(()=>validateAudioTake(f.job(take))).not.toThrow();
  // Forcing the context in anyway takes the line past its price policy, and it is refused.
  const forced=compileAudioLine(all[2]!,voice(ELEVENLABS_POLICY),{sourceHash:all[2]!.hash,context:{previousText:"Not for an hour."}});
  expect(()=>f.take(forced)).toThrow("price policy");
});

test("admission refuses context that is not the scene's own neighbouring lines",()=>{
  const all=sources(),f=setup(),honest=f.take(routeLine(all,0));
  expect(honest.line.context).toEqual({nextText:"Not for an hour."});
  expect(()=>validateAudioTake(f.job(honest))).not.toThrow();
  // Each forged take is well formed and correctly hashed; only its context is not the scene's.
  for(const context of [{},{nextText:"Something else entirely."},{previousText:"Not for an hour.",nextText:"Not for an hour."}]){
    const forged=f.take(compileAudioLine(all[0]!,voice(ELEVENLABS_POLICY),{sourceHash:all[0]!.hash,context}));
    expect(()=>validateAudioTake(f.job(forged))).toThrow("conversation context");
  }
  // A take on the original contract carries no context and validates as it always did.
  expect(()=>validateAudioTake(f.job(f.take(compileAudioLine(all[0]!,voice(ELEVENLABS_POLICY)))))).not.toThrow();
});

/** Review follow-up S1: a scene's neighbours are its own. The context never reaches across a scene heading. */
const TWO_SCENES="INT. PIER - NIGHT\n\nTEO\nIs the tide in yet?\n\nMARLA\nNot for an hour.\n\nEXT. BOAT - LATER\n\nMARLA\nThen we wait.\n\nTEO\nAll night.\n";
test("the context stays inside its scene: a scene's last line has no next line and the next scene's first line no previous one",()=>{
  const first=sources(TWO_SCENES,0),second=sources(TWO_SCENES,1),f=setup(TWO_SCENES);
  expect(first.map(source=>source.text)).toEqual(["Is the tide in yet?","Not for an hour."]);
  expect(second.map(source=>source.text)).toEqual(["Then we wait.","All night."]);
  expect(elevenLabsLineContext(first,1,16,10000)).toEqual({previousText:"Is the tide in yet?"});
  expect(elevenLabsLineContext(second,0,13,10000)).toEqual({nextText:"All night."});
  // Through admission: the route's own takes validate in either scene.
  const last=f.take(routeLine(first,1),0),opening=f.take(routeLine(second,0),1);
  expect(last.line.context).toEqual({previousText:"Is the tide in yet?"});
  expect(opening.line.context).toEqual({nextText:"All night."});
  for(const take of [last,opening])expect(()=>validateAudioTake(f.job(take))).not.toThrow();
  // A take that borrows the other scene's line as context is refused, though the line is real dialogue.
  const across=(all:LineSource[],index:number,sceneIndex:number,context:object)=>f.take(compileAudioLine(all[index]!,voice(ELEVENLABS_POLICY),{sourceHash:all[index]!.hash,context}),sceneIndex);
  for(const take of [across(first,1,0,{previousText:"Is the tide in yet?",nextText:"Then we wait."}),across(second,0,1,{previousText:"Not for an hour.",nextText:"All night."})])
    expect(()=>validateAudioTake(f.job(take))).toThrow("conversation context");
});

/** Review follow-up S2: a narration read is its own text, so its contextual take carries no neighbours. */
test("a narration take on the contextual contract carries empty context, and forged context on it is refused",()=>{
  const f=setup(),narration=narrationRead({text:"The tide came in at midnight.",reviewed:true}),source=narrationLineSource(narration,"Marla");
  // What the take route compiles for a narration read: the contextual contract with no neighbours.
  const take=(context:object)=>audioTakePlan(0,f.characterId,compileAudioLine(source,voice(ELEVENLABS_POLICY),{sourceHash:source.hash,context}),ELEVENLABS_POLICY,"local",Date.now(),undefined,narration);
  const honest=take({});
  expect({schema:honest.schema,line:honest.line.schema,context:honest.line.context}).toEqual({schema:"hv-audio-take/2",line:"hv-audio-line/7",context:{}});
  expect(elevenLabsBilledCharacters(honest.line)).toBe(narration.text.length);
  expect(()=>validateAudioTake(f.job(honest))).not.toThrow();
  // Even the scene's real first line is not a narration read's context.
  expect(()=>validateAudioTake(f.job(take({previousText:"Is the tide in yet?"})))).toThrow("conversation context");
});
