import {expect,test} from "bun:test";
import {parseFountain} from "../../parser/src/index";
import {planShots} from "../src/index";
import {castingSnapshot,characterRecord} from "../src/casting";
import {directionEntry,directionSnapshot} from "../src/direction";
import {referenceLockRecord} from "../src/reference-lock";
import {continuityHeadingTime,continuityReport,continuityTimeFamily} from "../src/continuity";

const now=Date.UTC(2026,8,22);
const SCRIPT="INT. LIGHTHOUSE - DAY\n\nMarguerite winds the lamp.\n\nTomas climbs the stair.\n\nMarguerite watches the sea.\n\nMARGUERITE\nThe light has to hold.\n\nTOMAS\nIt will hold.\n\nEXT. CLIFF - NIGHT\n\nTomas walks the path.";
const parsed=parseFountain(SCRIPT),shots=planShots(parsed,7000,24);
const asset=(seed:string)=>({schema:"hv-reference/1" as const,id:"11111111-2222-4333-8444-"+seed.repeat(12).slice(0,12),projectId:"project-1",
  sha256:seed.repeat(64).slice(0,64),originalSha256:"b".repeat(64),bytes:4096,width:512,height:512,contentType:"image/png" as const,
  createdAt:new Date(now).toISOString(),attestedAt:new Date(now).toISOString()});
const permission={status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()};
const actor=(name:string,extra:Record<string,unknown>)=>characterRecord({name,aliases:[],kind:"original-fictional",appearance:"A keeper of the light.",
  ageRange:"adult",ethnicity:"",body:"",hairMakeup:"",expressions:"",movement:"",relationships:"",arcNotes:"",prohibitedChanges:"",wardrobe:[],sceneBindings:[],permission,...extra},
  name==="MARGUERITE"?"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa":"bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",now,true);
/** MARGUERITE is fully declared; TOMAS has neither wardrobe nor a retained reference. */
const cast=castingSnapshot("project-1",1,[
  actor("MARGUERITE",{wardrobe:[{sceneNumber:null,description:"An oilskin coat"}],prohibitedChanges:"The coat stays",references:[asset("c")]}),
  actor("TOMAS",{}),
],now);
const anchor={frames:[{at:0,asset:asset("d")}],fallback:"stop" as const};

test("a packet carries the scene's characters, the wardrobe that resolves for it, and the look the shot declares",()=>{
  const direction=directionSnapshot("project-1",1,[
    directionEntry(shots[0]!,{timeOfDay:"day",keyLight:"The lamp above"}),
    directionEntry(shots[1]!,{timeOfDay:"day",keyLight:"The lamp above",frameAnchors:anchor}),
  ],now);
  const report=continuityReport(shots,cast,direction,parsed);
  expect(report.schema).toBe("hv-continuity/1");expect(report.rulesVersion).toBe(1);
  expect(report.castingRevision).toBe(cast.revision);expect(report.directionRevision).toBe(direction.revision);
  const scene=report.scenes[0]!,first=scene.packets[0]!;
  expect([scene.sceneIndex,scene.sceneNumber,scene.heading,report.scenes[0]!.packets.length]).toEqual([0,1,"INT. LIGHTHOUSE - DAY",3]);
  expect(first.headingTime).toBe("day");expect(report.scenes[1]!.packets[0]!.headingTime).toBe("night");
  // The cast state belongs to the scene, not to each of its shots: it is the same for all of them,
  // and repeating it per shot put megabytes of duplicate cast text in every direction load.
  expect(scene.characters).toEqual([
    {characterId:cast.characters[0]!.id,name:"MARGUERITE",wardrobe:"An oilskin coat",wardrobeScope:"default",preserve:"The coat stays",references:1,referencesLocked:false},
    {characterId:cast.characters[1]!.id,name:"TOMAS",wardrobe:"",wardrobeScope:"unstated",preserve:"",references:0,referencesLocked:false},
  ]);
  expect(Object.hasOwn(first,"characters")).toBe(false);
  expect(first.look).toEqual({timeOfDay:"day",keyLight:"The lamp above",fillLight:"",backLight:"",motivatedSources:""});
  // The last approved frame is carried only where the shot declares it.
  expect(first.handoff).toBeNull();expect(scene.packets[1]!.handoff).toEqual({at:0,sha256:asset("d").sha256});
  expect(scene.packets[2]!.look.timeOfDay).toBe("");
  // The same three inputs make the same report, down to its revision; a changed declaration moves it.
  expect(continuityReport(shots,cast,direction,parsed)).toEqual(report);
  const moved=directionSnapshot("project-1",2,[directionEntry(shots[0]!,{timeOfDay:"day",keyLight:"The lamp behind"})],now);
  expect(continuityReport(shots,cast,moved,parsed).revision).not.toBe(report.revision);
});

test("a contradiction between two declarations is a warning and a missing declaration is an unknown",()=>{
  const direction=directionSnapshot("project-1",1,[
    directionEntry(shots[0]!,{timeOfDay:"Day",keyLight:"Lamp above"}),
    directionEntry(shots[1]!,{timeOfDay:"night",keyLight:"Moon through glass"}),
  ],now);
  const report=continuityReport(shots,cast,direction,parsed),scene=report.scenes[0]!;
  const finding=(code:string)=>scene.findings.find(value=>value.code===code);
  expect(finding("look-changed")!.severity).toBe("warning");
  const looks=scene.findings.filter(value=>value.code==="look-changed");
  expect(looks).toHaveLength(2);
  for(const value of looks)expect(value.shotIds).toEqual(["shot-1-1","shot-1-2"]);
  expect(looks.some(value=>value.message.includes("time of day")&&value.message.includes("“Day”")&&value.message.includes("“night”"))).toBe(true);
  expect(looks.some(value=>value.message.includes("key light"))).toBe(true);
  expect(finding("time-contradicts-heading")).toMatchObject({severity:"warning",shotIds:["shot-1-2"]});
  expect(finding("time-contradicts-heading")!.message).toContain("heading reads day");
  expect(finding("wardrobe-unstated")).toMatchObject({severity:"unknown",shotIds:["shot-1-1","shot-1-2","shot-1-3"]});
  expect(finding("wardrobe-unstated")!.message).toContain("TOMAS");expect(finding("wardrobe-unstated")!.message).not.toContain("MARGUERITE");
  expect(finding("identity-unanchored")).toMatchObject({severity:"unknown"});
  expect(finding("identity-unanchored")!.message).toContain("TOMAS");expect(finding("identity-unanchored")!.message).not.toContain("MARGUERITE");
  expect(finding("handoff-absent")).toMatchObject({severity:"note",shotIds:["shot-1-2","shot-1-3"]});
  // Warnings first, then what could not be checked, then advice.
  expect(scene.findings.map(value=>value.severity)).toEqual(["warning","warning","warning","unknown","unknown","note"]);
  expect(report.totals).toMatchObject({warnings:3,unknowns:4,notes:1,lookComparisons:4});
  expect(report.scenes[1]!.findings.map(value=>value.code).sort()).toEqual(["identity-unanchored","wardrobe-unstated"]);
});

test("a consistent scene reports no warnings, and a film that declares nothing reports no comparisons either",()=>{
  const direction=directionSnapshot("project-1",1,shots.map((shot,index)=>directionEntry(shot,{timeOfDay:shot.sceneIndex?"night":"day",
    keyLight:"The lamp above",...(index?{frameAnchors:anchor}:{})})),now);
  const full=castingSnapshot("project-1",2,[cast.characters[0]!,{...cast.characters[1]!,wardrobe:[{sceneNumber:null,description:"A wet jumper"}],references:[asset("e")]}],now);
  const report=continuityReport(shots,full,direction,parsed);
  expect(report.totals.warnings).toBe(0);expect(report.totals.unknowns).toBe(0);expect(report.totals.notes).toBe(0);
  expect(report.totals.lookComparisons).toBeGreaterThan(0);expect(report.totals.wardrobeComparisons).toBe(3);
  // Each scene is directed to its own heading, so the cliff at night contradicts nothing.
  expect(report.scenes[1]!.findings).toEqual([]);expect(report.scenes[1]!.lookComparisons).toBe(1);
  const empty=continuityReport(shots,castingSnapshot("project-1",0,[],now),directionSnapshot("project-1",0,[],now),parsed);
  expect(empty.totals).toMatchObject({warnings:0,unknowns:0,lookComparisons:0,wardrobeComparisons:0});
  expect(empty.scenes[0]!.characters).toEqual([]);
  expect(empty.scenes[0]!.packets.every(packet=>!packet.look.timeOfDay&&!packet.handoff)).toBe(true);
});

test("a saved direction whose source changed is reported and never compared",()=>{
  const direction=directionSnapshot("project-1",1,[
    directionEntry(shots[0]!,{timeOfDay:"day",keyLight:"Lamp above"}),
    directionEntry(shots[1]!,{timeOfDay:"night",keyLight:"Moon through glass"}),
  ],now);
  const changedParse=parseFountain(SCRIPT.replace("winds the lamp","winds the great lamp")),changed=planShots(changedParse,7000,24);
  const report=continuityReport(changed,cast,direction,changedParse),scene=report.scenes[0]!;
  expect(report.staleShotIds).toEqual(["shot-1-1"]);
  expect(scene.findings.find(value=>value.code==="source-stale")).toMatchObject({severity:"unknown",shotIds:["shot-1-1"]});
  // Its look is out of every comparison, so the scene's one remaining declaration conflicts with nothing.
  expect(scene.findings.some(value=>value.code==="look-changed")).toBe(false);
  expect(scene.lookComparisons).toBe(1);
  // A stale shot is named by the scene's shotIds and by staleShotIds, and gets no packet at all:
  // there is nothing to compare a changed shot's saved direction against.
  expect(scene.shotIds).toContain("shot-1-1");
  expect(scene.packets.some(packet=>packet.shotId==="shot-1-1")).toBe(false);
  expect(continuityReport(changed.slice(3),cast,direction,changedParse).scenes.find(value=>value.sceneIndex===0)!.findings.filter(value=>value.code==="source-stale")).toHaveLength(2);
});

test("a heading's own time is read conservatively, and a location that merely contains a time word is not one",()=>{
  for(const [heading,family] of [["INT. LIGHTHOUSE - DAY","day"],["EXT. CLIFF - NIGHT","night"],["INT. HALL - DAY - CONTINUOUS","day"],
    ["INT. DAYCARE - NIGHT","night"],["INT. HALL - LATER",null],["INT. HALL",null],["INT. HALL - DAY OR NIGHT",null],["EXT. MIDNIGHT DINER - DAY","day"]] as const)
    expect({heading,family:continuityHeadingTime(heading)}).toEqual({heading,family});
  for(const [value,family] of [["morning","day"],["Late afternoon","day"],["midnight","night"],["dusk",null],["magic hour",null],["",null],["daycare",null]] as const)
    expect({value,family:continuityTimeFamily(value)}).toEqual({value,family});
});

/**
 * HV-021-03: a character's locked look is a chosen subset of the images they retain, and it is what
 * the render is conditioned on. The packet counted the whole retained set, so a character locked to
 * two of four images was reported as anchored by four — a continuity report claiming more anchoring
 * than the film will actually have.
 */
test("a character's reference count is what the render uses, not what they retain",()=>{
  const references=[asset("c"),asset("e"),asset("f"),asset("1")];
  const locked=castingSnapshot("project-1",1,[
    actor("MARGUERITE",{wardrobe:[{sceneNumber:null,description:"An oilskin coat"}],references,
      referenceLock:referenceLockRecord({assetIds:[references[0]!.id,references[2]!.id],label:"Act one",note:""},references,now)}),
    actor("TOMAS",{references:[]}),
  ],now);
  const scene=continuityReport(shots,locked,directionSnapshot("project-1",1,[],now),parsed).scenes[0]!;
  expect(scene.characters[0]).toMatchObject({name:"MARGUERITE",references:2,referencesLocked:true});
  expect(scene.characters[1]).toMatchObject({name:"TOMAS",references:0,referencesLocked:false});
  // The unanchored finding reads the same set, so the count and the finding cannot disagree.
  expect(scene.findings.find(finding=>finding.code==="identity-unanchored")!.message).toContain("TOMAS");
  expect(scene.findings.find(finding=>finding.code==="identity-unanchored")!.message).not.toContain("MARGUERITE");
});

/**
 * HV-021-03: the cast state is the scene's, so a report's size follows its scenes and its findings
 * rather than its shot count. It used to follow the shot count — every packet carried the whole
 * scene's cast — and a 60-shot film with a fully written cast put 1.7 MB into every `GET /direction`.
 */
test("the report does not repeat the cast once per shot",()=>{
  const SCENES=10,CHARACTERS=12,fill=(n:number)=>"x".repeat(n);
  const names=Array.from({length:CHARACTERS},(_,index)=>"PLAYER "+String.fromCodePoint(65+index));
  const wide=Array.from({length:SCENES},(_,index)=>"INT. ROOM "+(index+1)+" - DAY\n\n"+names.join(" and ")+" wait.\n\n"
    +Array.from({length:8},(_,take)=>"Someone moves, take "+take+".").join("\n\n")).join("\n\n");
  const parse=parseFountain(wide);
  const people=castingSnapshot("project-1",1,names.map((name,index)=>characterRecord({name,aliases:[],kind:"original-fictional",
    appearance:fill(1000),ageRange:"adult",ethnicity:"",body:fill(240),hairMakeup:fill(400),expressions:fill(400),movement:fill(400),
    relationships:fill(600),arcNotes:fill(600),prohibitedChanges:fill(600),wardrobe:[{sceneNumber:null,description:fill(400)}],
    sceneBindings:[],permission},"cccccccc-3333-4333-8333-"+String(index).padStart(12,"0"),now,true)),now);
  const size=(maxShots:number)=>{
    const planned=planShots(parse,60000,maxShots);
    const direction=directionSnapshot("project-1",1,planned.map(shot=>directionEntry(shot,{timeOfDay:"day",keyLight:"Overhead"})),now);
    return {shots:planned.length,bytes:JSON.stringify(continuityReport(planned,people,direction,parse)).length};
  };
  const few=size(10),many=size(60);
  expect(many.shots).toBeGreaterThan(few.shots*3);
  // What six times the shots adds is the shots' own packets, not the cast again.
  expect(many.bytes-few.bytes).toBeLessThan(40_000);
  expect(many.bytes).toBeLessThan(250_000);
});
