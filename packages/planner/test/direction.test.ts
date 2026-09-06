import {expect,test} from "bun:test";
import {parseFountain} from "../../parser/src/index";
import {planShots} from "../src/index";
import {DEFAULT_DIRECTION,currentDirection,directionEntry,directionMatches,directionSettings,directionSnapshot,directShots,staleDirections,validateDirection} from "../src/direction";
import {ProjectService} from "../../api/src/index";
const SCRIPT="EXT. GARDEN - DAY\n\nA gate swings open.\n\nA small cart rolls past.\n\nSPUD\nWelcome home.\n\nINT. HALL - NIGHT\n\nA lantern glows.";
test("shot directions validate physical ranges, enums, fixed frame counts and hashed saved sources",()=>{
  const shots=planShots(parseFountain(SCRIPT),7000,24),entry=directionEntry(shots[0]!,{size:"close-up",durationFrames:121,lensMm:85,keyLight:"  Soft window light  ",previewMove:"pan-left"});
  const snapshot=directionSnapshot("project-1",1,[entry]);expect(validateDirection(snapshot,"project-1")).toEqual(snapshot);expect(snapshot.entries[0]!.settings.keyLight).toBe("Soft window light");
  for(const value of [{durationFrames:29},{durationFrames:901},{durationFrames:120.1},{lensMm:7},{heightM:-1},{temperatureK:999},{contrastRatio:0},{previewMove:"drone"},{size:"invented"},{performance:"x".repeat(601)},{blocking:"\u0000"},{providerSecret:"x"}])expect(()=>directionSettings(value)).toThrow();
  const changed=structuredClone(snapshot);changed.entries[0]!.settings.lensMm=35;expect(()=>validateDirection(changed,"project-1")).toThrow("changed");
  const source=structuredClone(snapshot);source.entries[0]!.source.prompt="Another scene";expect(()=>validateDirection(source,"project-1")).toThrow("source changed");
  expect(()=>validateDirection(snapshot,"project-2")).toThrow();expect(()=>directionSnapshot("project-1",2,[entry,entry])).toThrow("one direction");
  expect(directionMatches(undefined,currentDirection("project-1"))).toBe(true);expect(directionMatches(undefined,snapshot)).toBe(false);
});
test("direction follows only its exact source, keeps caption text clean and refuses changed grouping or removed shots",()=>{
  const shots=planShots(parseFountain(SCRIPT),7000,24),snapshot=directionSnapshot("project-1",1,[directionEntry(shots[0]!,{durationFrames:121,size:"close-up",movement:"dolly",previewMove:"push-in",performance:"Wait, then smile."})]);
  const directed=directShots(shots,snapshot);expect(directed[0]!.durationSec).toBe(121/30);expect(directed[0]!.sourcePrompt).toBe(shots[0]!.prompt);expect(directed[0]!.prompt).toContain("Camera movement intent: dolly");expect(directed[1]).toEqual(shots[1]);
  for(const script of [SCRIPT.replace("gate swings","door swings"),SCRIPT.replace("Welcome home.","Goodbye."),SCRIPT.replace("EXT. GARDEN - DAY","EXT. GARDEN - NIGHT")])expect(()=>directShots(planShots(parseFountain(script),7000,24),snapshot)).toThrow("changed");
  expect(staleDirections(planShots(parseFountain(SCRIPT),7000,2),snapshot)).toHaveLength(1);
  expect(staleDirections(shots.slice(1),snapshot)).toHaveLength(1);
  expect(directShots(planShots(parseFountain(SCRIPT.replace("lantern glows","lantern dims")),7000,24),snapshot)[0]).toEqual(directed[0]);
  expect(()=>directShots(shots,directionSnapshot("project-1",2,[directionEntry(shots[0]!,{soundIntent:"clone the voice of a real celebrity"})]))).toThrow("content policy");
});
test("direction saves require current screenplay, source and direction versions; restore preserves sources without silently rebinding",()=>{
  process.env.HV_TOKEN_SECRET="direction-domain-fixture-secret-at-least-thirty-two-characters";const service=new ProjectService(),owner=service.createAnonymousProject();service.editScript(owner.token,SCRIPT);
  const shot=planShots(parseFountain(SCRIPT),7000,24)[0]!,entry=directionEntry(shot,DEFAULT_DIRECTION);
  const saved=service.saveShotDirection(owner.token,shot.id,{lensMm:50},0,1,entry.sourceHash)!;expect(saved.version).toBe(1);
  expect(()=>service.saveShotDirection(owner.token,shot.id,{},0,1,entry.sourceHash)).toThrow("directions changed");expect(()=>service.saveShotDirection(owner.token,shot.id,{},1,2,entry.sourceHash)).toThrow("screenplay changed");
  expect(()=>service.saveShotDirection(owner.token,shot.id,{},1,1,"wrong")).toThrow("source shot changed");
  const reloaded=ProjectService.fromState(service.snapshot());expect(currentDirection(owner.projectId,reloaded.authorize(owner.token)!.directionHistory)).toEqual(saved);
  service.editScript(owner.token,SCRIPT.replace("gate swings","door swings"));const removed=service.removeShotDirection(owner.token,shot.id,1)!;expect(removed.entries).toEqual([]);
  const restored=service.restoreDirection(owner.token,1,2)!;expect(restored.version).toBe(3);expect(staleDirections(planShots(parseFountain(service.authorize(owner.token)!.versions.latest()!.text),7000,24),restored)).toHaveLength(1);
  expect(service.recordAnimaticDecision(owner.projectId,crypto.randomUUID(),2,"approved","",Date.now(),undefined,saved)).toBeNull();
  const currentShot=planShots(parseFountain(service.authorize(owner.token)!.versions.latest()!.text),7000,24)[0]!,fresh=directionEntry(currentShot,{lensMm:50});
  expect(service.saveShotDirection(owner.token,currentShot.id,fresh.settings,3,2,fresh.sourceHash)!.version).toBe(4);
});
