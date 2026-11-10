/**
 * HV-030-43 — in a feature whose plan places its lines, each speech is on a shot near the action it
 * follows, preferably one whose action names its speaker, and that shot's prompt says who speaks on camera.
 * Release 3's review of "The Tide Clock" said "Character speaking does not show them talking ... Its like a
 * voice over" and "None of the characters are actually speaking": 27 shots carried all 46 lines, 16 of them
 * two or three speakers, and no prompt said anyone spoke. The rule is packages/planner/src/dialogue-placement.ts;
 * the plan step stamps it on a feature's sequence plan (`dialoguePlacement: "speaker"`), and a plan or a
 * render without the stamp plans as before.
 */
import {describe,expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {contentHash} from "../../generator/src/capabilities";
import {cueVoice,parseFountain,type ParseResult} from "../../parser/src/index";
import {createProviderPlan} from "../../generator/src/catalog";
import {FAL_KLING_MAX_PROMPT_CHARS} from "../../generator/src/fal";
import {promptSize} from "../../generator/src/prompt-limits";
import {stagingProfile} from "../../../test/fixtures/staging-profiles";
import {castingSnapshot,mentioned} from "../src/casting";
import {billedShotTiming,pacedSeconds} from "../src/crew/production-plan";
import {readThroughFacts} from "../src/crew/read-through";
import {dialoguePlacementNote} from "../src/crew/showrunner";
import {applyShotDirection,directionEntry,directionSnapshot,directShots,staleDirections} from "../src/direction";
import {placeSceneDialogue,speakerNames,speakingDirection,speakingDirections} from "../src/dialogue-placement";
import {fitShotPrompt,PromptFitError} from "../src/prompt-fit";
import {proposeSceneCut,sourcePlan} from "../src/scene-cuts";
import {dialoguePlacementHolds,featureShots,filmPlan,greedySequences,inSequence,nextDialoguePlacement,projectShotPlan,projectShots,sceneShotCounts,sequencePlan,sequenceRef,SEQUENCE_SHOT_LIMIT,
  validateSequencePlan,validateSequenceRef} from "../src/sequences";
import {bibleShots,styleBible} from "../src/style-bible";
import {createShotTakes,shotTakeShots,validateShotTakes} from "../src/takes";
import type {Shot} from "../src/index";

/** The feature's shots as they were planned before HV-030-43: each scene's lines on its first shot. */
const before=(parsed:ParseResult)=>{const shots:Shot[]=[];for(const scene of parsed.scenes)shots.push(...sourcePlan({...parsed,scenes:[scene]},undefined,7000+shots.length,SEQUENCE_SHOT_LIMIT,true));return shots;};
const placed=(parsed:ParseResult,direction?:Parameters<typeof featureShots>[1])=>featureShots(parsed,direction,false,"speaker");
const speakers=(shot:Shot)=>new Set(shot.dialogue.map(block=>block.character)).size;
const lines=(shots:Shot[])=>shots.flatMap(shot=>shot.dialogue.map(block=>block.character+": "+block.lines.join(" ")));
const who=(shots:Shot[])=>shots.map(shot=>shot.dialogue.map(block=>block.character));
const scene1=(text:string)=>placed(parseFountain(text)).filter(shot=>shot.sceneIndex===0);
const ON_CAMERA=/speaks? on camera/;

const SCRIPT="INT. WORKSHOP - DAY\n\nAda and Ben lean over a long bench covered in brass gears, springs and half-built clockwork birds while rain streams down the tall windows.\n\n"
  +"ADA\nHold it still.\n\nBen winds a tiny key and the bird twitches its tin wings.\n\nBEN\nIt's ticking.\n\nThe bird lifts off the bench and circles the lamp.\n\n"
  +"EXT. YARD - NIGHT\n\nThe gate swings.\n\nADA\nWho's there?\n\nBEN\nOnly the wind.\n\nADA\nThen why is it singing?\n";

describe("The Tide Clock",()=>{
  const parsed=parseFountain(readFileSync(resolve(import.meta.dir,"../../../docs/evidence/release-3/scripts/feature.fountain"),"utf8"));
  const old=before(parsed),shots=placed(parsed);
  const names=[...new Set(parsed.scenes.flatMap(scene=>scene.dialogue.map(block=>block.character)))];
  /** Of the dialogue shots: how many have an action naming a speaker, else naming another character, else nobody. */
  const named=(plan:Shot[])=>{const counts={speaker:0,others:0,nobody:0};
    for(const shot of plan.filter(value=>value.dialogue.length)){
      const heading=parsed.scenes[shot.sceneIndex]!.heading+". ",speaking=speakingDirection(shot.dialogue),own=shot.dialogue.map(block=>block.character);
      const action=shot.prompt.slice(heading.length+(speaking&&shot.prompt.startsWith(heading+speaking+" ")?speaking.length+1:0));
      if(own.some(name=>speakerNames(name).some(alias=>mentioned(alias,action))))counts.speaker++;
      else if(names.filter(name=>!own.includes(name)).some(name=>mentioned(name,action)))counts.others++;else counts.nobody++;
    }return counts;};
  test("without the plan's placement, every line is on its scene's first shot, as it was",()=>{
    expect(featureShots(parsed)).toEqual(old);
    const was=old.filter(shot=>shot.dialogue.length);
    expect([old.length,was.length,lines(old).length,was.filter(shot=>speakers(shot)>1).length]).toEqual([202,27,46,16]);
  });
  test("placed: 46 shots of one line each, no shot added, fewer seconds billed",()=>{
    const now=shots.filter(shot=>shot.dialogue.length);
    expect([shots.length,now.length,lines(shots).length,now.filter(shot=>speakers(shot)>1).length]).toEqual([202,46,46,0]);
    // The same shots, ids, seeds and scene counts, and every scene's lines in the same order.
    expect(shots.map(shot=>[shot.id,shot.sceneIndex,shot.seed,shot.durationSec])).toEqual(old.map(shot=>[shot.id,shot.sceneIndex,shot.seed,shot.durationSec]));
    for(const scene of parsed.scenes)expect(lines(shots.filter(shot=>shot.sceneIndex===scene.index))).toEqual(lines(old.filter(shot=>shot.sceneIndex===scene.index)));
    // No line is on a scene's establishing shot when the scene has a shot to spare.
    expect(shots.filter(shot=>shot.id.endsWith("-1")&&shot.dialogue.length)).toEqual([]);
    // On the live profile's billed clips (floor 5 s), the Editor's pacing bills 1,071 s before and 1,025 s after.
    const timing=billedShotTiming(createProviderPlan("final",5,undefined,stagingProfile("live-film-referenced")).pool)!;
    const billed=(plan:Shot[])=>plan.reduce((total,shot)=>total+pacedSeconds(timing,shot)!,0);
    expect([billed(old),billed(shots)]).toEqual([1071,1025]);
  });
  test("the read-through quotes $79.45 for the old placement and $74.55 placed, on the live referenced profile",()=>{
    // The read-through and the plan step quote a feature over these shots (server.ts); no locks, no cast.
    const text=readFileSync(resolve(import.meta.dir,"../../../docs/evidence/release-3/scripts/feature.fountain"),"utf8");
    const pool=createProviderPlan("final",5,undefined,stagingProfile("live-film-referenced")).pool,casting=castingSnapshot("project-1",0,[],0);
    const quote=(plan:Shot[])=>readThroughFacts(text,parsed,{format:"feature",tone:""},plan,pool,{casting}).estimate;
    expect(quote(old)).toMatchObject({videoSpec:"fal:kling-o3-standard-reference",basis:"profile",finalVideoUsd:79.45});
    expect(quote(shots)).toMatchObject({videoSpec:"fal:kling-o3-standard-reference",basis:"profile",finalVideoUsd:74.55});
  });
  test("33 of the 46 dialogue shots name their speaker in the action, 4 only someone else, 9 nobody",()=>{
    // For reference, the old placement's 27 first shots: 10 named a speaker.
    expect(named(old)).toEqual({speaker:10,others:3,nobody:14});
    expect(named(shots)).toEqual({speaker:33,others:4,nobody:9});
  });
  test("says who speaks on camera in each dialogue shot and changes nothing else",()=>{
    const marisol=shots.find(shot=>shot.dialogue.some(block=>block.character==="MARISOL"))!;
    expect(marisol.prompt).toContain(". MARISOL speaks on camera: face visible, mouth moving, framed for dialogue. ");
    for(const [index,shot]of shots.entries()){
      const was=old[index]!,heading=parsed.scenes[shot.sceneIndex]!.heading+". ";
      expect(shot.prompt).toBe(shot.dialogue.length?heading+speakingDirection(shot.dialogue)+" "+was.prompt.slice(heading.length):was.prompt);
    }
    expect(Math.max(...shots.map(shot=>speakingDirection(shot.dialogue).length))).toBe(74);
  });
  test("is planned the same every time, and the sequence plan's counts are unchanged",()=>{
    expect(placed(parsed)).toEqual(shots);
    expect(sceneShotCounts(parsed)).toEqual(parsed.scenes.map(scene=>old.filter(shot=>shot.sceneIndex===scene.index).length));
  });
});

describe("placement",()=>{
  const parsed=parseFountain(SCRIPT);
  test("follows the action each speech comes after, one speech a shot",()=>{
    expect(who(placed(parsed).filter(shot=>shot.sceneIndex===0))).toEqual([[],["ADA"],["BEN"]]);
  });
  test("shares a shot only when the scene has fewer shots than speakers, and says both speak",()=>{
    const yard=placed(parsed).filter(shot=>shot.sceneIndex===1);
    expect(yard.length).toBe(1);
    expect(yard[0]!.dialogue.map(block=>block.character)).toEqual(["ADA","BEN","ADA"]);
    expect(yard[0]!.prompt).toBe("EXT. YARD - NIGHT. ADA and BEN speak on camera: faces visible, mouths moving, framed for dialogue. The gate swings.");
  });
  test("keeps one speaker's consecutive speeches together when there are more speeches than shots",()=>{
    const scene=parseFountain("INT. HALL - DAY\n\nA door.\n\nADA\nOne.\n\nADA\nTwo.\n\nBEN\nThree.\n\nA window.\n\nBEN\nFour.\n").scenes[0]!;
    const shots=sourcePlan({scenes:[scene],warnings:[],unparseable:[]} as unknown as ParseResult,undefined,7000,24,true);
    expect(placeSceneDialogue(scene,shots).map(shot=>shot.dialogue.map(block=>block.lines[0]))).toEqual([["One.","Two."],["Three.","Four."]]);
  });
  test("with exactly as many speeches as shots, every shot carries one, the first included",()=>{
    expect(who(scene1("INT. HALL - DAY\n\nA door opens.\n\nADA\nOne.\n\nBEN\nTwo.\n\nCAL\nThree.\n\nA window.\n\nA lamp.\n"))).toEqual([["ADA"],["BEN"],["CAL"]]);
  });
  test("moves a speech earlier than its action when the later speeches need the later shots",()=>{
    // All three speeches follow the fourth action; the window leaves a shot for each, so "One." lands on the second.
    const shots=scene1("INT. HALL - DAY\n\nA.\n\nB.\n\nC.\n\nD.\n\nADA\nOne.\n\nBEN\nTwo.\n\nCAL\nThree.\n");
    expect(shots.map(shot=>shot.dialogue.map(block=>block.lines[0]))).toEqual([[],["One."],["Two."],["Three."]]);
  });
  test("a scene grouped past 24 beats places each speech on the shot holding the beat it follows",()=>{
    const beats=Array.from({length:30},(_,index)=>"Beat "+(index+1)+": the clock ticks.");
    const shots=scene1("INT. HALL - DAY\n\n"+beats.slice(0,10).join("\n\n")+"\n\nADA\nOne.\n\n"+beats.slice(10,28).join("\n\n")+"\n\nBEN\nTwo.\n\n"+beats.slice(28).join("\n\n")+"\n");
    expect(shots).toHaveLength(24);
    // 30 beats in 24 shots: the first six hold two beats each, so beat 10 is on the fifth shot and beat 28 on the twenty-second.
    expect(shots.flatMap(shot=>shot.dialogue.length?[[shot.id,shot.dialogue[0]!.character]]:[])).toEqual([["shot-1-5","ADA"],["shot-1-22","BEN"]]);
    expect(shots[4]!.prompt).toBe("INT. HALL - DAY. ADA speaks on camera: face visible, mouth moving, framed for dialogue. Beat 9: the clock ticks. Beat 10: the clock ticks.");
  });
  test("leaves a short as it was: every line of a scene on its first shot",()=>{
    const short=sourcePlan(parsed,undefined,7000,24);
    expect(short.map(shot=>shot.dialogue.length)).toEqual([2,0,0,3]);
    expect(short.some(shot=>ON_CAMERA.test(shot.prompt))).toBe(false);
  });
});

describe("placement looks at who is in the shot",()=>{
  const HALL="INT. HALL - NIGHT\n\nThe hall is quiet.\n\nAda lights a lamp.\n\nBEN\nWho's there?\n\n";
  test("a speech moves to the first shot in its window whose action names its speaker",()=>{
    const shots=scene1(HALL+"Ben steps out of the dark.\n\nRain blows in.\n");
    expect(who(shots)).toEqual([[],[],["BEN"],[]]);
    expect(shots[2]!.prompt).toBe("INT. HALL - NIGHT. BEN speaks on camera: face visible, mouth moving, framed for dialogue. Ben steps out of the dark.");
  });
  test("and stays on the shot after its action when no shot in the window names the speaker",()=>{
    expect(who(scene1(HALL+"A shadow moves.\n\nRain blows in.\n"))).toEqual([[],["BEN"],[],[]]);
  });
  test("never past the shot a later speech needs",()=>{
    // Ben is named only on the last shot, which Ada's later speech may need: Ben's speech stays where it was.
    expect(who(scene1(HALL+"Rain blows in.\n\nADA\nOnly me.\n\nBen steps out of the dark.\n"))).toEqual([[],["BEN"],["ADA"],[]]);
  });
  test("a speaker is found by the cue's name, or by it without a leading title",()=>{
    expect(speakerNames("DR. OSWIN")).toEqual(["DR. OSWIN","OSWIN"]);
    expect(speakerNames("MARISOL")).toEqual(["MARISOL"]);
    expect(who(scene1("INT. HALL - NIGHT\n\nThe hall is quiet.\n\nA bell rings.\n\nDR. OSWIN\nLate again.\n\nThe door creaks.\n\nOswin limps in from the rain.\n"))).toEqual([[],[],[],["DR. OSWIN"]]);
  });
  test("is the same every time, in screenplay order, one unit a shot",()=>{
    const text=HALL+"Ben steps out of the dark.\n\nADA\nBen?\n\nRain blows in.\n\nBEN\nIt's me.\n",shots=scene1(text);
    expect(scene1(text)).toEqual(shots);
    // Three speeches on four shots: the window leaves no room for the first to move to Ben's shot.
    expect(who(shots)).toEqual([[],["BEN"],["ADA"],["BEN"]]);
    expect(lines(shots)).toEqual(["BEN: Who's there?","ADA: Ben?","BEN: It's me."]);
  });
});

describe("a speaker the cue says is not on screen",()=>{
  const cue=(extension:string)=>"INT. ROOM - DAY\n\nThe door opens.\n\nMAYA "+extension+"\nCome in.\n";
  const OFF=["(V.O.)","(O.S.)","(O.C.)","(VO)","(OS)","(V/O)","(O/S)","(V.O.) (CONT'D)","(V.O., CONT'D)","(CONT'D) (O.S.)","(off screen)","(OFF)","(voice-over)",
    "(OOV)","(OOF)","(out of frame)"];
  const THROUGH=["(on the radio)","(ON PHONE)","(on the phone)","(over the intercom)","(ON TV)","(through the speaker)","(ON SPEAKER)","(HEADSET)","(FILTERED)",
    "(on the walkie-talkie)","(through the door)"];
  const ON=["","(into phone)","(quietly)","(on the phone, pacing)","(offering the radio)"];
  const SPEAKS="MAYA speaks on camera: face visible, mouth moving, framed for dialogue. ";
  const named=(extension:string)=>"INT. ROOM - DAY\n\nMaya lifts the phone and paces.\n\nMAYA "+extension+"\nCome in.\n";
  test("V.O., O.S., O.C. and their spellings are off camera, even when the action names the speaker",()=>{
    for(const extension of OFF){
      expect({extension,voice:cueVoice("MAYA "+extension)}).toEqual({extension,voice:"off-camera"});
      const shots=scene1(cue(extension));
      expect({extension,lines:lines(shots),prompts:shots.map(shot=>shot.prompt)}).toEqual({extension,lines:["MAYA: Come in."],prompts:["INT. ROOM - DAY. The door opens."]});
      expect({extension,prompt:scene1(named(extension))[0]!.prompt}).toEqual({extension,prompt:"INT. ROOM - DAY. Maya lifts the phone and paces."});
    }
  });
  test("a voice through a device or a door is off camera only when the scene's action never names the speaker",()=>{
    for(const extension of THROUGH){
      expect({extension,voice:cueVoice("MAYA "+extension)}).toEqual({extension,voice:"through"});
      expect({extension,prompt:scene1(cue(extension))[0]!.prompt}).toEqual({extension,prompt:"INT. ROOM - DAY. The door opens."});
      // The review's case: the character we see making the call speaks on camera.
      expect({extension,prompt:scene1(named(extension))[0]!.prompt}).toEqual({extension,prompt:"INT. ROOM - DAY. "+SPEAKS+"Maya lifts the phone and paces."});
    }
    // Named anywhere in the scene's action, before or after the speech, and by the name without a title.
    expect(parseFountain("INT. ROOM - DAY\n\nThe phone rings.\n\nWREN (ON PHONE)\nPick up.\n\nWren hangs up.\n").scenes[0]!).not.toHaveProperty("offCameraDialogue");
    expect(parseFountain("INT. ROOM - DAY\n\nOswin dials.\n\nDR. OSWIN (ON PHONE)\nIt's me.\n").scenes[0]!).not.toHaveProperty("offCameraDialogue");
    // The verification's case: action that only describes the speaker's voice does not put the speaker on screen.
    const flags=(text:string)=>parseFountain("INT. ROOM - DAY\n\n"+text).scenes[0]!.offCameraDialogue;
    expect(flags("Static. Hans's voice crackles over the radio.\n\nHANS (on the radio)\nCome in.\n")).toEqual([true]);
    expect(flags("Static. Hans\u2019 voice crackles over the radio.\n\nHANS (on the radio)\nCome in.\n")).toEqual([true]);
    expect(flags("The voice of Hans fills the room.\n\nHANS (OVER THE PA)\nAttention.\n")).toEqual([true]);
    // Seen in person as well as heard, the speaker is on camera.
    expect(flags("Hans lifts the handset. Hans's voice is hoarse.\n\nHANS (on the radio)\nCome in.\n")).toBeUndefined();
  });
  test("any other extension, or none, is a speaker on camera",()=>{
    for(const extension of ON){
      expect({extension,voice:cueVoice("MAYA "+extension)}).toEqual({extension,voice:"on-camera"});
      expect({extension,prompt:scene1(cue(extension))[0]!.prompt}).toEqual({extension,prompt:"INT. ROOM - DAY. "+SPEAKS+"The door opens."});
    }
  });
  test("a bare (CONT'D) continues the same speaker's previous speech in the scene, off camera or on",()=>{
    for(const extension of ["(CONT'D)","(CONT’D)","(cont.)","(CONTINUING)"])expect({extension,voice:cueVoice("MAYA "+extension)}).toEqual({extension,voice:"continued"});
    const flags=(text:string)=>parseFountain("INT. ROOM - DAY\n\n"+text).scenes[0]!.offCameraDialogue;
    // After a (V.O.) cue, without repeating it: still the voice-over, across another speaker's line.
    expect(flags("A lamp.\n\nNARRATOR (V.O.)\nIt was late.\n\nADA\nWho's there?\n\nNARRATOR (CONT'D)\nToo late.\n")).toEqual([true,false,true]);
    // After an on-camera speech, or as the speaker's first, on camera.
    expect(flags("A lamp.\n\nNARRATOR (V.O.)\nIt was late.\n\nADA\nHi.\n\nADA (CONT'D)\nAgain.\n")).toEqual([true,false,false]);
    expect(flags("A lamp.\n\nADA (CONT'D)\nHi.\n")).toBeUndefined();
    // After a phone voice whose speaker the action names, on camera; whose speaker it never names, off.
    expect(flags("Maya dials.\n\nMAYA (ON PHONE)\nHi.\n\nMAYA (CONT'D)\nAgain.\n")).toBeUndefined();
    expect(flags("The phone rings.\n\nMAYA (ON PHONE)\nHi.\n\nMAYA (CONT'D)\nAgain.\n")).toEqual([true,true]);
    expect(scene1("INT. ROOM - DAY\n\nA lamp.\n\nThe door opens.\n\nNARRATOR (V.O.)\nIt was late.\n\nNARRATOR (CONT'D)\nToo late.\n").some(shot=>ON_CAMERA.test(shot.prompt))).toBe(false);
  });
  test("the review's case: HANS on the radio and the NARRATOR's voice-over are placed and named on no shot",()=>{
    const shots=scene1("INT. ROOM - DAY\n\nThe door opens.\n\nA lamp flickers.\n\nHANS (on the radio)\nCome in.\n\nNARRATOR (V.O.)\nIt was late.\n");
    expect(lines(shots)).toEqual(["HANS: Come in.","NARRATOR: It was late."]);
    expect(shots.some(shot=>ON_CAMERA.test(shot.prompt))).toBe(false);
  });
  test("the parser flags it beside the speech, and leaves the speech and its beats as they were",()=>{
    const scene=parseFountain("INT. ROOM - DAY\n\nA lamp.\n\nADA\nHi.\n\nNARRATOR (V.O.)\nShe waited.\n").scenes[0]!;
    expect(scene.offCameraDialogue).toEqual([false,true]);
    expect(scene.dialogue).toEqual([{character:"ADA",lines:["Hi."]},{character:"NARRATOR",lines:["She waited."]}]);
    expect(scene.beats!.filter(beat=>beat.kind==="dialogue").map(beat=>Object.keys(beat).sort().join(","))).toEqual(Array(2).fill("character,endLine,id,kind,lines,startLine"));
    // A scene with no such speech carries no flags at all.
    expect(parseFountain(SCRIPT).scenes.some(value=>Object.hasOwn(value,"offCameraDialogue"))).toBe(false);
  });
  test("a shared shot names only the speaker on camera, and the fit keeps that sentence",()=>{
    const text="INT. ROOM - DAY\n\n"+"Ada paces past the shelves of jars and coils of wire, stopping at the window. ".repeat(10)+"\n\nADA\nHi.\n\nNARRATOR (V.O.)\nShe waited.\n";
    const parsed=parseFountain(text),shot=placed(parsed)[0]!,speaking="ADA speaks on camera: face visible, mouth moving, framed for dialogue.";
    expect(shot.prompt.startsWith("INT. ROOM - DAY. "+speaking+" Ada paces")).toBe(true);
    expect(speakingDirections(parsed.scenes[0],shot.dialogue)).toEqual([speaking]);
    const fitted=fitShotPrompt(shot,400,{parsed});
    expect(promptSize(fitted.prompt)).toBeLessThanOrEqual(400);
    expect(fitted.prompt.startsWith("INT. ROOM - DAY. "+speaking+" Ada paces")).toBe(true);
  });
});

describe("who the sentence names",()=>{
  test("a cue whose only line is a parenthetical speaks no line, so names nobody",()=>{
    expect(speakingDirection([{character:"ADA",lines:["(laughs)"]}])).toBe("");
    expect(scene1("INT. ROOM - DAY\n\nA lamp.\n\nADA\n(laughs)\n\nBEN\nFunny.\n")[0]!.prompt).toBe("INT. ROOM - DAY. BEN speaks on camera: face visible, mouth moving, framed for dialogue. A lamp.");
  });
  test("one name however the cues capitalise it, as casting compares names",()=>{
    expect(speakingDirection([{character:"Ada",lines:["Hi."]},{character:"ADA",lines:["Again."]}])).toBe("Ada speaks on camera: face visible, mouth moving, framed for dialogue.");
    expect(scene1("INT. ROOM - DAY\n\nA lamp.\n\n@Ada\nHi.\n\nADA\nAgain.\n")[0]!.prompt).toBe("INT. ROOM - DAY. Ada speaks on camera: face visible, mouth moving, framed for dialogue. A lamp.");
  });
  test("three names at most, then \"and others\"",()=>{
    const say=(...names:string[])=>speakingDirection(names.map(character=>({character,lines:["Hi."]})));
    expect(say("ADA","BEN","CAL")).toBe("ADA, BEN and CAL speak on camera: faces visible, mouths moving, framed for dialogue.");
    expect(say("ADA","BEN","CAL","DEV")).toBe("ADA, BEN, CAL and others speak on camera: faces visible, mouths moving, framed for dialogue.");
    expect(say("ADA","BEN","CAL","DEV","EVE","FAY")).toBe(say("ADA","BEN","CAL","DEV"));
  });
});

describe("prompt fit",()=>{
  const WORKSHOP="INT. WORKSHOP - DAY\n\n"+"Ada reaches across the cluttered bench past jars of springs and coils of wire. ".repeat(8)+"\n\nADA\nHold it still.\n";
  test("cuts the style bible, the shot direction and the action before the speaking direction, which it never cuts",()=>{
    const parsed=parseFountain(WORKSHOP);
    const bible=styleBible({version:1,scriptVersion:1,source:"stand-in",characters:[],locations:[{name:"WORKSHOP",description:"A cluttered brick workshop with a skylight and a cast-iron stove."}],
      look:"Warm and tactile, with practical light and slow, observant camera moves that let scenes breathe.",palette:"Copper, brass and deep teal, with warm skin tones and inky shadows.",
      lighting:"Motivated window light by day; lamps and the stove's glow by night.",lens:"Wide to open a place, medium for action, close-ups for dialogue.",tone:"Curious and tender.",
      sound:"A ticking motif under the score; rain and kettles carry scenes."});
    const shot=bibleShots([applyShotDirection(placed(parsed)[0]!,{size:"close-up",keyLight:"Soft window light from screen left",soundIntent:"Rain on glass"})],parsed,bible)[0]!;
    const speaking="ADA speaks on camera: face visible, mouth moving, framed for dialogue.";
    expect(shot.prompt.startsWith("INT. WORKSHOP - DAY. "+speaking+" Ada reaches")).toBe(true);
    const fitted=fitShotPrompt(shot,400,{parsed,styleBible:bible});
    expect(promptSize(fitted.prompt)).toBeLessThanOrEqual(400);
    expect(fitted.prompt.startsWith("INT. WORKSHOP - DAY. "+speaking+" Ada reaches")).toBe(true);
    const parts=fitted.promptFit!.trimmed.map(trim=>trim.part);
    expect(parts.indexOf("style")).toBeLessThan(parts.indexOf("direction"));
    expect(parts.indexOf("direction")).toBeLessThan(parts.indexOf("action"));
    // Cut as far as it goes, the action keeps its own first 240 characters after the speaking direction.
    const floor=fitShotPrompt(shot,340,{parsed,styleBible:bible});
    expect(floor.promptFit!.trimmed.at(-1)!.part).toBe("action");
    expect(floor.prompt).toContain(speaking+" Ada reaches");
  });
  test("sixty speakers with 38-character names in a one-shot scene still fit Kling's 2,500 characters",()=>{
    const names=Array.from({length:60},(_,index)=>"VOICE "+String(index+1).padStart(2,"0")+" "+"X".repeat(29));
    expect(names.every(name=>name.length===38)).toBe(true);
    const text="INT. HALL - NIGHT\n\n"+"The whole crowd surges along the harbour wall towards the lamps, shouting over the wind. ".repeat(30)+"\n\n"+names.map((name,index)=>name+"\nLine "+(index+1)+".").join("\n\n")+"\n";
    const parsed=parseFountain(text),shot=placed(parsed)[0]!;
    expect(shot.dialogue).toHaveLength(60);
    const speaking=speakingDirection(shot.dialogue);
    expect(speaking).toBe(names.slice(0,3).join(", ")+" and others speak on camera: faces visible, mouths moving, framed for dialogue.");
    // Every name in it would have been over 2,400 characters of never-cut prompt.
    expect((names.slice(0,-1).join(", ")+" and "+names.at(-1)+" speak on camera: faces visible, mouths moving, framed for dialogue.").length).toBeGreaterThan(2400);
    expect(promptSize(shot.prompt)).toBeGreaterThan(FAL_KLING_MAX_PROMPT_CHARS);
    const fitted=fitShotPrompt(shot,FAL_KLING_MAX_PROMPT_CHARS,{parsed});
    expect(promptSize(fitted.prompt)).toBeLessThanOrEqual(FAL_KLING_MAX_PROMPT_CHARS);
    expect(fitted.prompt.startsWith("INT. HALL - NIGHT. "+speaking+" The whole crowd")).toBe(true);
  });
  test("when nothing more can be cut, the refusal names the speaking sentence it kept",()=>{
    const parsed=parseFountain(WORKSHOP),shot=placed(parsed)[0]!;
    expect(()=>fitShotPrompt(shot,200,{parsed})).toThrow(PromptFitError);
    expect(()=>fitShotPrompt(shot,200,{parsed})).toThrow("What is left is the scene heading, the sentence saying who speaks on camera (\"ADA speaks on camera: face visible, mouth moving, framed for dialogue.\"), the action's opening");
    // A shot with no speaking sentence is refused in the words it was before.
    const silent={...sourcePlan(parsed,undefined,7000,24)[0]!,dialogue:[]};
    expect(()=>fitShotPrompt(silent,100,{parsed})).toThrow("What is left is the scene heading, the action's opening");
  });
});

describe("what a creator saved",()=>{
  const parsed=parseFountain(SCRIPT),counts=sceneShotCounts(parsed),old=before(parsed);
  test("an accepted scene cut keeps its own shots and lines",()=>{
    const cut=proposeSceneCut(parsed.scenes[0]!);
    const direction=directionSnapshot("project-1",1,[],0,[cut]);
    const shots=placed(parsed,direction).filter(shot=>shot.sceneIndex===0);
    expect(shots).toEqual(sourcePlan({...parsed,scenes:[parsed.scenes[0]!]},{...direction,sceneCuts:[cut]},7000,24,true));
    expect(shots.some(shot=>shot.prompt.includes("on camera"))).toBe(false);
  });
  test("a plan, and a render's sequence, saved before the placement validate and hash exactly as they did, and plan as they did",()=>{
    const plan=sequencePlan(1,greedySequences(counts));
    expect(Object.hasOwn(plan,"dialoguePlacement")).toBe(false);
    expect(plan.revision).toBe(contentHash({schema:"hv-sequence-plan/1",scriptVersion:1,sequences:plan.sequences}));
    expect(validateSequencePlan(structuredClone(plan))).toEqual(plan);
    const ref=sequenceRef(plan,1);
    expect(Object.hasOwn(ref,"dialoguePlacement")).toBe(false);
    expect(validateSequenceRef(structuredClone(ref))).toEqual(ref);
    expect(filmPlan(parsed,undefined,24,ref)).toEqual(old);
  });
  test("a plan that places its lines says so in its revision and in every sequence it renders",()=>{
    const plan=sequencePlan(1,greedySequences(counts),"speaker"),legacy=sequencePlan(1,greedySequences(counts));
    expect(plan.dialoguePlacement).toBe("speaker");
    expect(plan.revision).not.toBe(legacy.revision);
    expect(validateSequencePlan(structuredClone(plan))).toEqual(plan);
    // Neither the stamp nor its absence can be edited into a saved plan.
    expect(()=>validateSequencePlan({...plan,dialoguePlacement:"first-shot"})).toThrow();
    const {dialoguePlacement:_drop,...stripped}=plan;
    expect(()=>validateSequencePlan(stripped)).toThrow("changed");
    expect(()=>validateSequencePlan({...legacy,dialoguePlacement:"speaker"})).toThrow("changed");
    const ref=sequenceRef(plan,1);
    expect(ref.dialoguePlacement).toBe("speaker");
    expect(validateSequenceRef(structuredClone(ref))).toEqual(ref);
    expect(()=>validateSequenceRef({...ref,dialoguePlacement:"anywhere"})).toThrow();
    expect(filmPlan(parsed,undefined,24,ref)).toEqual(placed(parsed));
  });
  test("a partial legacy direction keeps every scene's old placement, and the rough cut and the final plan the same shots",()=>{
    // Saved before the change: one direction, on a shot that carries no line under the old placement but would under the new.
    const entry=directionEntry(old.find(shot=>shot.id==="shot-1-2")!,{size:"close-up"}),direction=directionSnapshot("project-1",1,[entry],0);
    expect(placed(parsed).find(shot=>shot.id==="shot-1-2")!.dialogue).not.toEqual([]);
    const plan=sequencePlan(1,greedySequences(counts)),rough=sequenceRef(plan,1),final=sequenceRef(plan,1);
    const roughShots=inSequence(directShots(filmPlan(parsed,direction,24,rough),direction),rough),finalShots=inSequence(directShots(filmPlan(parsed,direction,24,final),direction),final);
    expect(finalShots).toEqual(roughShots);
    expect(roughShots.map(shot=>shot.dialogue.length)).toEqual(old.map(shot=>shot.dialogue.length));
    expect(roughShots.some(shot=>ON_CAMERA.test(shot.prompt))).toBe(false);
    // And with no direction at all an old plan's renders still plan as they did: nothing reads saved hashes now.
    expect(filmPlan(parsed,directionSnapshot("project-1",1,[],0),24,rough)).toEqual(old);
  });
  test("the plan step places a feature's lines unless that would make a saved direction stale",()=>{
    const quiet=parseFountain(SCRIPT+"\nEXT. ROAD - DAY\n\nA cart rolls past.\n"),was=before(quiet),now=placed(quiet);
    const at=(shots:Shot[],id:string)=>shots.find(shot=>shot.id===id)!;
    expect(nextDialoguePlacement(quiet)).toBe("speaker");
    expect(nextDialoguePlacement(quiet,directionSnapshot("project-1",1,[],0))).toBe("speaker");
    // Saved against a shot whose lines would move (as the crew directs every shot): the old placement is kept.
    expect(nextDialoguePlacement(quiet,directionSnapshot("project-1",1,[directionEntry(at(was,"shot-1-1"),{size:"wide"})],0))).toBeUndefined();
    // Saved against a shot that is the same either way: it doesn't hold the placement back.
    expect(at(now,"shot-3-1")).toEqual(at(was,"shot-3-1"));
    expect(nextDialoguePlacement(quiet,directionSnapshot("project-1",1,[directionEntry(at(was,"shot-3-1"),{size:"wide"})],0))).toBe("speaker");
    // Saved against the new placement: it is kept.
    const fresh=directionSnapshot("project-1",1,[directionEntry(at(now,"shot-1-2"),{size:"close-up"})],0);
    expect(nextDialoguePlacement(quiet,fresh)).toBe("speaker");
    expect(at(directShots(placed(quiet,fresh),fresh),"shot-1-2").prompt).toContain("ADA speaks on camera");
  });
  test("a feature already placed stays placed when planned again, and what holds an unplaced one back is named",()=>{
    const was=before(parsed),at=(shots:Shot[],id:string)=>shots.find(shot=>shot.id===id)!;
    // The second review's case: the crew directed the placed shots; then a script edit adds BEN's speech.
    const room="INT. ROOM - DAY\n\nThe door opens.\n\nADA\nOne.\n\nA lamp flickers.\n\nA dog sleeps.\n\n";
    const first=parseFountain(room+"The rain stops.\n"),edited=parseFountain(room+"BEN\nTwo.\n\nThe rain stops.\n");
    const crew=directionSnapshot("project-1",1,placed(first).map(shot=>directionEntry(shot,{size:"wide"})),0);
    // Asked afresh, the third shot holds it back: empty when the crew directed it, it is current with every
    // line on the first shot and stale with BEN's speech placed on it. A placed feature is not asked afresh.
    expect(dialoguePlacementHolds(edited,crew)).toEqual(["shot-1-3"]);
    expect(nextDialoguePlacement(edited,crew)).toBeUndefined();
    expect(nextDialoguePlacement(edited,crew,"speaker")).toBe("speaker");
    expect(staleDirections(placed(edited,crew),crew).map(entry=>entry.source.id)).toEqual(["shot-1-3"]);
    // Old directions: they hold the placement back, in shot order; none, or the placed ones, hold nothing.
    const old=directionSnapshot("project-1",1,[directionEntry(at(was,"shot-2-1"),{}),directionEntry(at(was,"shot-1-1"),{})],0);
    expect(dialoguePlacementHolds(parsed,old)).toEqual(["shot-1-1","shot-2-1"]);
    expect(dialoguePlacementHolds(parsed)).toEqual([]);
    expect(dialoguePlacementHolds(parsed,crew)).toEqual([]);
    expect(nextDialoguePlacement(parsed,old,"speaker")).toBe("speaker");
    expect(dialoguePlacementNote(["shot-1-1"],["shot-1-1"]).change).toBe("Kept each scene's lines on its first shot, because the direction saved for shot-1-1 was made for that placement. "
      +"To put each line on its own shot near its action, framed for its speaker, clear the direction of shot-1-1 and plan again.");
    expect(dialoguePlacementNote(["shot-1-1","shot-2-1"],Array.from({length:8},(_,index)=>"shot-1-"+(index+1))).change).toBe("Kept each scene's lines on its first shot, because the direction saved for shot-1-1 and 1 other shot was made for that placement, and directed the other shots to match. "
      +"To put each line on its own shot near its action, framed for its speaker, clear the directions of shot-1-1, shot-1-2, shot-1-3, shot-1-4, shot-1-5, shot-1-6 and 2 more and plan again.");
  });
  test("the desk, takes and movement plans read the shots the project renders",()=>{
    const legacy=sequencePlan(1,greedySequences(counts)),speaker=sequencePlan(1,greedySequences(counts),"speaker");
    expect(projectShotPlan({format:"short"})).toBeUndefined();
    expect(projectShotPlan({format:"feature",sequences:legacy})).toBe("feature");
    expect(projectShotPlan({format:"feature",sequences:speaker})).toBe("feature-speaker");
    expect(projectShots(parsed,undefined,24)).toEqual(sourcePlan(parsed,undefined,7000,24));
    expect(projectShots(parsed,undefined,24,"feature")).toEqual(filmPlan(parsed,undefined,24,sequenceRef(legacy,1)));
    expect(projectShots(parsed,undefined,24,"feature-speaker")).toEqual(filmPlan(parsed,undefined,24,sequenceRef(speaker,1)));
  });
  test("the review's desk case: the crew directs every placed shot, one desk edit, and the render plans the same placement without a conflict",()=>{
    const plan=sequencePlan(1,greedySequences(counts),"speaker"),ref=sequenceRef(plan,1),kind=projectShotPlan({format:"feature",sequences:plan});
    const crew=directionSnapshot("project-1",1,placed(parsed).map(shot=>directionEntry(shot,{size:shot.dialogue.length?"close-up":"wide"})),0);
    // The desk saves against the shot the project renders, as GET /direction now lists it.
    const desk=projectShots(parsed,crew,24,kind).find(shot=>shot.id==="shot-1-2")!;
    const edited=directionSnapshot("project-1",2,[...crew.entries.filter(entry=>entry.source.id!=="shot-1-2"),directionEntry(desk,{size:"medium"})],0);
    const rendered=directShots(filmPlan(parsed,edited,24,ref),edited);
    expect(who(rendered)).toEqual(who(placed(parsed)));
    expect(rendered.find(shot=>shot.id==="shot-1-2")!.prompt).toContain("ADA speaks on camera");
  });
  test("a take of a feature's placed shot keeps the plan it was taken from, and an older group validates as before",()=>{
    const casting=castingSnapshot("project-1",0,[],0),direction=directionSnapshot("project-1",0,[],0),shot=placed(parsed).find(value=>value.id==="shot-1-2")!;
    const input={shotId:shot.id,sourceHash:directionEntry(shot,{}).sourceHash,maxShots:24,takes:[7,8].map(seed=>({label:"Option "+seed,seed,settings:{}}))};
    const takes=createShotTakes("project-1",1,casting,direction,parsed,input,"feature-speaker");
    expect(takes.shotPlan).toBe("feature-speaker");
    expect(validateShotTakes(structuredClone(takes))).toEqual(takes);
    expect(shotTakeShots(takes,casting,parsed,direction,1).every(take=>take.prompt.includes("ADA speaks on camera"))).toBe(true);
    expect(()=>validateShotTakes({...takes,shotPlan:"feature"})).toThrow("changed");
    // The same shot is not in a short's plan with that source, so a group without the kind can't be made for it.
    expect(()=>createShotTakes("project-1",1,casting,direction,parsed,input)).toThrow("changed");
    const short=sourcePlan(parsed,undefined,7000,24)[0]!,older=createShotTakes("project-1",1,casting,direction,parsed,{...input,shotId:short.id,sourceHash:directionEntry(short,{}).sourceHash});
    expect(Object.hasOwn(older,"shotPlan")).toBe(false);
    expect(validateShotTakes(structuredClone(older))).toEqual(older);
  });
});
