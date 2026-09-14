import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** In-repo archive contracts (docs/PROJECT-ARCHIVE.md "Schema files"). The three JSON Schema
 * files in ../schemas are validated with the bounded keyword subset below, mirrored keyword for
 * keyword by validate_document in scripts/archive-package.py. Anything outside the subset throws
 * "unsupported schema keyword" so the files cannot outgrow either validator. Nothing here is
 * published: the $id values are URNs and internet publication is HV-033 work behind gate G7. */
export const ARCHIVE_LIMITS = {maxFiles:100000,maxFileBytes:8*1024**3,maxTotalBytes:64*1024**3,maxManifestBytes:8*1024**2,maxStateFileBytes:256*1024**2,maxCompressionRatio:200} as const;
export const STATE_SNAPSHOT_SCHEMAS = ["hv-state/1","hv-state/2","hv-state/3","hv-state/4","hv-state/5","hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13"] as const;
export type StateSnapshotSchema = (typeof STATE_SNAPSHOT_SCHEMAS)[number];
export const ARCHIVE_SCHEMA_FILES = {"hv-project-archive/1":"hv-project-archive.1.schema.json","hv-state/1":"hv-state.1.schema.json","hv-clips/1":"hv-clips.1.schema.json"} as const;
export type ArchiveSchemaName = keyof typeof ARCHIVE_SCHEMA_FILES;
export const ARCHIVE_SCHEMA_DIRECTORY = resolve(import.meta.dir,"../schemas");
export type JsonSchema = Record<string,unknown>;
export type ValidationResult = {ok:true}|{ok:false;pointer:string;reason:string};

const KEYWORDS = new Set(["type","required","properties","additionalProperties","enum","const","pattern","minimum","maximum","minLength","maxLength","items","minItems","maxItems","uniqueItems","$ref"]);
const ANNOTATIONS = new Set(["$schema","$id","$defs","title","description","$comment","examples"]);
const TYPES = new Set(["object","array","string","integer","number","boolean","null"]);
const loaded = new Map<ArchiveSchemaName,{bytes:Buffer;schema:JsonSchema}>();
const checked = new WeakSet<object>();

function unsupported(detail: string): never { throw new Error("unsupported schema keyword: " + detail); }
function isObject(value: unknown): value is Record<string,unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** RFC 6901 token escaping so both languages spell "/files/state~1projects.json" identically. */
const token = (key: string | number): string => String(key).replaceAll("~","~0").replaceAll("/","~1");
const ascii = (text: string): string => text.replace(/[^\x00-\x7f]/g,character => "\\u" + character.charCodeAt(0).toString(16).padStart(4,"0"));
/** Python json.dumps(value,sort_keys=True,separators=(",",":")) with ensure_ascii: sorted keys, no
 * whitespace, non-ASCII escaped. Integers and ASCII strings serialize identically in both languages. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (isObject(value)) return "{" + Object.keys(value).sort().map(key => ascii(JSON.stringify(key)) + ":" + canonicalJson(value[key])).join(",") + "}";
  if (typeof value === "string") return ascii(JSON.stringify(value));
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonical JSON cannot encode a non-finite number");
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error("canonical JSON cannot encode this value");
  return JSON.stringify(value);
}
export function canonicalManifestBytes(value: unknown): Buffer { return Buffer.from(canonicalJson(value),"utf8"); }

/** Eager walk: every keyword anywhere in the file must be in the subset, whether or not a given
 * document reaches it. `type` is one of the seven names, `additionalProperties` is a boolean and
 * `$ref` is a local "#/$defs/<name>" that exists. */
function assertSupported(node: unknown, root: JsonSchema, path: string): void {
  if (!isObject(node)) unsupported("schema at " + (path || "/") + " must be an object");
  for (const key of Object.keys(node)) {
    if (ANNOTATIONS.has(key)) continue;
    if (!KEYWORDS.has(key)) unsupported(key + " at " + (path || "/"));
    const value = node[key];
    if (key === "type" && (typeof value !== "string" || !TYPES.has(value))) unsupported("type " + JSON.stringify(value));
    if (key === "additionalProperties" && typeof value !== "boolean") unsupported("non-boolean additionalProperties");
    if (key === "required" && (!Array.isArray(value) || value.some(item => typeof item !== "string"))) unsupported("required must list property names");
    if (key === "enum" && !Array.isArray(value)) unsupported("enum must be an array");
    if (key === "pattern" && (typeof value !== "string" || !value.startsWith("^") || !value.endsWith("$"))) unsupported("unanchored pattern");
    if (["minimum","maximum","minLength","maxLength","minItems","maxItems"].includes(key) && typeof value !== "number") unsupported(key + " must be a number");
    if (key === "uniqueItems" && typeof value !== "boolean") unsupported("non-boolean uniqueItems");
    if (key === "$ref") {
      const match = typeof value === "string" ? /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(value) : null;
      if (!match || !isObject(root.$defs) || !isObject(root.$defs[match[1]!])) unsupported("$ref " + JSON.stringify(value));
    }
    if (key === "properties") { if (!isObject(value)) unsupported("properties must be an object"); for (const name of Object.keys(value)) assertSupported(value[name],root,path + "/properties/" + token(name)); }
    if (key === "items") assertSupported(value,root,path + "/items");
  }
  if (path === "" && node.$defs !== undefined) { if (!isObject(node.$defs)) unsupported("$defs must be an object"); for (const name of Object.keys(node.$defs)) assertSupported(node.$defs[name],root,"/$defs/" + token(name)); }
}
const kind = (value: unknown): string => value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" ? (Number.isSafeInteger(value) ? "integer" : "number") : typeof value === "object" ? "object" : typeof value;
function check(node: JsonSchema, root: JsonSchema, value: unknown, pointer: string): ValidationResult {
  const fail = (reason: string, at = pointer): ValidationResult => ({ok:false,pointer:at,reason});
  if (typeof node.$ref === "string") { const target = (root.$defs as Record<string,JsonSchema>)[node.$ref.slice("#/$defs/".length)]!; const inner = check(target,root,value,pointer); if (!inner.ok) return inner; }
  if (typeof node.type === "string") {
    const actual = kind(value);
    if (!(actual === node.type || (node.type === "number" && actual === "integer"))) return fail("expected " + node.type + ", found " + actual);
  }
  if (Array.isArray(node.enum)) { const canonical = canonicalJson(value); if (!node.enum.some(option => canonicalJson(option) === canonical)) return fail("value is not one of the enumerated values"); }
  if (Object.hasOwn(node,"const") && canonicalJson(value) !== canonicalJson(node.const)) return fail("value must equal " + canonicalJson(node.const));
  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (typeof node.minLength === "number" && length < node.minLength) return fail("string is shorter than " + node.minLength);
    if (typeof node.maxLength === "number" && length > node.maxLength) return fail("string is longer than " + node.maxLength);
    if (typeof node.pattern === "string" && !new RegExp(node.pattern).test(value)) return fail("string does not match " + node.pattern);
  }
  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) return fail("number is less than " + node.minimum);
    if (typeof node.maximum === "number" && value > node.maximum) return fail("number is greater than " + node.maximum);
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) return fail("array has fewer than " + node.minItems + " items");
    if (typeof node.maxItems === "number" && value.length > node.maxItems) return fail("array has more than " + node.maxItems + " items");
    if (node.uniqueItems === true) { const seen = new Set<string>(); for (const [index,item] of value.entries()) { const canonical = canonicalJson(item); if (seen.has(canonical)) return fail("array item is a duplicate",pointer + "/" + index); seen.add(canonical); } }
    if (isObject(node.items)) for (const [index,item] of value.entries()) { const inner = check(node.items as JsonSchema,root,item,pointer + "/" + index); if (!inner.ok) return inner; }
  }
  if (isObject(value)) {
    if (Array.isArray(node.required)) for (const name of node.required as string[]) if (!Object.hasOwn(value,name)) return fail("required property is missing",pointer + "/" + token(name));
    const properties = isObject(node.properties) ? node.properties as Record<string,JsonSchema> : {};
    for (const name of Object.keys(properties)) if (Object.hasOwn(value,name)) { const inner = check(properties[name]!,root,value[name],pointer + "/" + token(name)); if (!inner.ok) return inner; }
    if (node.additionalProperties === false) for (const name of Object.keys(value)) if (!Object.hasOwn(properties,name)) return fail("unexpected property",pointer + "/" + token(name));
  }
  return {ok:true};
}
/** Validate `value` against a schema object using only the supported keyword subset. The whole
 * schema is checked for unsupported keywords first, so an unsupported file throws even when the
 * document would pass. Returns the first violation with its RFC 6901 pointer. */
export function validateDocument(schema: JsonSchema, value: unknown, pointer = ""): ValidationResult {
  ensureSupported(schema);
  return check(schema,schema,value,pointer);
}
function ensureSupported(schema: JsonSchema): void { if (!checked.has(schema)) { assertSupported(schema,schema,""); checked.add(schema); } }
export function loadArchiveSchema(name: ArchiveSchemaName): JsonSchema {
  const cached = loaded.get(name); if (cached) return cached.schema;
  const file = ARCHIVE_SCHEMA_FILES[name]; if (!file) throw new Error("unknown archive schema " + name);
  const bytes = readFileSync(resolve(ARCHIVE_SCHEMA_DIRECTORY,file)), schema = JSON.parse(bytes.toString("utf8")) as JsonSchema;
  if (!isObject(schema) || schema.$schema !== "https://json-schema.org/draft/2020-12/schema" || schema.$id !== "urn:hollywood-video:schema:" + name.replace("/",":")) throw new Error("archive schema file " + file + " does not declare the expected dialect and identity");
  ensureSupported(schema);
  loaded.set(name,{bytes,schema}); return schema;
}
export function archiveSchemaDigest(name: ArchiveSchemaName): {name: ArchiveSchemaName; id: string; sha256: string} {
  const schema = loadArchiveSchema(name);
  return {name,id:String(schema.$id),sha256:createHash("sha256").update(loaded.get(name)!.bytes).digest("hex")};
}
/** Throws "archive schema violation: <json-pointer>: <reason>", the same text the Python side raises. */
export function assertArchiveDocument<T>(name: ArchiveSchemaName, value: T): T {
  const result = validateDocument(loadArchiveSchema(name),value);
  if (!result.ok) throw new Error("archive schema violation: " + result.pointer + ": " + result.reason);
  return value;
}
