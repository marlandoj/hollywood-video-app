/**
 * HV-030-43 — in a feature, each line of dialogue is on a shot of the character who speaks it, and that
 * shot's prompt says the character speaks on camera. Release 3's review of "The Tide Clock" said "Character
 * speaking does not show them talking ... Its like a voice over" and "None of the characters are actually
 * speaking": 27 shots carried all 46 lines, 16 of them two or three speakers, and no prompt said anyone spoke.
 * The rule is packages/planner/src/dialogue-placement.ts.
 */
import {describe,expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {parseFountain,type ParseResult} from "../../parser/src/index";
import {createProviderPlan} from "../../generator/src/catalog";
import {promptSize} from "../../generator/src/prompt-limits";
import {stagingProfile} from "../../../test/fixtures/staging-profiles";
import {billedShotTiming,pacedSeconds} from "../src/crew/production-plan";
import {applyShotDirection,directionEntry,directionSnapshot,directShots} from "../src/direction";
import {placeSceneDialogue,speakingDirection} from "../src/dialogue-placement";
import {fitShotPrompt} from "../src/prompt-fit";
import {proposeSceneCut,sourcePlan} from "../src/scene-cuts";
import {featureShots,filmPlan,sceneShotCounts,SEQUENCE_SHOT_LIMIT} from "../src/sequences";
import {bibleShots,styleBible} from "../src/style-bible";
import type {Shot} from "../src/index";

/** The feature's shots as they were planned before HV-030-43: each scene's lines on its first shot. */
const before=(parsed:ParseResult)=>{const shots:Shot[]=[];for(const scene of parsed.scenes)shots.push(...sourcePlan({...parsed,scenes:[scene]},undefined,7000+shots.length,SEQUENCE_SHOT_LIMIT,true));return shots;};
const speakers=(shot:Shot)=>new Set(shot.dialogue.map(block=>block.character)).size;
const lines=(shots:Shot[])=>shots.flatMap(shot=>shot.dialogue.map(block=>block.character+": "+block.lines.join(" ")));

const SCRIPT="INT. WORKSHOP - DAY\n\nAda and Ben lean over a long bench covered in brass gears, springs and half-built clockwork birds while rain streams down the tall windows.\n\n"
  +"ADA\nHold it still.\n\nBen winds a tiny key and the bird twitches its tin wings.\n\nBEN\nIt's ticking.\n\nThe bird lifts off the bench and circles the lamp.\n\n"
  +"EXT. YARD - NIGHT\n\nThe gate swings.\n\nADA\nWho's there?\n\nBEN\nOnly the wind.\n\nADA\nThen why is it singing?\n";

describe("The Tide Clock",()=>{
  const parsed=parseFountain(readFileSync(resolve(import.meta.dir,"../../../docs/evidence/release-3/scripts/feature.fountain"),"utf8"));
  const old=before(parsed),shots=featureShots(parsed);
  test("puts each of its 46 lines on its own speaker's shot, with no shot added and fewer seconds billed",()=>{
    // Before: 27 shots carry all 46 lines, 16 of them two or three speakers.
    const was=old.filter(shot=>shot.dialogue.length);
    expect([old.length,was.length,lines(old).length,was.filter(shot=>speakers(shot)>1).length]).toEqual([202,27,46,16]);
    // After: 46 shots carry one line each, none of them two speakers.
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
  test("says who speaks on camera in each dialogue shot and changes nothing else",()=>{
    const marisol=shots.find(shot=>shot.dialogue.some(block=>block.character==="MARISOL"))!;
    expect(marisol.prompt).toContain(". MARISOL speaks on camera: face visible, mouth moving, framed for dialogue. ");
    for(const [index,shot]of shots.entries()){
      const was=old[index]!,heading=parsed.scenes[shot.sceneIndex]!.heading+". ";
      expect(shot.prompt).toBe(shot.dialogue.length?heading+speakingDirection(shot.dialogue)+" "+was.prompt.slice(heading.length):was.prompt);
    }
    expect(Math.max(...shots.map(shot=>speakingDirection(shot.dialogue).length))).toBeLessThanOrEqual(80);
  });
  test("is planned the same every time, and the sequence plan's counts are unchanged",()=>{
    expect(featureShots(parsed)).toEqual(shots);
    expect(sceneShotCounts(parsed)).toEqual(parsed.scenes.map(scene=>old.filter(shot=>shot.sceneIndex===scene.index).length));
  });
});

describe("placement",()=>{
  const parsed=parseFountain(SCRIPT);
  test("follows the action each speech comes after, one speech a shot",()=>{
    const shots=featureShots(parsed).filter(shot=>shot.sceneIndex===0);
    expect(shots.map(shot=>shot.dialogue.map(block=>block.character))).toEqual([[],["ADA"],["BEN"]]);
  });
  test("shares a shot only when the scene has fewer shots than speakers, and says both speak",()=>{
    const yard=featureShots(parsed).filter(shot=>shot.sceneIndex===1);
    expect(yard.length).toBe(1);
    expect(yard[0]!.dialogue.map(block=>block.character)).toEqual(["ADA","BEN","ADA"]);
    expect(yard[0]!.prompt).toBe("EXT. YARD - NIGHT. ADA and BEN speak on camera: faces visible, mouths moving, framed for dialogue. The gate swings.");
  });
  test("keeps one speaker's consecutive speeches together when there are more speeches than shots",()=>{
    const scene=parseFountain("INT. HALL - DAY\n\nA door.\n\nADA\nOne.\n\nADA\nTwo.\n\nBEN\nThree.\n\nA window.\n\nBEN\nFour.\n").scenes[0]!;
    const shots=sourcePlan({scenes:[scene],warnings:[],unparseable:[]} as unknown as ParseResult,undefined,7000,24,true);
    expect(placeSceneDialogue(scene,shots).map(shot=>shot.dialogue.map(block=>block.lines[0]))).toEqual([["One.","Two."],["Three.","Four."]]);
  });
  test("leaves a short as it was: every line of a scene on its first shot",()=>{
    const short=sourcePlan(parsed,undefined,7000,24);
    expect(short.map(shot=>shot.dialogue.length)).toEqual([2,0,0,3]);
    expect(short.some(shot=>shot.prompt.includes("speaks on camera")||shot.prompt.includes("speak on camera"))).toBe(false);
  });
});

describe("what a creator saved",()=>{
  const parsed=parseFountain(SCRIPT);
  test("an accepted scene cut keeps its own shots and lines",()=>{
    const cut=proposeSceneCut(parsed.scenes[0]!);
    const direction=directionSnapshot("project-1",1,[],0,[cut]);
    const shots=featureShots(parsed,direction).filter(shot=>shot.sceneIndex===0);
    expect(shots).toEqual(sourcePlan({...parsed,scenes:[parsed.scenes[0]!]},{...direction,sceneCuts:[cut]},7000,24,true));
    expect(shots.some(shot=>shot.prompt.includes("on camera"))).toBe(false);
  });
  test("a direction saved against the old placement keeps it, so the project renders as it did",()=>{
    const old=before(parsed),entry=directionEntry(old.find(shot=>shot.id==="shot-1-1")!,{size:"wide"});
    const direction=directionSnapshot("project-1",1,[entry],0);
    const shots=featureShots(parsed,direction);
    expect(shots.filter(shot=>shot.sceneIndex===0)).toEqual(old.filter(shot=>shot.sceneIndex===0));
    // Only the scene it holds: the yard has one shot and plans as placed either way.
    expect(shots.filter(shot=>shot.sceneIndex===1)).toEqual(featureShots(parsed).filter(shot=>shot.sceneIndex===1));
    expect(()=>directShots(filmPlan(parsed,direction,24,{number:1,of:1,firstScene:1,lastScene:2,planRevision:"a".repeat(64)}),direction)).not.toThrow();
  });
  test("a direction saved against the new placement keeps the new placement",()=>{
    const placed=featureShots(parsed),entry=directionEntry(placed.find(shot=>shot.id==="shot-1-2")!,{size:"close-up"});
    const direction=directionSnapshot("project-1",1,[entry],0);
    expect(featureShots(parsed,direction)).toEqual(placed);
    expect(directShots(featureShots(parsed,direction),direction).find(shot=>shot.id==="shot-1-2")!.prompt).toContain("ADA speaks on camera");
  });
});

describe("prompt fit",()=>{
  test("cuts the style bible, the shot direction and the action before the speaking direction, which it never cuts",()=>{
    const long="INT. WORKSHOP - DAY\n\n"+"Ada reaches across the cluttered bench past jars of springs and coils of wire. ".repeat(8)+"\n\nADA\nHold it still.\n";
    const parsed=parseFountain(long);
    const bible=styleBible({version:1,scriptVersion:1,source:"stand-in",characters:[],locations:[{name:"WORKSHOP",description:"A cluttered brick workshop with a skylight and a cast-iron stove."}],
      look:"Warm and tactile, with practical light and slow, observant camera moves that let scenes breathe.",palette:"Copper, brass and deep teal, with warm skin tones and inky shadows.",
      lighting:"Motivated window light by day; lamps and the stove's glow by night.",lens:"Wide to open a place, medium for action, close-ups for dialogue.",tone:"Curious and tender.",
      sound:"A ticking motif under the score; rain and kettles carry scenes."});
    const shot=bibleShots([applyShotDirection(featureShots(parsed)[0]!,{size:"close-up",keyLight:"Soft window light from screen left",soundIntent:"Rain on glass"})],parsed,bible)[0]!;
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
});
