import {afterAll,beforeAll,expect,test} from "bun:test";
import {currentFilmAuthorityFixture,currentFilmAuthorityProposal} from "./current-film-authority.fixture";
import {validateCurrentShotPlan,materializeCurrentShotPlan} from "../src/living-script-current-plan";
import {validateCurrentDirection} from "../src/living-script-current-direction";
import {validateLivingScriptCastRebind} from "../src/living-script-cast-rebind";
import {renderCurrentScreenplay} from "../src/living-script-current-render";
import {castingSnapshot,currentCasting} from "../src/casting";
import {contentHash} from "../../generator/src/capabilities";

let f:Awaited<ReturnType<typeof currentFilmAuthorityFixture>>,proposal:ReturnType<typeof currentFilmAuthorityProposal>;
beforeAll(async()=>{f=await currentFilmAuthorityFixture();proposal=currentFilmAuthorityProposal(f.project,"historical-cache",f.at+100);},120000);
afterAll(async()=>{await f?.studio.close();});
const state=()=>proposal.plan.target.state;
const plan=()=>{const c=state().context;return validateCurrentShotPlan(c.plan,c.lineage,c.originals);};
const direction=()=>validateCurrentDirection(state().direction,state().context);
const casting=()=>validateLivingScriptCastRebind(state().casting);
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...body,revision:contentHash(body)} as T;};
function reversed<T>(input:T):T {if(Array.isArray(input))return input.map(reversed) as T;if(input&&typeof input==="object")return Object.fromEntries(Object.entries(input).reverse().map(([key,value])=>[key,reversed(value)])) as T;return input;}

test("warm historical caches retain independent returns and canonical JSONB property order",()=>{
  const saved=state(),fingerprint=contentHash(saved);plan();direction();casting();
  const p=plan(),d=direction(),c=casting();p.shots[0]!.seed++;d.entries[0]!.sourceHash="f".repeat(64);c.scenes[0]!.afterSceneNumber=999;
  expect(plan()).toEqual(saved.context.plan);expect(direction()).toEqual(saved.direction);expect(casting()).toEqual(saved.casting);
  const json=reversed(JSON.parse(JSON.stringify(saved)));
  expect(validateCurrentShotPlan(json.context.plan,json.context.lineage,json.context.originals)).toEqual(saved.context.plan);
  expect(validateCurrentDirection(json.direction,json.context)).toEqual(saved.direction);expect(validateLivingScriptCastRebind(json.casting)).toEqual(saved.casting);
  expect(contentHash(saved)).toBe(fingerprint);
});

test("warmed cache keys reject resealed changed plans, omitted ancestry and substituted original receipts",()=>{
  plan();direction();const saved=state(),changed=structuredClone(saved.context);changed.plan.shots[0]!.seed++;changed.plan.shots[0]=reseal(changed.plan.shots[0]!);changed.plan=reseal(changed.plan);
  expect(()=>validateCurrentShotPlan(changed.plan,changed.lineage,changed.originals)).toThrow();
  expect(()=>validateCurrentDirection(saved.direction,changed)).toThrow();
  const shorter=structuredClone(saved.context);shorter.lineage.steps=[];shorter.lineage=reseal(shorter.lineage);
  expect(()=>validateCurrentShotPlan(shorter.plan,shorter.lineage,shorter.originals)).toThrow();
  expect(()=>validateCurrentDirection(saved.direction,shorter)).toThrow();
  const original=structuredClone(saved.context);original.originals[0]!.job.scriptText+="\nAn unrelated changed source.";original.originals[0]=reseal(original.originals[0]!);
  expect(()=>validateCurrentShotPlan(original.plan,original.lineage,original.originals)).toThrow();
  expect(()=>validateCurrentDirection(saved.direction,original)).toThrow();
  expect(()=>validateCurrentShotPlan(saved.context.plan,saved.context.lineage,[])).toThrow();
});

test("warm direction/cast seals cannot approve altered physical settings or scene correspondence",()=>{
  direction();casting();const saved=state(),d=structuredClone(saved.direction);d.entries[0]!.sourceHash="a".repeat(64);
  expect(()=>validateCurrentDirection(reseal(d),saved.context)).toThrow();
  const c=structuredClone(saved.casting);c.scenes[0]!.afterSceneNumber=999;
  expect(()=>validateLivingScriptCastRebind(reseal(c))).toThrow();
  const candidate=structuredClone(saved.casting);candidate.candidate!.characters[0]!.name="A changed performer";candidate.candidate=reseal(candidate.candidate!);
  expect(()=>validateLivingScriptCastRebind(reseal(candidate))).toThrow();
});

test("cached validation inspects hostile descriptors without reading accessors or collapsing nonportable values",()=>{
  plan();direction();casting();let reads=0;const saved=state();
  const context=structuredClone(saved.context);Object.defineProperty(context.originals[0]!.job,"scriptText",{enumerable:true,get(){reads++;return "wrong";}});
  expect(()=>validateCurrentShotPlan(context.plan,context.lineage,context.originals)).toThrow();expect(()=>validateCurrentDirection(saved.direction,context)).toThrow();
  const cast=structuredClone(saved.casting);Object.defineProperty(cast.input.after,"revision",{enumerable:true,get(){reads++;return saved.casting.input.after.revision;}});
  expect(()=>validateLivingScriptCastRebind(cast)).toThrow();expect(reads).toBe(0);
  for(const mutate of [(value:object)=>Object.defineProperty(value,"hidden",{value:1}), (value:object)=>Object.assign(value,{extra:undefined}),
    (value:object)=>Object.defineProperty(value,Symbol("hidden"),{value:1,enumerable:true}), (value:object)=>Object.assign(value,{extra:NaN})]){
    const p=structuredClone(saved.context);mutate(p.plan);expect(()=>validateCurrentShotPlan(p.plan,p.lineage,p.originals)).toThrow();
    const d=structuredClone(saved.direction);mutate(d);expect(()=>validateCurrentDirection(d,saved.context)).toThrow();
    const c=structuredClone(saved.casting);mutate(c);expect(()=>validateLivingScriptCastRebind(c)).toThrow();
  }
});

test("historical cache hits do not retain current grant, time or document authority",()=>{
  plan();direction();casting();const saved=state(),baseline=currentCasting(f.project.id,f.project.castingHistory),current={documentRevision:proposal.plan.baseline.documentRevision,casting:baseline};
  const at=f.at+101,expected=renderCurrentScreenplay(saved,current,at);
  expect(renderCurrentScreenplay(saved,current,at)).toEqual(expected);
  const expires=Date.parse(baseline.characters[0]!.permission.expiresAt!);expect(()=>renderCurrentScreenplay(saved,current,expires+1)).toThrow();
  const changed=structuredClone(baseline.characters);changed[0]!.permission.status="revoked";
  const revoked=castingSnapshot(f.project.id,baseline.version+1,changed,at+1);expect(()=>renderCurrentScreenplay(saved,{...current,casting:revoked},at+2)).toThrow();
  expect(()=>renderCurrentScreenplay(saved,{...current,documentRevision:"f".repeat(64)},at)).toThrow();
  expect(casting()).toEqual(saved.casting);expect(direction()).toEqual(saved.direction);
  const c=saved.context;expect(materializeCurrentShotPlan(c.plan,c.plan.document,c.lineage,c.originals)).toHaveLength(c.plan.shots.length);
});
