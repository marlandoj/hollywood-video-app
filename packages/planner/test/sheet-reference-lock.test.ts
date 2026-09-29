/**
 * HV-017-11 — the one render the locked look did not reach.
 *
 * HV-017-09 made a character's locked look decide what conditions its renders, and in what order:
 * `renderReferences` is "the one place that decides what conditions a shot", and `directCast` uses
 * it. `characterSheetShots` read `character.references` directly and always had, so a character
 * sheet was conditioned on every image the character held, in upload order, including the ones the
 * owner had deliberately left out of the look.
 *
 * A sheet is not an incidental render. Its views are what the studio adopts *as* the character's
 * reference images, through `POST /characters/:id/references` with the sheet's frames. So the one
 * render whose output becomes the next reference set was the one render the lock did not reach, and
 * a locked character's look drifted through exactly the route that exists to pin it.
 */
import {expect,test} from "bun:test";
import {readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {CAST_INPUT,CAST_SCRIPT} from "../../../test/fixtures/casting";
import {parseFountain} from "../../parser/src/index";
import {planShots} from "../src/index";
import {castingSnapshot,characterRecord,directCast} from "../src/casting";
import {referenceLockRecord,renderReferences} from "../src/reference-lock";
import {characterSheetShots,createCharacterSheet,type SheetKind} from "../src/sheets";

const now=Date.UTC(2026,8,22);
const ID="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const parsed=parseFountain(CAST_SCRIPT),shots=planShots(parsed,7000,24);
const image=(seed:string)=>({schema:"hv-reference/1" as const,id:"11111111-2222-4333-8444-"+seed.repeat(12).slice(0,12),projectId:"project-1",
  sha256:seed.repeat(64).slice(0,64),originalSha256:"b".repeat(64),bytes:4096,width:512,height:512,contentType:"image/png" as const,
  createdAt:new Date(now).toISOString(),attestedAt:new Date(now).toISOString()});
const [one,two,three,four]=["c","d","e","f"].map(image);
const actor=(references=[one!,two!,three!],referenceLock?:unknown)=>characterRecord({...CAST_INPUT,
  permission:{status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()},
  sceneBindings:[],references,...(referenceLock===undefined?{}:{referenceLock})},ID,now,true);
/** Locked to the third image and then the first: a different set *and* a different order. */
const lock=(references=[one!,two!,three!])=>referenceLockRecord({assetIds:[three!.id,one!.id],label:"Act two, after the storm",note:"The coat and the glasses."},references,now);
const cast=(references=[one!,two!,three!],referenceLock?:unknown,revision=2)=>castingSnapshot("project-1",revision,[actor(references,referenceLock)],now);
const KINDS:SheetKind[]=["turnaround","expressions","wardrobe","lighting","adult-ages"];
const sheet=(snapshot:ReturnType<typeof cast>,kind:SheetKind="turnaround")=>
  characterSheetShots(createCharacterSheet(snapshot,parsed,ID,{kind,seed:7,sceneNumber:null}),snapshot,parsed,now);
const digests=(assets?:{sha256:string}[])=>(assets??[]).map(asset=>asset.sha256.slice(0,4));

test("a locked look conditions the character sheet too, in the order the lock names",()=>{
  const locked=cast([one!,two!,three!],lock());
  for(const kind of KINDS){
    const views=sheet(locked,kind);
    expect(views.length).toBeGreaterThan(0);
    for(const view of views){
      // The set and the order are the lock's, not the upload's -- the image left out of the look is
      // left out of the sheet, which before this increment it was not.
      expect({kind,id:view.id,references:digests(view.referenceAssets)}).toEqual({kind,id:view.id,references:digests([three!,one!])});
      // The numbered map the prompt hands the provider counts the locked set, exactly as directCast's does.
      expect({kind,named:(view.prompt.match(/Reference image \d+ depicts/g)??[]).length}).toEqual({kind,named:2});
    }
  }
});

test("and an unlocked character's sheet is what it always was",()=>{
  // This increment narrows nothing for a character whose look is not locked: it still renders on
  // everything it holds, in upload order, which is what `renderReferences` answers for it.
  for(const kind of KINDS)for(const view of sheet(cast(),kind)){
    expect({kind,references:digests(view.referenceAssets)}).toEqual({kind,references:digests([one!,two!,three!])});
    expect({kind,named:(view.prompt.match(/Reference image \d+ depicts/g)??[]).length}).toEqual({kind,named:3});
  }
  // A character with no images at all still carries none, and says nothing about references.
  const bare=sheet(cast([]))[0]!;
  expect(bare.referenceAssets).toBeUndefined();
  expect(bare.prompt).not.toContain("Reference image");
});

test("adopting another view into a locked character does not change what its next sheet renders",()=>{
  // The adoption loop is the whole point: a sheet's frames are saved as the character's references,
  // so an unlocked sheet render fed its own output back in and the look walked. With the lock read,
  // the fourth image changes neither the film's shots nor the next sheet.
  const before=sheet(cast([one!,two!,three!],lock()));
  const after=sheet(cast([one!,two!,three!,four!],lock([one!,two!,three!,four!]),3));
  expect(digests(after[0]!.referenceAssets)).toEqual(digests(before[0]!.referenceAssets));
  expect(after[0]!.prompt).toBe(before[0]!.prompt);
  // Unlocked, the same adoption moves the sheet's own conditioning -- the defect one file over.
  const loose=sheet(cast([one!,two!,three!,four!],undefined,4));
  expect(digests(loose[0]!.referenceAssets)).toEqual(digests([one!,two!,three!,four!]));
});

test("the film and the sheet agree about a character, asserted over the pair rather than an example",()=>{
  // Two call sites turned a character into a render's reference set and only one of them was
  // taught the lock. Asserting the pair is what makes a future third one fail here.
  for(const [name,snapshot] of [["unlocked",cast()],["locked",cast([one!,two!,three!],lock())],
    ["no images",cast([])],["one image",cast([two!])]] as const){
    const expected=digests(renderReferences(snapshot.characters[0]!));
    expect({name,film:digests(directCast(shots,parsed,snapshot,now)[0]!.referenceAssets)}).toEqual({name,film:expected});
    expect({name,sheet:digests(sheet(snapshot)[0]!.referenceAssets)}).toEqual({name,sheet:expected});
  }
});

/**
 * Every read of a `.references` field in `packages/planner/src`, by the file it is in and what it
 * is read off. A character's images are read for validation in several places, legitimately; what
 * must not happen again is a *render* reading them instead of asking `renderReferences`. The map is
 * compared whole, so a new read in a new file fails this test rather than a review.
 */
const REFERENCE_READS:Record<string,string[]>={
  // The images a shared actor carries, checked at the border in both directions. `copiedActorReferences`
  // re-identifies them in the destination project; an imported actor arrives unlocked (HV-017-09).
  "actor-library.ts":["character","share.character","share.character"],
  // `value` is the untrusted input to `characterRecord`; `character` is the saved record's own
  // images re-validated by `castingSnapshot`. The render's set is `renderReferences`, three lines down.
  "casting.ts":["character","value","value","value","value"],
  // A mixed film's proof: the recovery copies of the reference images its history already named, and
  // the cap on how many. Nothing here resolves a character for a render (HV-016-24).
  "current-film-prepared-proof.ts":["proof","proof","specification"],
  "current-film-proof-closure.ts":["CURRENT_FILM_PROOF_LIMITS"],
  "current-film-proof-copies.ts":["closure"],
  // A recipe's own frozen reference list, not a character's -- it is what the character resolved to.
  "current-film-reuse.ts":["recipe","recipe","recipe","slot.recipe","source.recipe"],
  // Catalog checks: every image a retained record names must still exist in the project.
  "current-film-source-permission.ts":["saved"],
  "current-screenplay-authority.ts":["character"],
  "living-script-jobs.ts":["character"],
  // The decision itself, and the lock it reads.
  "reference-lock.ts":["character","character"],
  "shot-execution-capture.ts":["recipe","recipe","recipe","recipe","recipe"],
  "shot-execution-equivalence.ts":["recipe","recipe","recipe","recipe","recipe"],
  // `value` is a recipe being re-sealed.
  "shot-render-recipe.ts":["value"],
};
test("and renderReferences is the only thing in the planner that turns a character into a render's references",()=>{
  const root=new URL("../src/",import.meta.url).pathname;
  const found:Record<string,string[]>={};
  for(const name of readdirSync(root).sort()){
    if(!name.endsWith(".ts"))continue;
    // Comments are stripped first: a guard that counts the words in a comment about the defect is
    // a guard that passes when the defect comes back.
    const source=readFileSync(join(root,name),"utf8").replace(/\/\*[\s\S]*?\*\//g,"").replace(/(^|[^:])\/\/[^\n]*/g,"$1");
    const reads=[...source.matchAll(/([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\??\.references\b/g)].map(match=>match[1]!).sort();
    if(reads.length)found[name]=reads;
  }
  expect(found).toEqual(REFERENCE_READS);
  // And the two renders both ask it.
  for(const name of ["casting.ts","sheets.ts"])
    expect({name,asks:readFileSync(join(root,name),"utf8").includes("renderReferences(")}).toEqual({name,asks:true});
});
