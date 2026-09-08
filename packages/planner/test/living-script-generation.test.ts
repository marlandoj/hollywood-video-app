import {beforeAll,afterAll,expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash} from "../../generator/src/capabilities";
import type {EditSourceReceipt} from "../src/edit-sources";
import {compileEditScriptSource} from "../src/edit-script-source";
import {compileLivingScriptPatch,type LivingScriptPatch} from "../src/living-script-patch";
import {compileLivingScriptGenerationImpact,type LivingScriptRenderInputs} from "../src/living-script-generation";
import {renderShots,renderInputHash} from "../src/shot-reuse";
import {directionEntry,directionSnapshot} from "../src/direction";
import {castingSnapshot} from "../src/casting";
import {createProviderPlan} from "../../generator/src/catalog";
import {readFileSync} from "node:fs";
import {join} from "node:path";

let fixture:Awaited<ReturnType<typeof dubStudio>>,receipt:EditSourceReceipt,patch:LivingScriptPatch,candidate:LivingScriptRenderInputs;
beforeAll(async()=>{
  fixture=await dubStudio();receipt=await inspectEditSource(fixture.film,"Original cut",fixture.paths.artifactRoot,async()=>{});
  const index=compileEditScriptSource(receipt),entry=index.entries.find(entry=>entry.kind==="dialogue")!;
  patch=compileLivingScriptPatch(receipt,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:fixture.film.scriptVersion,text:fixture.film.scriptText},replacement:"Welcome back to the garden."});
  candidate={...fixture.film,scriptVersion:patch.after.version,scriptText:patch.after.text};
},180000);
afterAll(async()=>{await fixture?.close();});

test("line generation impact uses pinned shot inputs and preserves unchanged original receipts",()=>{
  const before=contentHash({receipt,patch,candidate}),result=compileLivingScriptGenerationImpact(receipt,patch,candidate);
  expect(result.generateShotIds).toEqual(["shot-1-1"]);expect(result.shots.map(shot=>shot.treatment)).toEqual(["regenerate","unchanged"]);
  expect(result.reusableRecords).toEqual([fixture.film.output!.shotRenders![1]!]);expect(result.topologyChanged).toBe(false);
  expect(result.shots[0]!.beforeInputHash).not.toBe(result.shots[0]!.afterInputHash);
  expect(result.shots[1]!.beforeInputHash).toBe(result.shots[1]!.afterInputHash);
  expect(contentHash({receipt,patch,candidate})).toBe(before);
  result.reusableRecords[0]!.files.video.bytes++;expect(receipt.job.output!.shotRenders![1]!.files.video.bytes).toBe(fixture.film.output!.shotRenders![1]!.files.video.bytes);
});

test("wrong proposed script, version, stage, tier and project cannot produce an impact receipt",()=>{
  for(const change of [{scriptText:fixture.film.scriptText},{scriptVersion:patch.before.version},{stage:"final"},{tier:"elevated"},{projectId:"other"}])expect(()=>compileLivingScriptGenerationImpact(receipt,patch,{...candidate,...change} as LivingScriptRenderInputs)).toThrow();
  const altered=structuredClone(patch);altered.after.text+="\nChanged.";expect(()=>compileLivingScriptGenerationImpact(receipt,altered,candidate)).toThrow();
});

test("additional reviewed direction changes count as generation impact even outside the patched line",()=>{
  const shots=renderShots(candidate),second=shots[1]!,direction=directionSnapshot(candidate.projectId,1,[directionEntry(second,{durationFrames:120})],Date.now());
  const changed={...candidate,direction},result=compileLivingScriptGenerationImpact(receipt,patch,changed);
  expect(result.generateShotIds).toEqual(["shot-1-1","shot-1-2"]);expect(result.reusableRecords).toEqual([]);
  expect(result.shots[1]!.afterInputHash).toBe(renderInputHash(changed,renderShots(changed)[1]!));
  expect(result.warnings.some(message=>message.includes("Planned shot duration changed"))).toBe(true);
});

test("old source-bound direction is rejected instead of silently discarded after dialogue changes",()=>{
  const first=renderShots(fixture.film)[0]!,direction=directionSnapshot(candidate.projectId,1,[directionEntry(first,{durationFrames:120})],Date.now());
  expect(()=>compileLivingScriptGenerationImpact(receipt,patch,{...candidate,direction})).toThrow("changed or disappeared");
});

test("impact retains full candidate bindings and makes unverified cut publication explicit",()=>{
  const result=compileLivingScriptGenerationImpact(receipt,patch,candidate);
  expect(result.candidateInputs.scriptText).toBe(patch.after.text);expect(result.candidateInputs.providerPlan).toEqual(fixture.film.providerPlan);
  expect(result.warnings.some(message=>message.includes("Current original permissions"))).toBe(true);
  expect(result.warnings.some(message=>message.includes("Actual generated duration"))).toBe(true);
  const {revision,...data}=result;expect(revision).toBe(contentHash(data));
  expect(JSON.stringify(result)).not.toContain("Bearer ");
});

test("individually valid foreign bindings and wrong-stage provider plans cannot be reviewed",()=>{
  const changes=[{casting:castingSnapshot("other-project",0,[],Date.now())},{direction:directionSnapshot("other-project",0,[],Date.now())},{providerPlan:createProviderPlan("final",5,undefined,{HV_PROVIDER_POOL:'["mock"]'})}];
  for(const change of changes)expect(()=>compileLivingScriptGenerationImpact(receipt,patch,{...candidate,...change})).toThrow("bindings for this project and render stage");
});

test("reviewed changed-shot set matches actual selective generation and retained source media",async()=>{
  const impact=compileLivingScriptGenerationImpact(receipt,patch,candidate),original=contentHash(fixture.store.get(fixture.film.id)),originalCaptions=readFileSync(join(fixture.paths.artifactRoot,fixture.film.output!.captionsPath),"utf8");
  const saved=await fixture.call(fixture.base+"/script","PUT",{text:patch.after.text},fixture.owner.token);expect(saved.status).toBe(200);
  const admitted=await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true},fixture.owner.token);expect(admitted.status).toBe(202);
  const completed=await fixture.worker();expect(completed?.failureReason??completed?.cancelReason).toBeUndefined();expect(completed?.status).toBe("done");
  const records=completed!.output!.shotRenders!;expect(records.filter(record=>!record.reusedFrom).map(record=>record.shotId)).toEqual(impact.generateShotIds);
  expect(records.filter(record=>record.reusedFrom).map(record=>record.reusedFrom!.revision)).toEqual(impact.reusableRecords.map(record=>record.revision));
  expect(records[1]!.files.video.sha256).toBe(fixture.film.output!.shotRenders![1]!.files.video.sha256);expect(records[1]!.files.video.path).not.toBe(fixture.film.output!.shotRenders![1]!.files.video.path);
  const captions=readFileSync(join(fixture.paths.artifactRoot,completed!.output!.captionsPath),"utf8");expect(captions).toContain("Welcome back to the garden.");expect(captions).not.toBe(originalCaptions);
  expect(contentHash(fixture.store.get(fixture.film.id))).toBe(original);expect(readFileSync(join(fixture.paths.artifactRoot,fixture.film.output!.captionsPath),"utf8")).toBe(originalCaptions);
},180000);
