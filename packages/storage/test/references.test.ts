import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicMockImageProvider } from "../../generator/src/image";
import { normalizeReference, referenceBody, ReferenceBlobStore } from "../src/references";
import { referenceLocalKey, validateReference } from "../../planner/src/references";
import { ProjectService } from "../../api/src/index";
import { CAST_INPUT, CAST_SCRIPT } from "../../../test/fixtures/casting";
import { castingSnapshot, currentCasting, directCast, validateCasting } from "../../planner/src/casting";
import { parseFountain } from "../../parser/src/index";
import { planShots } from "../../planner/src/index";

const root = mkdtempSync(join(tmpdir(),"hv-reference-test-"));let png: Buffer;
beforeAll(async () => {
  png = readFileSync((await new DeterministicMockImageProvider().generateFrame("A fictional potato",7,{},join(root,"fixture.png"))).path);
});
afterAll(() => rmSync(root,{recursive:true,force:true}));
test("reference normalization produces bounded PNG bytes and detects changed private storage", async () => {
  const {asset,data} = await normalizeReference(png,"project-1");
  expect(asset).toMatchObject({schema:"hv-reference/1",width:640,height:360,bytes:data.length,contentType:"image/png"});
  expect(() => validateReference(asset,"project-2")).toThrow();
  const store = new ReferenceBlobStore(root);await store.put(asset,data);
  expect(await store.read(asset)).toEqual(data);
  writeFileSync(join(root,referenceLocalKey(asset)),Buffer.alloc(data.length));
  await expect(store.read(asset)).rejects.toThrow("checksum");
});
test("reference intake rejects URL/vector payloads, oversized images and a lying stream", async () => {
  for (const input of [Buffer.from("<svg/>"),Buffer.from("https://example.test/image.png"),Buffer.alloc(10*1024**2+1)]) {
    await expect(normalizeReference(input,"project-1")).rejects.toThrow();
  }
  const huge = Buffer.from(png);huge.writeUInt32BE(100_000,16);
  await expect(normalizeReference(huge,"project-1")).rejects.toThrow("4096");
  const request = new Request("https://fixture.test",{method:"POST",headers:{"content-length":"1"},body:new ReadableStream({
    start(controller) {controller.enqueue(new Uint8Array(10*1024**2));controller.enqueue(new Uint8Array(1));controller.close();}
  })});
  await expect(referenceBody(request)).rejects.toThrow("10 MiB");
});
test("cast references stay pinned through text edits and detach; older cast hashes remain valid", async () => {
  process.env.HV_TOKEN_SECRET = "reference-domain-fixture-secret-thirty-two-characters";
  const service = new ProjectService(), owner = service.createAnonymousProject(), id = crypto.randomUUID();
  service.editScript(owner.token,CAST_SCRIPT);
  const original = service.saveCharacter(owner.token,id,CAST_INPUT,0)!;
  expect(validateCasting(original,owner.projectId)).toEqual(original);
  const {asset} = await normalizeReference(png,owner.projectId);
  const saved = service.addCharacterReference(owner.token,id,asset,1)!;
  expect(saved.characters[0]!.references).toEqual([asset]);
  const edited = service.saveCharacter(owner.token,id,{...CAST_INPUT,appearance:"A green scarf"},2)!;
  expect(edited.characters[0]!.references).toEqual([asset]);
  const parsed = parseFountain(CAST_SCRIPT), directed = directCast(planShots(parsed),parsed,edited);
  expect(directed[0]!.referenceAssets).toEqual([asset]);expect(directed[0]!.prompt).toContain("Reference image 1 depicts SPUD");
  const detached = service.removeCharacterReference(owner.token,id,asset.id,3)!;
  expect(detached.characters[0]!.references).toEqual([]);
  expect(service.authorize(owner.token)!.referenceAssets).toEqual([asset]);
  const reloaded = ProjectService.fromState(service.snapshot());
  expect(currentCasting(owner.projectId,reloaded.authorize(owner.token)!.castingHistory)).toEqual(detached);
  expect(() => castingSnapshot("another-project",1,saved.characters)).toThrow();
});
