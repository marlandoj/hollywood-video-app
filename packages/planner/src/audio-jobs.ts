import {AZURE_AUDIO_MODEL,AZURE_VOICES} from "../../generator/src/azure-capability";
import {ELEVENLABS_MAX_LINE_CHARACTERS,ELEVENLABS_MODEL,ELEVENLABS_VOICE_ID} from "../../generator/src/elevenlabs-capability";
import type {Job, JobInput} from "../../queue/src/index";
import type {PersistedProject} from "../../api/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {CARTESIA_MODEL, audioCapability} from "../../generator/src/audio-capabilities";
import {validateAudioDelivery, type AudioLineDelivery} from "../../generator/src/audio-delivery";
import {audioHash, audioNumber, audioRecord, audioText, validateAudioLinePlan, type AudioLinePlan} from "./audio-performances";
import {lineSources} from "./performances";
import {assertCurrentCastPermission, currentCasting, validateCasting} from "./casting";
import {parseFountain} from "../../parser/src/index";
import type {RenderFile} from "./shot-reuse";
import {performanceForScene} from "./performance-memory";
import {audioLanguage,type AudioLanguage} from "../../generator/src/audio-languages";
import {validateNarrationRead,narrationLineSource,type NarrationRead} from "./narration-read";

export class AudioJobError extends Error {override name = "AudioJobError";}
export interface AudioPolicyInput {
  provider?:"cartesia"|"azure"|"elevenlabs";
  languages?:AudioLanguage[];
  /** HV-022-09: the voice's sex as the vendor's own catalogue states it, for casting. */
  sex?:"female"|"male"|"neutral";
  voiceId: string; label: string; accountRevision: string; catalogueRevision: string;
  licenceEvidenceSha256: string; priceEvidenceSha256: string;
  heldUsd: number; maxCharacters: number; validFrom: string; expiresAt: string;
}
export interface AudioPolicy extends AudioPolicyInput {
  schema: "hv-audio-policy/1"|"hv-audio-policy/2"|"hv-audio-policy/3"|"hv-audio-policy/4"; provider: "cartesia"|"azure"|"elevenlabs"; model: string;
  permissionRevision: string; priceRevision: string; revision: string;
}
export interface AudioTakePlan {
  schema: "hv-audio-take/1"|"hv-audio-take/2"; sceneIndex: number; characterId: string; narration?:NarrationRead;
  line: AudioLinePlan; policy: AudioPolicy; admittedAt: string; storage: "local" | "s3"; requestHash:string; revision: string;
}
export interface AudioTakeOutput {
  schema: "hv-audio-take-output/1"; report: AudioLineDelivery; wavPath: string; manifestPath: string;
  files: RenderFile[]; revision: string;
}
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
function fail(s: string): never {throw new AudioJobError(s);}
function date(v: unknown): string {if (typeof v !== "string" || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail("Use a canonical audio policy date."); return v;}

/** Trusted operator configuration, never a policy accepted from an owner request.
 * Evidence hashes identify reviewed records; they are not proof by themselves. */
export function audioPolicy(input: AudioPolicyInput): AudioPolicy {
  audioRecord(input, ["provider", "voiceId", "label", "accountRevision", "catalogueRevision", "licenceEvidenceSha256", "priceEvidenceSha256", "heldUsd", "maxCharacters", "validFrom", "expiresAt", "languages", "sex"]);
  // HV-022-07: the second production vendor's catalogue. Its voice IDs are the service's own
  // twenty-character ids, not UUIDs, and its model is the one the capability pins.
  const native=input.provider==="azure",eleven=input.provider==="elevenlabs";
  const provider=native?"azure" as const:eleven?"elevenlabs" as const:"cartesia" as const;
  const model=native?AZURE_AUDIO_MODEL:eleven?ELEVENLABS_MODEL:CARTESIA_MODEL;
  if(input.provider!==undefined&&!["cartesia","azure","elevenlabs"].includes(input.provider)
    ||!(native?AZURE_VOICES.includes(input.voiceId as typeof AZURE_VOICES[number]):eleven?ELEVENLABS_VOICE_ID.test(input.voiceId):uuid(input.voiceId))) fail("Choose a supported catalogue voice ID.");
  const label = audioText(input.label, 100, "voice label").trim(); if (!label) fail("Name the catalogue voice.");
  if(input.languages!==undefined&&(native||eleven||!Array.isArray(input.languages)||!input.languages.length||input.languages.length>44||new Set(input.languages).size!==input.languages.length))fail("Authorize a distinct supported language list for a Cartesia catalogue voice.");
  const languages=input.languages?.map(audioLanguage).sort();
  // Only the second vendor's catalogue carries a stated sex, and only from its account's own labels.
  if(input.sex!==undefined&&(!eleven||!["female","male","neutral"].includes(input.sex)))fail("A voice's stated sex comes from the vendor's own catalogue.");
  const data = {voiceId: input.voiceId, label,...(languages?{languages}:{}),...(input.sex?{sex:input.sex}:{}), accountRevision: audioHash(input.accountRevision), catalogueRevision: audioHash(input.catalogueRevision),
    licenceEvidenceSha256: audioHash(input.licenceEvidenceSha256), priceEvidenceSha256: audioHash(input.priceEvidenceSha256),
    heldUsd: audioNumber(input.heldUsd, .000001, 1000000, "Audio reservation"), maxCharacters: audioNumber(input.maxCharacters, 1, eleven?ELEVENLABS_MAX_LINE_CHARACTERS:20000, "Maximum spoken characters", true),
    validFrom: date(input.validFrom), expiresAt: date(input.expiresAt)};
  if (data.heldUsd !== Number(data.heldUsd.toFixed(6)) || Date.parse(data.validFrom) >= Date.parse(data.expiresAt)) fail("Invalid audio policy price or validity window.");
  const permissionRevision = contentHash({provider, voiceId: data.voiceId, accountRevision: data.accountRevision,
    catalogueRevision: data.catalogueRevision, licenceEvidenceSha256: data.licenceEvidenceSha256, validFrom: data.validFrom, expiresAt: data.expiresAt,...(languages?{languages}:{}),...(input.sex?{sex:input.sex}:{})});
  const priceRevision = contentHash({provider, model, accountRevision: data.accountRevision,
    priceEvidenceSha256: data.priceEvidenceSha256, heldUsd: data.heldUsd, maxCharacters: data.maxCharacters, validFrom: data.validFrom, expiresAt: data.expiresAt});
  const result = {schema: native?"hv-audio-policy/2" as const:eleven?"hv-audio-policy/4" as const:languages?"hv-audio-policy/3" as const:"hv-audio-policy/1" as const, provider, model, ...data, permissionRevision, priceRevision};
  return {...result, revision: contentHash(result)};
}
export function validateAudioPolicy(policy: AudioPolicy, now?: number): AudioPolicy {
  audioRecord(policy, ["schema", "provider", "model", "voiceId", "label", "accountRevision", "catalogueRevision", "licenceEvidenceSha256", "priceEvidenceSha256", "heldUsd", "maxCharacters", "validFrom", "expiresAt", "permissionRevision", "priceRevision", "revision",...(policy.schema==="hv-audio-policy/3"?["languages"]:[]),...(policy.schema==="hv-audio-policy/4"?["sex"]:[])]);
  const {schema: _schema, provider: _provider, model: _model, permissionRevision: _permission, priceRevision: _price, revision: _revision, ...input} = policy;
  const valid = audioPolicy({...input,...(_provider==="cartesia"?{}:{provider:_provider})});
  if (contentHash(valid) !== contentHash(policy)) fail("The audio policy evidence changed.");
  if (now !== undefined && (!Number.isFinite(now) || now < Date.parse(valid.validFrom) || now >= Date.parse(valid.expiresAt))) fail("The audio policy is not currently valid.");
  return valid;
}
export function audioTakePlan(sceneIndex: number, characterId: string, line: AudioLinePlan, policy: AudioPolicy, storage: AudioTakePlan["storage"], now = Date.now(),requestHash?:string,narration?:NarrationRead): AudioTakePlan {
  const checked = validateAudioPolicy(policy, now), compiled = validateAudioLinePlan(line);
  if (!uuid(characterId) || !["local", "s3"].includes(storage)) fail("Invalid audio audition context.");
  const voice = compiled.profile.voice;
  if(!(checked.languages??["en"]).includes(compiled.profile.language)||compiled.localization&&!checked.languages)fail("This voice policy does not authorize reviewed dubbing in the selected language.");
  if (compiled.profile.provider!==checked.provider || audioCapability(compiled.capabilityRevision)?.model!==checked.model || voice.id !== checked.voiceId || voice.catalogueRevision !== checked.catalogueRevision || voice.permissionRevision !== checked.permissionRevision
    || (compiled.providerTranscript??compiled.spokenText).length > checked.maxCharacters || !audioCapability(compiled.capabilityRevision)) fail("The line does not match its authorized voice and price policy.");
  if(narration){validateNarrationRead(narration);if(contentHash(narrationLineSource(narration,compiled.source.character))!==contentHash(compiled.source))fail("The audition differs from its reviewed narration text.");}
  const data = {schema: narration?"hv-audio-take/2" as const:"hv-audio-take/1" as const, sceneIndex: audioNumber(sceneIndex, 0, 999, "Audio scene", true), characterId,...(narration?{narration:structuredClone(narration)}:{}),
    line: compiled, policy: checked, storage, admittedAt: new Date(now).toISOString(),requestHash:audioHash(requestHash??contentHash({sceneIndex,characterId,line:compiled.revision,policy:checked.revision,storage,...(narration?{narration:narration.revision}:{})}))};
  return {...data, revision: contentHash(data)};
}
export function validateAudioTake(job: Pick<Job, "stage" | "audioTake" | "audioCheckpoint" | "audioOutput" | "output" | "scriptText" | "scriptVersion" | "casting" | "direction" | "shotReuse" | "shotTakes" | "characterSheet" | "dialogueReplacement" | "dialogueCheckpoint" | "providerSpec" | "providerPlan" | "costCapUsd" | "budgetReservedUsd" | "totalFrames" | "retryPolicy" | "projectId" | "rightsAttestedAt">): void {
  if ((job.stage === "audio-take") !== Boolean(job.audioTake)) fail("Audio auditions need their own admitted plan.");
  if (!job.audioTake) {if (job.audioCheckpoint || job.audioOutput) fail("A film job cannot carry audio audition exports."); return;}
  const take = job.audioTake;
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(job.projectId))fail("Invalid audio project identity.");
  audioRecord(take, ["schema", "sceneIndex", "characterId", "line", "policy", "storage", "admittedAt", "requestHash", "revision",...(take.schema==="hv-audio-take/2"?["narration"]:[])]);
  const valid = audioTakePlan(take.sceneIndex, take.characterId, take.line, take.policy, take.storage, Date.parse(date(take.admittedAt)),take.requestHash,take.narration);
  if (contentHash(valid) !== contentHash(take) || !job.casting || !job.rightsAttestedAt || !Number.isInteger(job.scriptVersion) || job.scriptVersion < 1
    || job.direction || job.shotReuse || job.shotTakes || job.characterSheet || job.dialogueReplacement || job.dialogueCheckpoint || job.providerSpec || job.providerPlan || job.output
    || job.totalFrames !== 0 || job.costCapUsd !== take.policy.heldUsd || job.budgetReservedUsd !== take.policy.heldUsd || job.retryPolicy.maxRetries !== 0)
    fail("Invalid isolated audio audition job.");
  validateCasting(job.casting, job.projectId);
  const parsed = parseFountain(job.scriptText), scene = parsed.scenes[take.sceneIndex], character = job.casting.characters.find(c => c.id === take.characterId);
  const source = scene && (take.narration&&character?narrationLineSource(take.narration,character.name):lineSources(scene.dialogue)[take.line.source.index]);
  if (!source || contentHash(source) !== contentHash(take.line.source) || !character
    || ![character.name, ...character.aliases].some(name => name.toLocaleUpperCase("en-US") === source.character.toLocaleUpperCase("en-US"))) fail("The audition no longer matches its screenplay character and line.");
  if(contentHash(performanceForScene(character,scene!)??null)!==contentHash(take.line.memory??null))fail("The audition's saved scene performance does not match its admitted cast.");
}
/** Admission only: retained takes keep the original scene intent after later edits. */
export function assertAudioTakeMemoryCurrent(job:JobInput,project:PersistedProject):void{
  const take=job.audioTake!,scene=parseFountain(job.scriptText).scenes[take.sceneIndex],character=currentCasting(project.id,project.castingHistory).characters.find(c=>c.id===take.characterId);
  if(!scene||!character||contentHash(performanceForScene(character,scene)??null)!==contentHash(take.line.memory??null))fail("Scene performance changed. Reload and review the audition again.");
}
export function assertAudioTakeIdempotency(existing: Job | undefined, input: JobInput): void {
  if (existing && (existing.audioTake || input.audioTake || existing.stage === "audio-take" || input.stage === "audio-take")
    && (existing.stage !== input.stage || existing.audioTake?.requestHash !== input.audioTake?.requestHash || existing.audioTake?.line.revision!==input.audioTake?.line.revision
      ||existing.audioTake?.narration?.revision!==input.audioTake?.narration?.revision||existing.audioTake?.policy.revision!==input.audioTake?.policy.revision||existing.audioTake?.sceneIndex!==input.audioTake?.sceneIndex||existing.audioTake?.characterId!==input.audioTake?.characterId||existing.scriptText !== input.scriptText || existing.scriptVersion !== input.scriptVersion))
    fail("The idempotency key belongs to another audio audition.");
}
export function assertAudioTakePermission(job: Job | JobInput, project: PersistedProject | undefined, now = Date.now(), requireCurrentScript = true): void {
  validateAudioTake(job); const take = job.audioTake!;
  if (!project || project.id !== job.projectId || !project.rightsAttestedAt || !Number.isFinite(Date.parse(project.deleteAfter)) || Date.parse(project.deleteAfter) <= now) fail("Current audio project permission is unavailable.");
  if (requireCurrentScript && (project.versions.at(-1)?.version !== job.scriptVersion || project.versions.at(-1)?.text !== job.scriptText)) fail("The screenplay changed before the audition finished.");
  const scene = parseFountain(job.scriptText).scenes[take.sceneIndex]!;
  assertCurrentCastPermission(job.casting!, currentCasting(project.id, project.castingHistory), [take.characterId], take.sceneIndex + 1, now, scene.heading);
}
export function validateAudioTakeOutput(job: Job | JobInput, output: AudioTakeOutput): void {
  validateAudioTake(job); audioRecord(output, ["schema", "report", "wavPath", "manifestPath", "files", "revision"]);
  validateAudioDelivery(output.report);
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(job.id))fail("Invalid audio job identity.");
  const prefix = `${job.projectId}/${job.id}/audio-${output.report.attemptId}/`;
  if (output.schema !== "hv-audio-take-output/1" || output.wavPath !== prefix + "line.wav" || output.manifestPath !== prefix + "performance.json"
    || output.report.plan.revision !== job.audioTake!.line.revision || !Array.isArray(output.files) || output.files.length !== 2) fail("Invalid owned audio audition output.");
  for (const path of [output.wavPath, output.manifestPath]) {
    const file = output.files.find(f => f.path === path); if (!file) fail("The audition is missing its owned media.");
    audioRecord(file, ["path", "sha256", "bytes"]); audioHash(file.sha256); audioNumber(file.bytes, 1, 128 * 1024 ** 2, "Audio artifact bytes", true);
  }
  if (output.files.find(f => f.path === output.wavPath)!.bytes !== 44 + output.report.totalSamples * 2) fail("Audio WAV size does not match its performance.");
  const {revision, ...data} = output; if (audioHash(revision) !== contentHash(data)) fail("The audio export metadata changed.");
}
