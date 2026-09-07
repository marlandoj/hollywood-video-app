import {AZURE_AUDIO_CAPABILITY,AZURE_VOICES,type AzureStyle} from "../../generator/src/azure-capability";
import {azureControls,azureTranscript} from "./azure-performance";
import {contentHash} from "../../generator/src/capabilities";
import {AUDIO_EMOTIONS, CARTESIA_AUDIO_CAPABILITY, CARTESIA_PHRASE_CAPABILITY, CARTESIA_MULTILINGUAL_CAPABILITY, type AudioEmotion} from "../../generator/src/audio-capabilities";
import {audioLanguage,type AudioLanguage} from "../../generator/src/audio-languages";
import {gateOrThrow} from "../../safety/src/index";
import {DEFAULT_VOICE, spokenText, voiceProfile, type LineSource} from "./performances";
import {validateScenePerformance,type ScenePerformance} from "./performance-memory";
import {audioPhrases,phraseTranscript,type AudioPhraseDirection} from "./audio-phrases";

export class AudioPerformanceError extends Error { override name = "AudioPerformanceError"; }
export interface AudioControls {speed: number; volume: number; emotion: AudioEmotion;style?:AzureStyle;intensity?:number}
export interface AudioVoiceProfile {
  schema: "hv-audio-voice/1"|"hv-audio-voice/2"|"hv-audio-voice/3";
  provider: "cartesia"|"azure";
  voice: {id: string; catalogueRevision: string; permissionRevision: string};
  language: AudioLanguage;
  controls: AudioControls;
  pronunciations: {word: string; say: string}[];
}
export interface AudioLineDirection {
  sourceHash: string;
  speed?: number;
  volume?: number;
  emotion?: AudioEmotion;
  style?:AzureStyle;intensity?:number;
  beforeMs?: number;
  afterMs?: number;
  notes?: string;
  phrases?: AudioPhraseDirection[];
  localization?: {language:AudioLanguage;text:string;sourceHash:string;reviewed:true};
}
export interface LocalizedAudioLine {schema:"hv-localized-line/1";language:AudioLanguage;text:string;sourceHash:string;review:"owner-reviewed";revision:string}
export interface AudioLinePlan {
  schema: "hv-audio-line/1" | "hv-audio-line/2" | "hv-audio-line/3" | "hv-audio-line/4" | "hv-audio-line/5";
  localization?: LocalizedAudioLine;
  memory?: ScenePerformance;
  phrases?: AudioPhraseDirection[];
  providerTranscript?: string;
  capabilityRevision: string;
  source: LineSource;
  profile: AudioVoiceProfile;
  spokenText: string;
  beforeMs: number;
  afterMs: number;
  notes: string;
  alignment: "words" | "words-and-phonemes";
  revision: string;
}

function fail(message: string): never { throw new AudioPerformanceError(message); }
export function audioRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)))
    fail("Use only supported audio performance fields; native emphasis, pitch and raw speech tags are unavailable in this adapter.");
  return value as Record<string, unknown>;
}
export function audioNumber(value: unknown, min: number, max: number, label: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    fail(`${label} must be ${integer ? "a whole number " : ""}from ${min} to ${max}.`);
  return value;
}
export function audioText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length > max || [...value].some(c => {
    const code = c.charCodeAt(0);
    return (code < 32 && ![9, 10, 13].includes(code)) || code === 127 || (c.length === 1 && code >= 0xd800 && code <= 0xdfff);
  }))
    fail(`Use valid ${label} text of at most ${max} characters.`);
  return value;
}
export function audioHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("Reload the current audio source, catalogue and permission revisions.");
  return value;
}
function controls(input: unknown): AudioControls {
  const v = audioRecord(input, ["speed", "volume", "emotion"]);
  if (!AUDIO_EMOTIONS.includes(v.emotion as AudioEmotion)) fail("Choose a supported English emotion direction.");
  return {speed: audioNumber(v.speed, .6, 1.5, "Speed"), volume: audioNumber(v.volume, .5, 2, "Volume"), emotion: v.emotion as AudioEmotion};
}
export function audioVoiceProfile(input: unknown): AudioVoiceProfile {
  const v = audioRecord(input, ["schema", "provider", "voice", "language", "controls", "pronunciations"]);
  const native=v.schema==="hv-audio-voice/2"&&v.provider==="azure",localized=v.schema==="hv-audio-voice/3"&&v.provider==="cartesia";
  if ((!native&&!localized&&(v.schema !== "hv-audio-voice/1" || v.provider !== "cartesia")) || !localized&&v.language !== "en")
    fail("Choose a supported voice and language contract.");
  const language=audioLanguage(v.language),effective=native?azureControls(v.controls):controls(v.controls);
  if(language!=="en"&&effective.emotion!=="neutral")fail("Explicit emotion controls are English-only. Choose neutral for a translated read; emotion will be omitted from its request.");
  const voice = audioRecord(v.voice, ["id", "catalogueRevision", "permissionRevision"]);
  if (typeof voice.id !== "string" || (native?!AZURE_VOICES.includes(voice.id as typeof AZURE_VOICES[number]):!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(voice.id)))
    fail("Choose a voice from the current authorized catalogue.");
  // Reuse the established plain pronunciation and safety rules, never eSpeak's
  // pitch/pace controls. This does not alter historical hv-speech/1 serialization.
  const pronunciations = voiceProfile({pronunciations: v.pronunciations ?? []}).pronunciations;
  return {schema: native?"hv-audio-voice/2":localized?"hv-audio-voice/3":"hv-audio-voice/1", provider: native?"azure":"cartesia", voice: {id: native?voice.id:voice.id.toLowerCase(),
    catalogueRevision: audioHash(voice.catalogueRevision), permissionRevision: audioHash(voice.permissionRevision)},
    language, controls: effective, pronunciations};
}
function sourceLine(input: unknown): LineSource {
  const v = audioRecord(input, ["index", "dialogueIndex", "lineIndex", "character", "text", "cues", "hash"]);
  if (!Array.isArray(v.cues) || v.cues.length > 128) fail("Reload the screenplay line's source cues.");
  const data = {index: audioNumber(v.index, 0, 127, "Line index", true), dialogueIndex: audioNumber(v.dialogueIndex, 0, 10000, "Dialogue index", true),
    lineIndex: audioNumber(v.lineIndex, 0, 10000, "Source line index", true), character: audioText(v.character, 1000, "character"),
    text: audioText(v.text, 20000, "dialogue"), cues: v.cues.map(c => audioText(c, 1000, "cue"))};
  if (!data.text.trim() || contentHash(data) !== audioHash(v.hash)) fail("The screenplay line changed. Review its direction again.");
  gateOrThrow([data.character, data.text, ...data.cues].join("\n"));
  return {...data, hash: v.hash as string};
}

/** Compile one audition or retake. Character defaults and line overrides are
 * flattened into an immutable effective profile; cues and notes are not spoken. */
export function compileAudioLine(source: LineSource, input: AudioVoiceProfile, direction?: AudioLineDirection,
  alignment?: AudioLinePlan["alignment"], memory?: ScenePerformance): AudioLinePlan {
  const current = sourceLine(source), profile = audioVoiceProfile(input),native=profile.provider==="azure";
  const localized=profile.schema==="hv-audio-voice/3";
  alignment??=native||localized?"words":"words-and-phonemes";
  if((native||localized)&&alignment!=="words")fail("This voice contract provides word boundaries, not phoneme alignment.");
  const intent=memory===undefined?undefined:validateScenePerformance(memory);
  const edit = audioRecord(direction ?? {sourceHash: current.hash}, ["sourceHash", "speed", "volume", "emotion", "beforeMs", "afterMs", "notes", "phrases",...(native?["style","intensity"]:[]),...(localized?["localization"]:[])]);
  if (audioHash(edit.sourceHash) !== current.hash) fail("The directed line changed. Reload its screenplay source.");
  if (!["words", "words-and-phonemes"].includes(alignment)) fail("Choose supported word or phoneme alignment.");
  profile.controls = (native?azureControls:controls)({...profile.controls,...intent?.controls, ...Object.fromEntries(["speed", "volume", "emotion",...(native?["style","intensity"]:[])].filter(k => edit[k] !== undefined).map(k => [k, edit[k]]))});
  if(profile.language!=="en"&&profile.controls.emotion!=="neutral")fail("Override the saved English emotion with neutral before reviewing this translated read.");
  let localization:LocalizedAudioLine|undefined;
  if(localized){const v=audioRecord(edit.localization,["language","text","sourceHash","reviewed"]),text=audioText(v.text,20000,"translated dialogue").trim();
    if(v.reviewed!==true||v.language!==profile.language||v.sourceHash!==current.hash||!text||/[<>]/.test(text))fail("Review the translation, target language and current source line before generating.");
    gateOrThrow(text);const data={schema:"hv-localized-line/1" as const,language:profile.language,text,sourceHash:current.hash,review:"owner-reviewed" as const};localization={...data,revision:contentHash(data)};}
  const spokenSource=localization?{...current,text:localization.text}:current;
  const notes = audioText(edit.notes ?? intent?.notes ?? "", 600, "direction").trim(); gateOrThrow(notes);
  const spoken = spokenText({source: spokenSource, voice: {...DEFAULT_VOICE, pronunciations: profile.pronunciations}, beforeMs: 0, afterMs: 0, notes});
  if (!spoken.trim() || spoken.length > 20000 || /[<>]/.test(spoken)) fail("Use plain dialogue without speech tags, with at most 20000 characters after pronunciation replacements.");
  const phrases=audioPhrases(spokenSource.text,edit.phrases??[],native),providerTranscript=native?azureTranscript(current,profile,phrases):phrases.length?phraseTranscript({source:spokenSource,voice:{...DEFAULT_VOICE,pronunciations:profile.pronunciations},beforeMs:0,afterMs:0,notes},profile.controls,phrases):localized?spoken:undefined;
  if(providerTranscript&&providerTranscript.length>CARTESIA_PHRASE_CAPABILITY.maxTranscriptCharacters)fail("Shorten the directed voice transcript to at most 40000 characters.");
  const plan = {schema: localized?"hv-audio-line/5" as const:native?"hv-audio-line/4" as const:phrases.length?"hv-audio-line/3" as const:intent?"hv-audio-line/2" as const:"hv-audio-line/1" as const,...(localization?{localization}:{}),...(intent?{memory:intent}:{}),...((native||localized||phrases.length)?{phrases,providerTranscript}:{}),capabilityRevision:localized?CARTESIA_MULTILINGUAL_CAPABILITY.revision:native?AZURE_AUDIO_CAPABILITY.revision:phrases.length?CARTESIA_PHRASE_CAPABILITY.revision:CARTESIA_AUDIO_CAPABILITY.revision, source: current, profile,
    spokenText: spoken, beforeMs: audioNumber(edit.beforeMs ?? 0, 0, 3000, "Leading pause", true),
    afterMs: audioNumber(edit.afterMs ?? 200, 0, 3000, "Trailing pause", true), notes, alignment};
  return {...plan, revision: contentHash(plan)};
}
export function validateAudioLinePlan(input: AudioLinePlan): AudioLinePlan {
  const v = audioRecord(input, ["schema", "capabilityRevision", "source", "profile", "spokenText", "beforeMs", "afterMs", "notes", "alignment", "revision",...(["hv-audio-line/2","hv-audio-line/3","hv-audio-line/4","hv-audio-line/5"].includes(input.schema)?["memory"]:[]),...(["hv-audio-line/3","hv-audio-line/4","hv-audio-line/5"].includes(input.schema)?["phrases","providerTranscript"]:[]),...(input.schema==="hv-audio-line/5"?["localization"]:[])]);
  const checked = compileAudioLine(input.source, input.profile, {sourceHash: input.source?.hash,
    ...input.profile?.controls,beforeMs: input.beforeMs, afterMs: input.afterMs, notes: input.notes,...(input.phrases?{phrases:input.phrases}:{}),...(input.localization?{localization:{language:input.localization.language,text:input.localization.text,sourceHash:input.localization.sourceHash,reviewed:true as const}}:{})}, input.alignment,input.memory);
  if (contentHash(v) !== contentHash(checked)) fail("The recorded audio performance changed. Compile a new line plan.");
  return checked;
}
