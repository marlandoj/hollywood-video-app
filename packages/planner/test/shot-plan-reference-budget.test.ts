/**
 * HV-019-18 — a retained film's shots are planned with the reference budget the worker planned them with.
 *
 * Release 3's third rehearsal stopped at sequence 1's rough cut: "undefined is not an object (evaluating
 * 'job.providerPlan.pool')". HV-019-17 (#371) made planning read the render pool's reference budget, and
 * HV-030-32 (#373) memoized `renderShots` on only the fields it then read, which left the provider plan
 * out. Both merged; together every `renderShots` call threw. The memo is now keyed on the budget too,
 * computed as the worker computes it (`poolReferenceBudget(job.providerPlan?.pool)`, worker.ts).
 */
import {expect,test} from "bun:test";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {parseFountain} from "../../parser/src/index";
import {describeProvider} from "../../generator/src/catalog";
import {castingSnapshot,characterRecord,directCast} from "../src/casting";
import {directShots,directionSnapshot} from "../src/direction";
import {referenceLockRecord} from "../src/reference-lock";
import {poolReferenceBudget} from "../src/reference-budget";
import {filmPlan,inSequence} from "../src/sequences";
import {bibleShots} from "../src/style-bible";
import {renderShots} from "../src/shot-reuse";
import {TIERS,type Job} from "../../queue/src/index";

const now=Date.UTC(2026,9,4),PROJECT="project-1";
const image=(seed:string)=>({schema:"hv-reference/1" as const,id:"11111111-2222-4333-8444-"+seed.repeat(12).slice(0,12),projectId:PROJECT,
  sha256:seed.repeat(64).slice(0,64),originalSha256:"b".repeat(64),bytes:4096,width:512,height:512,contentType:"image/png" as const,
  createdAt:new Date(now).toISOString(),attestedAt:new Date(now).toISOString()});
const permitted={status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()};
/** A character locked to four turnaround views, as `--lock WREN,OSWIN` locks them before the look. */
const locked=(name:string,id:string,seed:string)=>{const references=["1","2","3","4"].map(n=>image(seed+n));
  return characterRecord({...CAST_INPUT,name,aliases:[],permission:permitted,sceneBindings:[],references,
    referenceLock:referenceLockRecord({assetIds:references.map(asset=>asset.id),label:name+" turnaround",note:""},references,now)},id,now,true);};
const SCRIPT="INT. CHAPEL - DAWN\n\nWREN and OSWIN cross the nave.\n\nWREN\nKeep up.\n\nEXT. SANDBANK - DAY\n\nOSWIN waits by the boat.";
const casting=castingSnapshot(PROJECT,1,[locked("WREN","aaaaaaaa-1111-4111-8111-111111111111","a"),locked("OSWIN","aaaaaaaa-1111-4111-8111-222222222222","b")],now);
const sequence={number:1,of:2,firstScene:1,lastScene:1,planRevision:"c".repeat(64)};
const pool=(specs:string[])=>specs.map(spec=>describeProvider(spec,"animatic",{}));
/** A feature's sequence-1 rough cut, retained with the provider plan it was admitted with. */
const film=(providerPool:ReturnType<typeof pool>)=>({projectId:PROJECT,stage:"animatic",tier:"free",scriptText:SCRIPT,casting,sequence,providerPlan:{pool:providerPool}} as unknown as Job);
/** What the worker planned for it (packages/queue/src/worker.ts, the film branch). */
const workerPlan=(job:Job)=>{const parsed=parseFountain(job.scriptText),direction=directionSnapshot(PROJECT,0,[],0);
  return bibleShots(inSequence(directShots(directCast(filmPlan(parsed,undefined,TIERS[job.tier].maxShots,job.sequence),parsed,job.casting!,now,undefined,poolReferenceBudget(job.providerPlan?.pool)),direction),job.sequence),parsed,job.styleBible);};

test("a retained sequence render is planned with the worker's reference budget, and the memo tells two budgets apart",()=>{
  const referenced=film(pool(["image:fal:flux-2-edit","image:fal:flux-schnell"])),mock=film(pool(["mock"]));
  expect([poolReferenceBudget(referenced.providerPlan!.pool),poolReferenceBudget(mock.providerPlan!.pool)]).toEqual([4,32]);
  const cut=renderShots(referenced,now),whole=renderShots(mock,now);
  expect(cut).toEqual(workerPlan(referenced));
  expect(whole).toEqual(workerPlan(mock));
  // Both locked characters share the first shot: four images on the referenced pool (two each), all eight on the mock's.
  expect([cut[0]!.referenceAssets?.length,whole[0]!.referenceAssets?.length]).toEqual([4,8]);
  // Asked again, in either order, each answers its own budget's plan rather than the other's remembered one.
  expect([renderShots(mock,now),renderShots(referenced,now)]).toEqual([whole,cut]);
});
