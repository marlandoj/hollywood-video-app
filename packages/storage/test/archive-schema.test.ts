import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ARCHIVE_LIMITS, ARCHIVE_SCHEMA_DIRECTORY, ARCHIVE_SCHEMA_FILES, STATE_SNAPSHOT_SCHEMAS, assertArchiveDocument, canonicalJson, clipsManifest, loadArchiveSchema, validateDocument, type ArchiveSchemaName, type JsonSchema } from "../src/archive-schema";
import { PostgresArtifactStore } from "../src/artifacts";
import { readStateSnapshot, stateSnapshotSchema, validateSnapshot, type StateSnapshot } from "../src/snapshots";
import type { Job } from "../../queue/src/index";
import { GOLDEN_SOURCE, goldenClipsManifestPath, goldenDocument, goldenJobId, goldenReceipt, mutate, rejectionRows } from "./fixtures/archive-golden/matrix";

// Criteria 1, 3, 4 and 6 of HV-040-04 (docs/PROJECT-ARCHIVE.md "Schema files" and "Conformance
// suite"): offline, no PostgreSQL, no S3, no python. The golden fixture provides the base documents.
const NAMES = Object.keys(ARCHIVE_SCHEMA_FILES) as ArchiveSchemaName[];
const python = Bun.which("python3") ?? Bun.which("python");
const pytest = python ? test : test.skip;
const at = (schema: JsonSchema, value: unknown, pointer: string, reason: RegExp): void => { const result = validateDocument(schema,value); expect(result).toMatchObject({ok:false,pointer}); if (!result.ok) expect(result.reason).toMatch(reason); };
const ok = (schema: JsonSchema, value: unknown): void => expect(validateDocument(schema,value)).toEqual({ok:true});
function* patterns(node: unknown, path = ""): Generator<[string,string]> {
  if (!node || typeof node !== "object") return;
  for (const [key,value] of Object.entries(node)) { if (key === "pattern") yield [path + "/pattern",String(value)]; yield* patterns(value,path + "/" + key); }
}

test("the three schema files are draft 2020-12 documents with URN identity, titles, anchored patterns and no URL beyond the dialect line",() => {
  let anchored = 0;
  for (const name of NAMES) {
    const file = ARCHIVE_SCHEMA_FILES[name], text = readFileSync(resolve(ARCHIVE_SCHEMA_DIRECTORY,file),"utf8"), schema = loadArchiveSchema(name);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(String(schema.$id)).toStartWith("urn:hollywood-video:schema:"); expect(schema.$id).toBe("urn:hollywood-video:schema:" + name.replace("/",":"));
    expect(typeof schema.title).toBe("string"); expect(typeof schema.description).toBe("string");
    const urls = text.match(/https?:\/\/[^"\s]*/g) ?? [];
    expect(urls).toEqual(["https://json-schema.org/draft/2020-12/schema"]);
    const found = [...patterns(schema)]; anchored += found.length;
    for (const [where,pattern] of found) { expect([where,pattern.startsWith("^") && pattern.endsWith("$")]).toEqual([where,true]); expect(() => new RegExp(pattern)).not.toThrow(); }
    expect(file as string).toBe(name.replace("/",".") + ".schema.json");
  }
  expect(anchored).toBe(4); // projectId, path, sha256 in the archive schema and sha256 in the state schema
  expect(loadArchiveSchema("hv-project-archive/1")).toBe(loadArchiveSchema("hv-project-archive/1"));
});

test("any keyword outside the subset makes validateDocument throw instead of passing",() => {
  const cases: [string,JsonSchema][] = [["oneOf",{oneOf:[{type:"string"}]}],["anyOf",{anyOf:[]}],["format",{type:"string",format:"uri"}],["exclusiveMinimum",{type:"integer",exclusiveMinimum:0}],
    ["patternProperties",{type:"object",patternProperties:{"^x":{}}}],["remote $ref",{$ref:"https://example.invalid/schema.json"}],["file $ref",{$ref:"other.json#/$defs/x"}],["unknown $defs name",{$ref:"#/$defs/missing",$defs:{}}],
    ["nested",{type:"object",properties:{a:{type:"array",items:{type:"string",minContains:1}}}}],["in $defs",{$defs:{x:{allOf:[]}}}],["object additionalProperties",{type:"object",additionalProperties:{type:"string"}}],
    ["type list",{type:["string","null"]}],["unknown type",{type:"date"}],["unanchored pattern",{type:"string",pattern:"[a-z]+"}],["boolean subschema",{type:"object",properties:{a:true}}]];
  for (const [label,schema] of cases) expect(() => validateDocument(schema,"value"),label).toThrow(/unsupported schema keyword/);
  // The walk is eager: a document that would pass still cannot be validated by an unsupported file.
  expect(() => validateDocument({type:"object",properties:{never:{format:"email"}}},{})).toThrow(/unsupported schema keyword/);
});

test("each supported keyword reports the first violation with its JSON pointer",() => {
  const string = {type:"string"}, integer = {type:"integer"}, number = {type:"number"};
  ok(string,"x"); at(string,1,"",/expected string/); ok(integer,1); at(integer,1.5,"",/expected integer, found number/); at(integer,true,"",/expected integer, found boolean/); at(integer,Number.MAX_SAFE_INTEGER + 2,"",/found number/);
  ok(number,1); ok(number,1.5); at(number,"1","",/expected number, found string/); at({type:"boolean"},0,"",/found integer/); ok({type:"boolean"},false); ok({type:"null"},null); at({type:"null"},undefined,"",/value is missing/);
  ok({type:"object"},{}); at({type:"object"},[],"",/found array/); at({type:"object"},null,"",/found null/); ok({type:"array"},[]); at({type:"array"},{},"",/found object/);
  const object: JsonSchema = {type:"object",required:["a","b/c"],properties:{a:integer,"b/c":string,"d~e":string},additionalProperties:false};
  ok(object,{a:1,"b/c":"x"}); at(object,{a:1},"/b~1c",/required property is missing/); at(object,{a:"1","b/c":"x"},"/a",/expected integer/); at(object,{a:1,"b/c":"x","d~e":1},"/d~0e",/expected string/); at(object,{a:1,"b/c":"x",extra:1},"/extra",/unexpected property/);
  ok({type:"object",properties:{a:integer}},{a:1,anything:"open"});
  at({enum:["a","b"]},"c","",/enumerated/); ok({enum:["a",1]},1); at({enum:[1]},true,"",/enumerated/); at({enum:[true]},1,"",/enumerated/);
  ok({const:"hv-clips/1"},"hv-clips/1"); at({const:"hv-clips/1"},"hv-clips/2","",/must equal "hv-clips\/1"/); at({const:1},true,"",/must equal/);
  const pattern = {type:"string",pattern:"^[a-f0-9]{4}$"}; ok(pattern,"beef"); at(pattern,"BEEF","",/does not match/); at(pattern,"beef\n","",/does not match/); at(pattern,"xbeef","",/does not match/);
  const bounded = {type:"integer",minimum:0,maximum:10}; ok(bounded,0); ok(bounded,10); at(bounded,-1,"",/less than 0/); at(bounded,11,"",/greater than 10/);
  const length = {type:"string",minLength:1,maxLength:3}; ok(length,"abc"); at(length,"","",/shorter than 1/); at(length,"abcd","",/longer than 3/); ok(length,"\u{1F3AC}\u{1F3AC}\u{1F3AC}");
  const array: JsonSchema = {type:"array",minItems:1,maxItems:2,uniqueItems:true,items:integer}; ok(array,[1,2]); at(array,[],"",/fewer than 1/); at(array,[1,2,3],"",/more than 2/); at(array,[1,1],"/1",/duplicate/); at(array,[1,"2"],"/1",/expected integer/);
  at({type:"array",uniqueItems:true},[{a:1,b:2},{b:2,a:1}],"/1",/duplicate/); ok({type:"array",uniqueItems:true},[1,true,"1",1.5]);
  const ref: JsonSchema = {type:"object",properties:{digest:{$ref:"#/$defs/sha256"},list:{type:"array",items:{$ref:"#/$defs/sha256",maxLength:64}}},$defs:{sha256:{type:"string",pattern:"^[a-f0-9]{64}$"}}};
  ok(ref,{digest:"a".repeat(64),list:["b".repeat(64)]}); at(ref,{digest:"A".repeat(64)},"/digest",/does not match/); at(ref,{list:[1]},"/list/0",/expected string/); at(ref,{list:["a".repeat(63)]},"/list/0",/does not match/);
  expect(validateDocument(integer,"x","/nested/2")).toEqual({ok:false,pointer:"/nested/2",reason:"expected integer, found string"});
  expect(() => assertArchiveDocument("hv-clips/1",{schema:"hv-clips/1",clips:[{}]})).toThrow("archive schema violation: /clips/0/path: required property is missing");
  expect(assertArchiveDocument("hv-clips/1",{schema:"hv-clips/1",clips:[]})).toEqual({schema:"hv-clips/1",clips:[]});
});

test("own properties whose value is undefined are absent, as JSON.stringify would make them",() => {
  const string = {type:"string"}, integer = {type:"integer"};
  // Writers build the hv-clips/1 object in memory before serializing it; a clip without a poster or audio
  // role carries `posterPath: undefined`, which JSON drops and the validator must treat the same way.
  const clip = {path:"p/j/clips/shot-1.mp4",provider:"mock",model:"mock-deterministic-v1",seed:1,durationSec:1,fingerprint:"f".repeat(64),cost:{provider:"mock",model:"mock-deterministic-v1",prompt_tokens:1,output_frames:30,gpu_seconds:0.5,total_cost_usd:0}};
  const bare = {...clip,audioPath:undefined,posterPath:undefined,sourcePosterPath:undefined};
  ok(loadArchiveSchema("hv-clips/1"),{schema:"hv-clips/1",clips:[bare]}); expect(assertArchiveDocument("hv-clips/1",{schema:"hv-clips/1",clips:[bare]}).clips[0]).toBe(bare);
  expect(validateDocument(loadArchiveSchema("hv-clips/1"),{schema:undefined,clips:[]})).toEqual({ok:false,pointer:"/schema",reason:"required property is missing"});
  expect(validateDocument({const:"x"},undefined)).toEqual({ok:false,pointer:"",reason:"value is missing"}); expect(validateDocument({enum:["x"]},undefined)).toEqual({ok:false,pointer:"",reason:"value is missing"});
  at({type:"object",required:["a"]},{a:undefined},"/a",/required property is missing/); ok({type:"object",properties:{a:integer},additionalProperties:false},{extra:undefined});
  ok({type:"object",properties:{a:integer}},{a:undefined,b:1}); at({type:"array",items:string},[undefined],"/0",/value is missing/); expect(canonicalJson({b:undefined,a:1,c:[undefined]})).toBe('{"a":1,"c":[null]}');
  // The shared builder used by checkpoint, importCompletedJob and exportProjectArchive omits absent roles and validates.
  const built = clipsManifest([bare,{...clip,path:"/cache/p/j/clips/shot-2.mp4",posterPath:"/cache/p/j/clips/shot-2.png"}],path => path.replace(/^\/cache\//,""));
  expect(built as unknown).toEqual({schema:"hv-clips/1",clips:[clip,{...clip,path:"p/j/clips/shot-2.mp4",posterPath:"p/j/clips/shot-2.png"}]});
  expect(Object.keys(built.clips[0]!)).not.toContain("audioPath"); expect(JSON.parse(JSON.stringify(built))).toEqual(built); ok(loadArchiveSchema("hv-clips/1"),JSON.parse(JSON.stringify(built)));
  expect(() => clipsManifest([{...bare,seed:-1}],path => path)).toThrow("archive schema violation: /clips/0/seed: number is less than 0");
});

test("schema constants equal the reader limits and the state schema union cannot drift",() => {
  const archive = loadArchiveSchema("hv-project-archive/1") as any, state = loadArchiveSchema("hv-state/1") as any;
  expect(archive.properties.files.maxItems).toBe(ARCHIVE_LIMITS.maxFiles); expect(archive.$defs.file.properties.bytes.maximum).toBe(ARCHIVE_LIMITS.maxFileBytes); expect(archive.properties.totalBytes.maximum).toBe(ARCHIVE_LIMITS.maxTotalBytes);
  expect(ARCHIVE_LIMITS).toEqual({maxFiles:100000,maxFileBytes:8589934592,maxTotalBytes:68719476736,maxManifestBytes:8388608,maxStateFileBytes:268435456,maxCompressionRatio:200});
  expect(archive.properties.schema.const).toBe("hv-project-archive/1"); expect(archive.properties.projectId.pattern).toBe("^[A-Za-z0-9_-]{1,128}$"); expect(archive.$defs.file.properties.sha256.pattern).toBe("^[a-f0-9]{64}$");
  expect(archive.$defs.file.properties.path.maxLength).toBe(1024); expect(archive.$defs.file.additionalProperties).toBe(false); expect(archive.$defs.file.required).toEqual(["path","bytes","sha256"]); expect(archive.$defs.file.properties.bytes.minimum).toBe(0); expect(archive.properties.totalBytes.minimum).toBe(0);
  expect(state.properties.schema.enum).toEqual([...STATE_SNAPSHOT_SCHEMAS]); expect([...STATE_SNAPSHOT_SCHEMAS] as string[]).toEqual(Array.from({length:13},(_,index) => `hv-state/${index + 1}`));
  expect(state.properties.files.required).toEqual(["state/projects.json","queue/jobs.json","state/cost-ledger.json","state/operator-review-queue.json"]); expect(state.properties.files.additionalProperties).toBe(false); expect(state.properties.summary.additionalProperties).toBe(false);
  expect((loadArchiveSchema("hv-clips/1") as any).properties.schema.const).toBe("hv-clips/1"); expect((loadArchiveSchema("hv-clips/1") as any).$defs.clip.additionalProperties).toBeUndefined();
  const golden = readStateSnapshot(GOLDEN_SOURCE);
  for (const lipSync of [false,true]) expect(STATE_SNAPSHOT_SCHEMAS).toContain(stateSnapshotSchema(golden.projects,golden.jobs,lipSync));
  expect(stateSnapshotSchema(golden.projects,golden.jobs)).toBe("hv-state/1"); expect(stateSnapshotSchema(golden.projects,golden.jobs,true)).toBe("hv-state/2");
  for (const version of STATE_SNAPSHOT_SCHEMAS) expect(validateSnapshot({...golden,schema:version})).toBeTruthy();
  expect(() => validateSnapshot({...golden,schema:"hv-state/14" as StateSnapshot["schema"]})).toThrow("unsupported state snapshot");
  expect(validateDocument(state,{schema:"hv-state/14",files:{}})).toEqual({ok:false,pointer:"/schema",reason:"value is not one of the enumerated values"});
  const root = mkdtempSync(join(tmpdir(),"hv-archive-schema-state-"));
  try {
    cpSync(GOLDEN_SOURCE,join(root,"copy"),{recursive:true}); const manifest = join(root,"copy/snapshot.json");
    writeFileSync(manifest,JSON.stringify({...JSON.parse(readFileSync(manifest,"utf8")),schema:"hv-state/14"}));
    expect(() => readStateSnapshot(join(root,"copy"))).toThrow("archive schema violation: /schema: value is not one of the enumerated values");
  } finally { rmSync(root,{recursive:true,force:true}); }
});

pytest("the Python module constants and accepted state list equal the schema numbers",() => {
  const result = Bun.spawnSync([python!,"-c","import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('archive_package',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\nprint(json.dumps({'MAX_FILES':module.MAX_FILES,'MAX_FILE_BYTES':module.MAX_FILE_BYTES,'MAX_TOTAL_BYTES':module.MAX_TOTAL_BYTES,'MAX_MANIFEST_BYTES':module.MAX_MANIFEST_BYTES,'MAX_STATE_FILE_BYTES':module.MAX_STATE_FILE_BYTES,'STATE_SCHEMAS':list(module.STATE_SCHEMAS),'SCHEMA_FILES':module.SCHEMA_FILES}))",resolve(import.meta.dir,"../../../scripts/archive-package.py")],{stdout:"pipe",stderr:"pipe"});
  expect(result.stderr.toString()).toBe(""); expect(result.exitCode).toBe(0);
  const constants = JSON.parse(result.stdout.toString());
  expect(constants).toEqual({MAX_FILES:ARCHIVE_LIMITS.maxFiles,MAX_FILE_BYTES:ARCHIVE_LIMITS.maxFileBytes,MAX_TOTAL_BYTES:ARCHIVE_LIMITS.maxTotalBytes,MAX_MANIFEST_BYTES:ARCHIVE_LIMITS.maxManifestBytes,MAX_STATE_FILE_BYTES:ARCHIVE_LIMITS.maxStateFileBytes,STATE_SCHEMAS:[...STATE_SNAPSHOT_SCHEMAS],SCHEMA_FILES:ARCHIVE_SCHEMA_FILES});
});

test("the rejection matrix is refused by the validator, by readStateSnapshot and before any upload in importCompletedJob",async () => {
  const rows = rejectionRows(); expect(rows.length).toBeGreaterThanOrEqual(33);
  for (const name of NAMES) ok(loadArchiveSchema(name),goldenDocument(name));
  for (const row of rows) { const result = validateDocument(loadArchiveSchema(row.document),mutate(goldenDocument(row.document),row)); expect([row.name,result.ok ? "accepted" : result.pointer]).toEqual([row.name,row.expect]); }
  expect(rows.map(row => row.document)).toEqual(expect.arrayContaining(NAMES));
  const receipt = goldenReceipt(), jobId = goldenJobId(receipt.projectId), root = mkdtempSync(join(tmpdir(),"hv-archive-schema-matrix-"));
  try {
    for (const row of rows.filter(row => row.document === "hv-state/1")) {
      const copy = join(root,"state-" + rows.indexOf(row)); cpSync(GOLDEN_SOURCE,copy,{recursive:true});
      writeFileSync(join(copy,"snapshot.json"),JSON.stringify(mutate(goldenDocument("hv-state/1"),row)));
      expect(() => readStateSnapshot(copy),row.name).toThrow("archive schema violation: " + row.expect + ":");
    }
    // A stub store: the migration role answers, but any upload or database write is a test failure.
    let uploads = 0, writes = 0;
    const sql = Object.assign(async () => [{role:"hv_admin"}],{}), database = {sql,forProject:async () => { writes++; throw new Error("database write attempted"); }};
    const client = {file:() => { uploads++; throw new Error("upload attempted"); }};
    const cache = join(root,"cache"), key = `${receipt.projectId}/${jobId}/clips/manifest.json`, manifestPath = join(cache,key), clipPath = join(cache,receipt.projectId,jobId,"clips/shot-1.mp4");
    mkdirSync(join(cache,receipt.projectId,jobId,"clips"),{recursive:true}); cpSync(goldenClipsManifestPath().replace("manifest.json","shot-1.mp4"),clipPath);
    const store = new PostgresArtifactStore(database as any,cache,client as any);
    const job = {id:jobId,projectId:receipt.projectId,status:"done",stage:"animatic",checkpointShots:1,checkpointFrame:30,tier:"free",idempotencyKey:"golden",scriptVersion:1,scriptText:"",notifications:[]} as unknown as Job;
    for (const row of rows.filter(row => row.document === "hv-clips/1")) {
      writeFileSync(manifestPath,JSON.stringify(mutate(goldenDocument("hv-clips/1"),row)));
      await expect(store.importCompletedJob(job,[clipPath,manifestPath]),row.name).rejects.toThrow("archive schema violation: " + row.expect + ":");
    }
    expect(uploads).toBe(0); expect(writes).toBe(0);
    // The unmodified golden manifest passes the contract and the import reaches its first (stubbed) upload; the legacy bare-array local form is accepted without a schema check.
    writeFileSync(manifestPath,readFileSync(goldenClipsManifestPath()));
    await expect(store.importCompletedJob(job,[clipPath,manifestPath])).rejects.toThrow("upload attempted"); expect(uploads).toBe(1);
    writeFileSync(manifestPath,JSON.stringify([{path:clipPath}]));
    await expect(store.importCompletedJob(job,[clipPath,manifestPath])).rejects.toThrow("upload attempted"); expect(uploads).toBe(2); expect(writes).toBe(0);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
