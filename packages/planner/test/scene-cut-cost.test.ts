/**
 * HV-023-02 — a coverage edit scanned the scene once per beat it named.
 *
 * `sceneCut` checks that every beat a shot names belongs to the scene, and it checked it with
 * `shot.beatIds.some(id => !narrative.some(beat => beat.id === id))` — a walk of the whole scene per
 * id. `validateSource` permits 10,000 beats in a scene and the shot list permits 60 shots of 10,000
 * ids, and the route that reaches this takes its shots from the request body under a 250,000-byte
 * limit, which holds about 15,500 beat ids. The scene it checks them against is the server's own
 * parse of the screenplay, so the two numbers multiply.
 *
 * Measured on a 10,000-beat scene with a 248,401-byte body — inside the route's limit — carrying
 * 15,480 ids that name a real beat and do not cover the scene: **580 ms** to produce a 400. The api
 * bucket is 120 requests a minute, so one address was entitled to 69.6 s of blocked CPU per
 * 60-second window on a single-threaded server, from a route it is allowed to call. 30 ms after.
 *
 * The ordinary path was quadratic too, because a scene's coverage names each of its beats once:
 * 9.0 ms at 1,000 beats, 14.3 at 2,000, 39.2 at 4,000 and 160.0 at 8,000 — approaching fourfold per
 * doubling — against 5.9, 8.9, 17.0 and 32.5 after, which is the doubling itself.
 */
import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {coverageSettings} from "../src/coverage";
import {sceneCut,validateSceneCut,type CutShot,type CutSource} from "../src/scene-cuts";

const source=(beats:number):CutSource=>({sceneIndex:0,heading:"INT. ROOM - DAY",
  beats:Array.from({length:beats},(_,index)=>({id:`beat-1-${index+1}`,kind:"action" as const,text:"Marla crosses the room."}))});
/** Ordinary coverage: every beat carried exactly once, spread over the 60 shots a scene may hold. */
const cover=(beats:number):CutShot[]=>{
  const perShot=Math.max(1,Math.ceil(beats/60)),shots:CutShot[]=[];
  for(let at=0;at<beats;at+=perShot)shots.push({id:"shot-1-"+(10001+shots.length),
    beatIds:Array.from({length:Math.min(perShot,beats-at)},(_,k)=>`beat-1-${at+k+1}`),
    afterBeatId:null,coverage:coverageSettings({role:"master"}),durationFrames:null,notes:""});
  return shots;};
const ms=(work:()=>unknown):number=>{const started=Bun.nanoseconds();work();return (Bun.nanoseconds()-started)/1e6;};
const round=(value:number)=>Number(value.toFixed(1));

/** `count` beat ids, spread over the 60 shots a scene may hold, all naming the same beat. */
const naming=(count:number,beat:string):CutShot[]=>Array.from({length:60},(_,index)=>({id:"shot-1-"+(10001+index),
  beatIds:Array.from({length:Math.ceil(count/60)},()=>beat),afterBeatId:null,coverage:coverageSettings({role:"master"}),durationFrames:null,notes:""}));

test("checking a scene's coverage costs the ids, not the ids times the scene",()=>{
  // Two runs against the *same* 8,000-beat scene: sixty ids and six thousand. The scene's own
  // validation is in both, so the difference is the membership check and nothing else, and the
  // comparison is between two measurements on one machine rather than against a number.
  // Measured here: 7.8 ms and 9.9 ms after; 9.0 ms and 172.4 ms before, from the same scan that
  // walks 8,000 beats once per id. Both runs refuse, identically, after the check.
  const scene=source(8000);
  const cost=(ids:number)=>{const shots=naming(ids,"beat-1-8000");
    const run=()=>{try{sceneCut(scene,shots);return "";}catch(error){return (error as Error).message;}};
    expect({ids,message:run()}).toEqual({ids,message:expect.stringContaining("Cover every action and dialogue beat exactly once")});
    return Math.min(...[0,1,2].map(()=>ms(run)));};
  const few=cost(60),many=cost(6000);
  expect({membership:many<=few*3,few:round(few),many:round(many)}).toEqual({membership:true,few:round(few),many:round(many)});
});

test("and a body the route itself would accept is refused in a bounded time",()=>{
  // The attack, at the route's own limits: a 10,000-beat scene, 60 shots, and as many real beat ids
  // as 250,000 bytes of JSON holds. They name beats, so the membership check passes them all; they
  // do not cover the scene, so the request is a 400. What it cost was 580 ms of the event loop.
  const scene=source(10_000);
  const shots:CutShot[]=Array.from({length:60},(_,index)=>({id:"shot-1-"+(10001+index),
    // From the end of the scene: the scan ran front to back, so these were the dearest ids to check.
    beatIds:Array.from({length:258},()=>"beat-1-10000"),
    afterBeatId:null,coverage:coverageSettings({role:"master"}),durationFrames:null,notes:""}));
  const bytes=JSON.stringify({sceneIndex:0,maxShots:60,edits:{shots,notes:""}}).length;
  expect({insideTheRouteLimit:bytes<250_000,bytes}).toEqual({insideTheRouteLimit:true,bytes});
  expect(shots.reduce((total,shot)=>total+shot.beatIds.length,0)).toBeGreaterThan(15_000);
  let message="";
  const elapsed=ms(()=>{try{sceneCut(scene,shots);}catch(error){message=(error as Error).message;}});
  expect(message).toContain("Cover every action and dialogue beat exactly once");
  expect({bounded:elapsed<200,ms:round(elapsed)}).toEqual({bounded:true,ms:round(elapsed)});
});

test("and every refusal it made before it made quickly, it still makes",()=>{
  const scene=source(12),shots=cover(12);
  expect(validateSceneCut(sceneCut(scene,shots))).toEqual(sceneCut(scene,shots));
  const changed=(change:(shots:CutShot[])=>void)=>{const copy=structuredClone(shots);change(copy);return ()=>sceneCut(scene,copy);};
  // A beat id that is not this scene's, one that belongs to another scene's numbering, and one that
  // is not a string at all — the three things the membership check is for.
  expect(changed(s=>{s[0]!.beatIds[0]="beat-1-99";})).toThrow("Choose source beats from this scene.");
  expect(changed(s=>{s[0]!.beatIds[0]="beat-2-1";})).toThrow("Choose source beats from this scene.");
  expect(changed(s=>{(s[0]!.beatIds as unknown[])[0]=7;})).toThrow("Choose source beats from this scene.");
  // The shot id pattern is scene-numbered, and hoisting it must not have unhooked it from the scene.
  expect(changed(s=>{s[0]!.id="shot-2-10001";})).toThrow("distinct coverage shot IDs");
  expect(changed(s=>{s[0]!.id="shot-1-9999";})).toThrow("distinct coverage shot IDs");
  expect(changed(s=>{s[1]!.id=s[0]!.id;})).toThrow("distinct coverage shot IDs");
  // And the pattern still follows the scene it was built for: scene two's cut wants shot-2-*.
  const second:CutSource={sceneIndex:1,heading:"INT. HALL - NIGHT",
    beats:scene.beats.map((beat,index)=>({...beat,id:`beat-2-${index+1}`}))};
  const secondShots=shots.map(shot=>({...shot,id:shot.id.replace("shot-1-","shot-2-"),beatIds:shot.beatIds.map(id=>id.replace("beat-1-","beat-2-"))}));
  expect(()=>sceneCut(second,secondShots)).not.toThrow();
  expect(()=>sceneCut(second,secondShots.map(shot=>({...shot,id:shot.id.replace("shot-2-","shot-1-")})))).toThrow("distinct coverage shot IDs");
  // A transition beat is not narrative, so naming one is still naming a beat the shots may not carry.
  const withTransition={...scene,beats:[...scene.beats,{id:"beat-1-13",kind:"transition" as const,text:"CUT TO:"}]};
  expect(()=>sceneCut(withTransition,[{...shots[0]!,beatIds:[...shots[0]!.beatIds,"beat-1-13"]}])).toThrow("Choose source beats from this scene.");
});

test("and the scene-numbered pattern is built once, not once per shot",()=>{
  // The pattern depends on the scene, not the shot, and it was compiled inside the per-shot map.
  // Asserted over the source because a compiled regex leaves no trace in the answer.
  const source_=readFileSync(new URL("../src/scene-cuts.ts",import.meta.url),"utf8");
  // Comments stripped first: a guard that reads a comment about the defect passes when it returns.
  const text=source_.replace(/\/\*[\s\S]*?\*\//g,"").replace(/(^|[^:])\/\/[^\n]*/g,"$1");
  const compiled=[...text.matchAll(/new RegExp\(/g)];
  expect(compiled).toHaveLength(1);
  expect({beforeTheShotLoop:compiled[0]!.index!<text.indexOf("shots.map(")}).toEqual({beforeTheShotLoop:true});
  // And the membership check is a set rather than a scan.
  expect(text).toContain("beatIds.has(");
  expect(text).not.toContain("narrative.some(");
});
