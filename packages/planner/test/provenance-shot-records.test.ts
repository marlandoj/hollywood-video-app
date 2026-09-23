/**
 * HV-031-09 — a manifest that had lost its shots killed the job with a TypeError instead of refusing.
 *
 * Four verifiers compared a retained export's render records with the ones the film actually
 * recorded, and each wrote the extraction out inline:
 *
 *     contentHash(provenance.shots?.map((s:{renderRecord?:unknown})=>s.renderRecord))        // sound-media, dialogue-replacement
 *     contentHash(provenance.shots?.map((s:{renderRecord?:unknown})=>s.renderRecord)??null)  // edit-source-media, twice
 *
 * Two left the `?? null` off, and that is not a cosmetic difference. `contentHash(undefined)` is not
 * a hash of nothing: `canonical(undefined)` is `JSON.stringify(undefined)`, which is `undefined`, and
 * `createHash("sha256").update(undefined)` throws.
 *
 * So a manifest that satisfied `provenanceMatches` — right spec, right project, a valid
 * `assembledAt`, a claim bound to the file's own sha256 — and had lost its `shots` key did not
 * produce "The picture's original provenance changed." It produced
 * `The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.
 * Received undefined` as the job's `failureReason`. A tamper signal became an internal type error,
 * and the creator was told nothing about their film.
 *
 * `provenance.ts` exists because the spec and the claim were each written in five places and, in its
 * own words, "each verifier reporting a different failure". The identity check moved into it; this
 * comparison stayed behind. The extraction is a function now, so the `?? null` cannot be left off —
 * there is nowhere left to leave it.
 */
import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {contentHash} from "../../generator/src/capabilities";
import {PROVENANCE_CREDENTIAL_TYPE,PROVENANCE_ISSUER,PROVENANCE_SPEC,provenanceMatches,provenanceShotRecords} from "../src/provenance";

const REPO_ROOT=resolve(import.meta.dir,"../../..");

/** A manifest a verifier would accept the identity of, with its shots under the test's control. */
const manifest=(shots:unknown)=>({spec:PROVENANCE_SPEC,projectId:"p1",scriptSha256:"a".repeat(64),
  assembledAt:"2026-09-23T04:00:00.000Z",
  credentials:{type:PROVENANCE_CREDENTIAL_TYPE,issuer:PROVENANCE_ISSUER,claim:"AI-generated video; content credentials sha256:"+"b".repeat(64)},
  ...(shots===undefined?{}:{shots})});

test("a manifest with no shots has no records, rather than a value that cannot be hashed",()=>{
  // The defect in one line: this used to be `undefined`, and `contentHash(undefined)` throws.
  for (const absent of [manifest(undefined),manifest(null),manifest("shots"),manifest(42),null,undefined,"not a manifest"])
    expect(provenanceShotRecords(absent)).toBeNull();
  expect(() => contentHash(provenanceShotRecords(manifest(undefined)))).not.toThrow();
  // And `null` is a hash of its own, so a manifest with no shots does not match one that has them.
  expect(contentHash(provenanceShotRecords(manifest(undefined)))).not.toBe(contentHash([{seed:1}]));
});

test("and a manifest that has them hands them over in its own order",()=>{
  const records=[{seed:1},{seed:2},{seed:3}];
  const value=manifest(records.map((record,index)=>({id:"s"+index,provider:"mock",model:"m",seed:index,fingerprint:"f",renderRecord:record})));
  expect(provenanceShotRecords(value)).toEqual(records);
  expect(contentHash(provenanceShotRecords(value))).toBe(contentHash(records));
  // A shot that carries no record keeps its place, because position is what is being compared.
  const partial=manifest([{id:"s0",renderRecord:records[0]},{id:"s1"}]);
  expect(provenanceShotRecords(partial)).toEqual([records[0],undefined]);
});

test("and the identity of the manifest is unchanged by any of this",()=>{
  // The claim this sits beside. A manifest with no shots is still one this project's verifier would
  // recognise -- which is exactly why the comparison below it had to be reached rather than thrown
  // past.
  expect(provenanceMatches(manifest(undefined),{projectId:"p1",sha256:"b".repeat(64)})).toBe(true);
  expect(provenanceMatches(manifest([]),{projectId:"p1",sha256:"b".repeat(64)})).toBe(true);
});

test("and no verifier extracts the records for itself any more",()=>{
  // The whole map, over the package rather than the two files that were wrong. The extraction is one
  // function; a fifth verifier that wrote it out again would be a fifth chance to leave the `?? null`
  // off, which is the only reason the two spellings ever differed.
  const files=[...new Bun.Glob("packages/*/src/**/*.ts").scanSync(REPO_ROOT)].map(file=>file.split("\\").join("/")).sort();
  expect(files.length).toBeGreaterThan(100);
  // Comments stripped first: the module that owns the extraction names the old spelling in its own.
  const strip=(text:string)=>text.replaceAll(/\/\*[\s\S]*?\*\//g,"").replaceAll(/^\s*\/\/.*$/gm,"");
  const source=new Map(files.map(file=>[file,strip(readFileSync(join(REPO_ROOT,file),"utf8"))]));
  expect(files.filter(file=>/\.shots\?\.map\(/.test(source.get(file)!))).toEqual([]);
  // `renderRecord` itself is a real field with many honest readers; what must not come back is a
  // second place that reaches into a *manifest's* shots for it.
  expect(files.filter(file=>/provenance\w*\.shots/i.test(source.get(file)!)&&file!=="packages/planner/src/provenance.ts")).toEqual([]);
  // And each of the three verifiers reaches for it, beside the identity check it already reached for.
  for (const file of ["packages/generator/src/dialogue-replacement.ts","packages/generator/src/edit-source-media.ts","packages/generator/src/sound-media.ts"]) {
    expect({file,extracts:/provenanceShotRecords\(/.test(source.get(file)!)}).toEqual({file,extracts:true});
    expect({file,identity:/provenanceMatches\(/.test(source.get(file)!)}).toEqual({file,identity:true});
  }
});
