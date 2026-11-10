/**
 * HV-021-12 — the stand-in crew dresses each character in what the script says they wear, and the continuity
 * report stops counting its old placeholder as a wardrobe.
 *
 * "The Tide Clock" was reviewed with "Character has different colored pants" (sequence 1) and "Actor has a hat
 * in one scene and no hat in the next" (sequence 5). Its crew plan ran on the stand-in, which gave all five
 * characters the wardrobe "Everyday clothes that suit the scene." -- the line fal received for every shot
 * (packages/queue/test/fixtures/fal-received-shot9.txt) -- so every shot was told to choose the clothes. The
 * script had dressed them: WREN in a mustard scarf and a leather apron, DEV in a blue knitted cap, HOLLIS in a
 * grey suit with a chain of office, and MARISOL, in the sentence after her introduction, in a yellow oilskin
 * and a captain's cap, which reached no prompt at all. The continuity report said nothing contradicts itself
 * and raised no wardrobe finding, because the placeholder counted as stated.
 */
import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {parseFountain} from "../../parser/src/index";
import {planShots} from "../src/index";
import {castingSnapshot,characterRecord,describeCharacter} from "../src/casting";
import {directionSnapshot} from "../src/direction";
import {continuityReport,PLACEHOLDER_WARDROBE} from "../src/continuity";
import {GARMENTS,introductionWardrobe,scriptIntroductions} from "../src/crew/introductions";
import {standInCast,standInPlan} from "../src/crew/production-plan";
import {readThroughFacts} from "../src/crew/read-through";
import {continuitySupervisorNotes} from "../src/crew/continuity-supervisor";

const TIDE_CLOCK=readFileSync(resolve(import.meta.dir,"../../../docs/evidence/release-3/scripts/feature.fountain"),"utf8");
const wardrobeOf=(script:string,names:string[])=>{
  const parsed=parseFountain(script);
  return Object.fromEntries(scriptIntroductions(parsed,names).map(intro=>[intro.name,introductionWardrobe(parsed,intro,names)]));
};

test("The Tide Clock's cast is dressed as its script dresses them, and nobody is given clothes it does not state",()=>{
  const parsed=parseFountain(TIDE_CLOCK),facts=readThroughFacts(TIDE_CLOCK,parsed,{format:"feature",tone:""});
  const cast=Object.fromEntries(standInCast(parsed,facts.characters).map(entry=>[entry.name,entry.wardrobe]));
  expect(cast).toEqual({
    WREN:"A mustard scarf and a leather apron.",
    OSWIN:"",
    DEV:"A blue knitted cap.",
    MARISOL:"A yellow oilskin and a captain's cap.",
    HOLLIS:"A grey suit with a chain of office.",
  });
  expect(Object.values(cast)).not.toContain(PLACEHOLDER_WARDROBE);
});

test("a costume is read from the introduction's own phrases or the next sentence about that character, and only when it names a garment",()=>{
  const one=(action:string,names=["NORA"])=>wardrobeOf("INT. KITCHEN - DAY\n\n"+action+"\n\nNORA\nHello.\n",names).NORA;
  expect(one("NORA, a cook in a white apron, stirs the pot.")).toBe("A white apron.");
  expect(one("NORA, sixty, in a red raincoat and wellies, stirs the pot.")).toBe("A red raincoat and wellies.");
  expect(one("NORA stirs the pot, wearing a blue cardigan.")).toBe("A blue cardigan.");
  expect(one("NORA, an old woman, stirs the pot. She wears a striped jumper and a beret.")).toBe("A striped jumper and a beret.");
  expect(one("NORA stirs the pot. Nora is dressed in her late husband's coat.")).toBe("Her late husband's coat.");
  expect(one("NORA, a cook, wears a red coat.")).toBe("A red coat.");
  // The forms a costume often takes: last, after an age, with no article, or as a list.
  expect(one("NORA, in a red coat.")).toBe("A red coat.");
  expect(one("NORA (60s), in a red coat, stirs the pot.")).toBe("A red coat.");
  expect(one("NORA, in jeans and a hoodie, stirs.")).toBe("Jeans and a hoodie.");
  expect(one("NORA wears jeans and a hoodie.")).toBe("Jeans and a hoodie.");
  expect(one("NORA, in overalls, stirs.")).toBe("Overalls.");
  expect(one("NORA wears a coat, a hat and boots.")).toBe("A coat, a hat and boots.");
  expect(one("NORA, in a red coat, a blue scarf and boots, stands.")).toBe("A red coat, a blue scarf and boots.");
  // The costume ends where the action begins.
  expect(one("NORA wears a red coat and stirs the pot.")).toBe("A red coat.");
  expect(one("NORA, an old woman, stirs the pot. She wears a yellow oilskin and carries a lantern.")).toBe("A yellow oilskin.");
  expect(one("NORA, in a red coat and carrying a shotgun, enters.")).toBe("A red coat.");
  expect(one("NORA wears a red coat -- soaked through.")).toBe("A red coat.");
  // Not costumes: no garment, or a garment that isn't what the phrase is about.
  for(const action of ["NORA, a nurse in a hurry, runs in.","NORA, a cook in the kitchen, stirs the pot.","NORA, an old woman, stirs the pot. She wears a smile.",
    "NORA, hands in the pockets of her coat, waits.","NORA, hands in her coat pockets, waits.","NORA, a knife in her boot, enters.","NORA, hiding in the coat closet, listens.",
    "NORA, a clerk in a hat shop, sighs.","NORA, an actress in a dress rehearsal, sighs.","NORA, curled in the boot of a car, wakes.",
    "NORA, an old woman, waits. She wears the trousers in this house.","NORA stirs the pot."])expect(one(action)).toBeNull();
  // Not hers: clothes in a part about someone else, and a pronoun that may be someone else's.
  for(const [action,names] of [["NORA stirs the pot. She watches TOM, who wears a cap.",["NORA","TOM"]],["NORA stirs the pot. TOM wears a cap.",["NORA","TOM"]],
    ["NORA, a cook, watches TOM, a porter in a red cap, enter.",["NORA","TOM"]],["NORA, a cook, and TOM, a porter in a red cap, stand.",["NORA","TOM"]],
    ["NORA watches TOM, who wears a blue cap.",["NORA","TOM"]],["NORA watches a stranger wearing a red hat.",["NORA"]],
    ["NORA, a cook, helps a child in a blue coat, then sits.",["NORA"]],["NORA's brother wears a green coat.",["NORA"]],
    ["NORA sees a stranger. He wears a long coat.",["NORA"]],["A man looks at NORA. He wears a cap.",["NORA"]],
    ["NORA, an old woman, watches a girl climb. She wears a red coat.",["NORA"]],["NORA enters. Nora's brother wears a green cap.",["NORA"]],
    ["NORA stirs the pot. She wears a striped jumper.",["NORA"]]] as const)expect(one(action,[...names])).toBeNull();
  // ANN is not the end of MARY-ANN.
  expect(wardrobeOf("INT. HALL - DAY\n\nMARY-ANN, in a red coat, waits. ANN, in a blue hat, waits.\n\nANN\nHello.\n",["MARY-ANN","ANN"]).ANN).toBe("A blue hat.");
  expect(GARMENTS.has("smile")).toBe(false);
});

test("the stand-in's wardrobe becomes the character's project default, and every prompt carries it",()=>{
  const script="EXT. QUAY - DAY\n\nNORA, a pilot in a yellow oilskin, coils a rope.\n\nNORA\nTide's turning.\n\nINT. CABIN - NIGHT\n\nNora lights the stove.\n";
  const parsed=parseFountain(script),facts=readThroughFacts(script,parsed,{format:"reel",tone:""}),shots=planShots(parsed,11,24);
  const plan=standInPlan(parsed,facts,shots);
  expect(plan.cast.map(entry=>entry.wardrobe)).toEqual(["A yellow oilskin."]);
  const now=Date.UTC(2026,10,10),permission={status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()};
  const nora=characterRecord({name:"NORA",aliases:[],kind:"original-fictional",appearance:plan.cast[0]!.appearance,ageRange:plan.cast[0]!.ageRange,ethnicity:"",body:"",hairMakeup:"",
    expressions:"",movement:"",relationships:"",arcNotes:"",prohibitedChanges:"",wardrobe:[{sceneNumber:null,description:plan.cast[0]!.wardrobe}],sceneBindings:[],permission},
    "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",now,true);
  for(const scene of [1,2])expect(describeCharacter(nora,scene)).toContain("Wardrobe: A yellow oilskin.");
});

test("the old placeholder is reported as no wardrobe, in its own words, and is not counted as a comparison",()=>{
  const now=Date.UTC(2026,10,10),script="INT. WORKSHOP - DAY\n\nWren files a gear.\n\nOswin watches.\n\nWREN\nNearly.\n\nOSWIN\nNearly.\n";
  const parsed=parseFountain(script),shots=planShots(parsed,5,24);
  const permission={status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()};
  const actor=(name:string,id:string,wardrobe:{sceneNumber:number|null;description:string}[])=>characterRecord({name,aliases:[],kind:"original-fictional",appearance:"A clockmaker.",
    ageRange:"adult",ethnicity:"",body:"",hairMakeup:"",expressions:"",movement:"",relationships:"",arcNotes:"",prohibitedChanges:"",wardrobe,sceneBindings:[],permission},id,now,true);
  const report=(wardrobe:{sceneNumber:number|null;description:string}[])=>continuityReport(shots,castingSnapshot("project-1",1,[
    actor("WREN","aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",wardrobe),actor("OSWIN","bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",[{sceneNumber:null,description:"A brown waistcoat."}])],now),
    directionSnapshot("project-1",1,[],now),parsed);
  for(const description of [PLACEHOLDER_WARDROBE,"everyday clothes that suit the scene"]){
    const placeholder=report([{sceneNumber:null,description}]),scene=placeholder.scenes[0]!;
    const finding=scene.findings.find(value=>value.code==="wardrobe-unstated")!;
    expect(finding.message).toBe("The wardrobe for WREN is the crew's placeholder, “"+PLACEHOLDER_WARDROBE+"”, which names no clothes and lets every shot choose its own, so nothing is held constant across its shots. State what they wear.");
    expect(scene.wardrobeComparisons).toBe(1);
    expect(continuitySupervisorNotes(placeholder).some(note=>note.change.startsWith("No wardrobe is stated for WREN"))).toBe(true);
  }
  // A real wardrobe is compared and raises nothing; none at all keeps its own sentence.
  const stated=report([{sceneNumber:null,description:"A mustard scarf and a leather apron."}]).scenes[0]!;
  expect([stated.findings.some(value=>value.code==="wardrobe-unstated"),stated.wardrobeComparisons]).toEqual([false,2]);
  const none=report([]).scenes[0]!.findings.find(value=>value.code==="wardrobe-unstated")!;
  expect(none.message).toBe("No wardrobe is stated for WREN in this scene, and no default is set, so nothing is held constant across its shots.");
});
