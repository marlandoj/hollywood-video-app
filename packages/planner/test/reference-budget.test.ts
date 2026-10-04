/**
 * HV-019-17 — a shot's reference budget (G22-202610041528: at most four reference images a shot; two
 * each when two locked characters share one). The rule is in packages/planner/src/reference-budget.ts;
 * the end-to-end proof on the live-film-referenced profile is packages/api/test/referenced-profile.test.ts.
 */
import {describe,expect,test} from "bun:test";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {parseFountain} from "../../parser/src/index";
import {describeProvider} from "../../generator/src/catalog";
import {castingSnapshot,castProminence,characterRecord,directCast} from "../src/casting";
import {referenceLockRecord} from "../src/reference-lock";
import {filmPlan} from "../src/sequences";
import {IdentityLockError,shotIdentityLocks} from "../src/identity-locks";
import {allocateReferences,assertBudgetMatchesRecord,poolReferenceBudget,REFERENCE_BUDGET_SCHEMA} from "../src/reference-budget";

const now=Date.UTC(2026,9,4);
const image=(seed:string)=>({schema:"hv-reference/1" as const,id:"11111111-2222-4333-8444-"+seed.repeat(12).slice(0,12),projectId:"project-1",
  sha256:seed.repeat(64).slice(0,64),originalSha256:"b".repeat(64),bytes:4096,width:512,height:512,contentType:"image/png" as const,
  createdAt:new Date(now).toISOString(),attestedAt:new Date(now).toISOString()});
const permitted={status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()};
/** Four views a character, as a turnaround sheet makes them (front, side, back, three-quarter), locked in that order unless `unlocked`. */
const views=(prefix:string)=>["1","2","3","4"].map(n=>image(prefix+n));
const NAMES=["ADA","BEN","CY","DEE","EVE"] as const;
const IDS=Object.fromEntries(NAMES.map((name,index)=>[name,"aaaaaaaa-1111-4111-8111-"+String(index+1).repeat(12)])) as Record<typeof NAMES[number],string>;
const IMAGES=Object.fromEntries(NAMES.map((name,index)=>[name,views("abcde"[index]!)])) as Record<typeof NAMES[number],ReturnType<typeof image>[]>;
const character=(name:typeof NAMES[number],options:{unlocked?:boolean;images?:number}={})=>{const references=IMAGES[name].slice(0,options.images??4);
  return characterRecord({...CAST_INPUT,name,aliases:[],permission:permitted,sceneBindings:[],references,
    ...(options.unlocked?{}:{referenceLock:referenceLockRecord({assetIds:references.map(asset=>asset.id),label:name+" turnaround",note:""},references,now)})},IDS[name],now,true);};
const digests=(assets:{id:string;sha256:string}[])=>assets.map(asset=>({id:asset.id,sha256:asset.sha256}));

/** The four profile pools' entries, as the catalogue describes them. */
const pool=(stage:"animatic"|"final",specs:string[])=>specs.map(spec=>describeProvider(spec,stage,{}));

describe("the budget is the pool's largest reference count",()=>{
  test("four on the referenced profile's stills and finals; none where no provider takes a reference",()=>{
    expect(poolReferenceBudget(pool("animatic",["image:fal:flux-2-edit","image:fal:flux-schnell"]))).toBe(4);
    expect(poolReferenceBudget(pool("final",["fal:kling-o3-standard-reference","fal:kling-v2.5-turbo-pro"]))).toBe(4);
    // Text-only pools have no budget: a shot's images are never cut to fit a provider that takes none.
    expect(poolReferenceBudget(pool("animatic",["image:fal:flux-schnell"]))).toBeNull();
    expect(poolReferenceBudget(pool("final",["fal:kling-v2.5-turbo-pro"]))).toBeNull();
    expect(poolReferenceBudget([])).toBeNull();
    expect(poolReferenceBudget(undefined)).toBeNull();
    // Provider-max driven: HV-019-16's mock declares 32, so the mock profile's eight-image shots are not cut,
    // and a pool mixing the mock with a reference vendor takes the larger.
    expect(poolReferenceBudget([{snapshot:{input:{referenceFrames:0}}},{snapshot:{input:{referenceFrames:32}}}])).toBe(32);
    expect(poolReferenceBudget(pool("final",["mock"]))).toBe(32);
    expect(poolReferenceBudget(pool("animatic",["mock"]))).toBe(32);
    expect(poolReferenceBudget(pool("final",["fal:kling-o3-standard-reference","mock"]))).toBe(32);
  });
});

describe("allocating a budget",()=>{
  const candidate=(name:typeof NAMES[number],count=4)=>({id:IDS[name],name,locked:true,views:IMAGES[name].slice(0,count)});
  test("one character keeps up to four views, and a shot within budget has no record",()=>{
    const {kept,record}=allocateReferences([candidate("ADA")],4);
    expect([kept.get(IDS.ADA),record]).toEqual([4,null]);
    expect(allocateReferences([candidate("ADA"),candidate("BEN")],null).record).toBeNull();
  });
  test("two characters get two each, the front of each one's order",()=>{
    const {kept,record}=allocateReferences([candidate("ADA"),candidate("BEN")],4);
    expect([kept.get(IDS.ADA),kept.get(IDS.BEN)]).toEqual([2,2]);
    expect(record).toEqual({schema:REFERENCE_BUDGET_SCHEMA,max:4,carried:8,characters:[
      {characterId:IDS.ADA,name:"ADA",locked:true,sent:digests(IMAGES.ADA.slice(0,2)),dropped:digests(IMAGES.ADA.slice(2))},
      {characterId:IDS.BEN,name:"BEN",locked:true,sent:digests(IMAGES.BEN.slice(0,2)),dropped:digests(IMAGES.BEN.slice(2))}]});
  });
  test("an uneven split favours the more prominent, and unused shares pass on",()=>{
    expect([...allocateReferences([candidate("ADA"),candidate("BEN"),candidate("CY")],4).kept.values()]).toEqual([2,1,1]);
    expect([...allocateReferences([candidate("ADA",1),candidate("BEN")],4).kept.values()]).toEqual([1,3]);
    expect([...allocateReferences([candidate("ADA",1),candidate("BEN",2),candidate("CY")],4).kept.values()]).toEqual([1,2,1]);
  });
  test("five characters at four: the four most prominent send one each, and the fifth is recorded with every image dropped",()=>{
    const {kept,record}=allocateReferences(NAMES.map(name=>candidate(name)),4);
    expect(NAMES.map(name=>kept.get(IDS[name]))).toEqual([1,1,1,1,0]);
    expect(record!.characters.map(entry=>[entry.name,entry.sent.length,entry.dropped.length])).toEqual([["ADA",1,3],["BEN",1,3],["CY",1,3],["DEE",1,3],["EVE",0,4]]);
  });
  test("never more than the budget, never a character missing from the record",()=>{
    for(const max of [1,2,3,4,5,8])for(let characters=1;characters<=5;characters++)for(const count of [1,2,3,4]){
      const candidates=NAMES.slice(0,characters).map(name=>candidate(name,count)),{kept,record}=allocateReferences(candidates,max);
      const sent=[...kept.values()].reduce((a,b)=>a+b,0);
      expect(sent).toBe(Math.min(max,characters*count));
      if(record){
        expect(record.characters.map(entry=>entry.characterId)).toEqual(candidates.map(value=>value.id));
        for(const entry of record.characters)expect([...entry.sent,...entry.dropped]).toEqual(digests(IMAGES[entry.name as typeof NAMES[number]].slice(0,count)));
      }else expect(characters*count).toBeLessThanOrEqual(max);
    }
  });
});

describe("a cast shot sends the subset and says so",()=>{
  const TWO="INT. WORKSHOP - DAY\n\nAda and Ben sort crates on the bench.";
  test("two locked characters, four views each: the shot sends two of each, numbered in order, and records the rest as dropped",()=>{
    const casting=castingSnapshot("project-1",1,[character("ADA"),character("BEN")],now),parsed=parseFountain(TWO);
    const full=directCast(filmPlan(parsed,undefined,24),parsed,casting,now)[0]!,cut=directCast(filmPlan(parsed,undefined,24),parsed,casting,now,undefined,4)[0]!;
    expect(full.referenceAssets!.map(asset=>asset.id)).toEqual([...IMAGES.ADA,...IMAGES.BEN].map(asset=>asset.id));
    expect(full).not.toHaveProperty("referenceBudget");
    expect(cut.referenceAssets!.map(asset=>asset.id)).toEqual([...IMAGES.ADA.slice(0,2),...IMAGES.BEN.slice(0,2)].map(asset=>asset.id));
    // The numbered reference map names only what is sent.
    expect(cut.prompt).toContain("Reference image 1 depicts ADA.\nReference image 2 depicts ADA.\nReference image 3 depicts BEN.\nReference image 4 depicts BEN.");
    expect(cut.prompt).not.toContain("Reference image 5");
    expect(cut.referenceBudget!.characters.map(entry=>[entry.name,entry.sent.map(asset=>asset.id),entry.dropped.map(asset=>asset.id)])).toEqual([
      ["ADA",IMAGES.ADA.slice(0,2).map(asset=>asset.id),IMAGES.ADA.slice(2).map(asset=>asset.id)],["BEN",IMAGES.BEN.slice(0,2).map(asset=>asset.id),IMAGES.BEN.slice(2).map(asset=>asset.id)]]);
    // Both characters keep their written cast direction.
    for(const name of ["ADA","BEN"])expect(cut.prompt).toContain(name+". Appearance:");
    // The budget a pool of 32 sets (HV-019-16's mock) leaves the shot exactly as without one.
    expect(directCast(filmPlan(parsed,undefined,24),parsed,casting,now,undefined,32)[0]).toEqual(full);
    expect(directCast(filmPlan(parsed,undefined,24),parsed,casting,now,undefined,null)[0]).toEqual(full);
  });
  test("HV-017-17's lock record keeps the lock and shows the subset; a record that doesn't split the lock is refused",()=>{
    const casting=castingSnapshot("project-1",1,[character("ADA"),character("BEN")],now),parsed=parseFountain(TWO);
    const shot=directCast(filmPlan(parsed,undefined,24),parsed,casting,now,undefined,4)[0]!;
    const locks=shotIdentityLocks(shot,casting);
    expect(locks.map(lock=>[lock.name,lock.revision,lock.assets,lock.sent,lock.dropped])).toEqual(["ADA","BEN"].map((name,index)=>[name,casting.characters[index]!.referenceLock!.revision,
      digests(IMAGES[name as "ADA"]),digests(IMAGES[name as "ADA"].slice(0,2)),digests(IMAGES[name as "ADA"].slice(2))]));
    // A record that claims other images, or a shot that wasn't sent what the record says, is refused.
    const budget=shot.referenceBudget!;
    const swapped={...budget,characters:[{...budget.characters[0]!,sent:budget.characters[0]!.dropped,dropped:budget.characters[0]!.sent},budget.characters[1]!]};
    expect(()=>shotIdentityLocks({...shot,referenceBudget:swapped},casting)).toThrow(IdentityLockError);
    expect(()=>shotIdentityLocks({...shot,referenceAssets:shot.referenceAssets!.slice(1)},casting)).toThrow(IdentityLockError);
    expect(()=>shotIdentityLocks({...shot,referenceBudget:undefined},casting)).toThrow(IdentityLockError);
    // An unbudgeted shot's record is unchanged: no `sent`, no `dropped`.
    const full=directCast(filmPlan(parsed,undefined,24),parsed,casting,now)[0]!;
    expect(shotIdentityLocks(full,casting).every(lock=>!("sent" in lock)&&!("dropped" in lock))).toBe(true);
  });
  test("five characters at four: prominence is who speaks, then who the shot names, then the rest; the left-out character is recorded",()=>{
    const script="INT. HALL - DAY\n\nAda and Ben wait by the door.\n\nEVE\nWe should go.\n\nCy and Dee watch Eve leave.";
    const casting=castingSnapshot("project-1",1,NAMES.map(name=>character(name)),now),parsed=parseFountain(script),planned=filmPlan(parsed,undefined,24);
    expect(planned.map(shot=>[shot.id,shot.dialogue.map(block=>block.character)])).toEqual([["shot-1-1",["EVE"]],["shot-1-2",[]]]);
    expect(castProminence(casting.characters,planned[0]!).map(value=>value.name)).toEqual(["EVE","ADA","BEN","CY","DEE"]);
    expect(castProminence(casting.characters,planned[1]!).map(value=>value.name)).toEqual(["CY","DEE","EVE","ADA","BEN"]);
    const [first,second]=directCast(planned,parsed,casting,now,undefined,4);
    for(const [shot,order,left] of [[first!,["EVE","ADA","BEN","CY","DEE"],"DEE"],[second!,["CY","DEE","EVE","ADA","BEN"],"BEN"]] as const){
      expect(shot.referenceAssets).toHaveLength(4);
      expect(shot.referenceBudget!.characters.map(entry=>entry.name)).toEqual([...order]);
      const out=shot.referenceBudget!.characters.find(entry=>entry.name===left)!;
      expect([out.sent,out.dropped.length]).toEqual([[],4]);
      // The shot's images stay in cast order: each sent character's front view.
      expect(shot.referenceAssets!.map(asset=>asset.id)).toEqual(NAMES.filter(name=>name!==left).map(name=>IMAGES[name][0]!.id));
      // Every character, sent or not, keeps its cast direction, and the lock record names all five.
      for(const name of NAMES)expect(shot.prompt).toContain(name+". Appearance:");
      const locks=shotIdentityLocks(shot,casting);
      expect(locks.map(lock=>[lock.name,lock.sent!.length,lock.dropped!.length])).toEqual(NAMES.map(name=>[name,name===left?0:1,name===left?4:3]));
    }
  });
  test("a recording adapter's referenceRecord (HV-019-16) must name exactly the images the budget sent, in order",()=>{
    const casting=castingSnapshot("project-1",1,[character("ADA"),character("BEN")],now),parsed=parseFountain(TWO);
    const shot=directCast(filmPlan(parsed,undefined,24),parsed,casting,now,undefined,4)[0]!;
    const record=(assets:{sha256:string}[])=>({use:"recorded-not-rendered",images:assets.map(asset=>({sha256:asset.sha256,bytes:4096}))});
    expect(()=>assertBudgetMatchesRecord(shot,record(shot.referenceAssets!))).not.toThrow();
    for(const wrong of [[...shot.referenceAssets!].reverse(),shot.referenceAssets!.slice(1),[...IMAGES.ADA,...IMAGES.BEN]])
      expect(()=>assertBudgetMatchesRecord(shot,record(wrong))).toThrow("are not the images its reference budget sent");
    // Nothing to reconcile without both: a vendor's shot has no record, an uncut shot no budget.
    expect(()=>assertBudgetMatchesRecord(shot,undefined)).not.toThrow();
    expect(()=>assertBudgetMatchesRecord({...shot,referenceBudget:undefined},record([]))).not.toThrow();
  });
  test("an unlocked character's own images are budgeted the same way, and recorded as unlocked",()=>{
    const casting=castingSnapshot("project-1",1,[character("ADA"),character("BEN",{unlocked:true,images:3})],now),parsed=parseFountain(TWO);
    const shot=directCast(filmPlan(parsed,undefined,24),parsed,casting,now,undefined,4)[0]!;
    expect(shot.referenceBudget!.characters.map(entry=>[entry.name,entry.locked,entry.sent.length,entry.dropped.length])).toEqual([["ADA",true,2,2],["BEN",false,2,1]]);
    expect(shotIdentityLocks(shot,casting).map(lock=>lock.name)).toEqual(["ADA"]);
  });
});
