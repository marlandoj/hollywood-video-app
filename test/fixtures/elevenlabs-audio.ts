import {audioPolicy} from "../../packages/planner/src/audio-jobs";
import {audioVoiceProfile} from "../../packages/planner/src/audio-performances";
import {ELEVENLABS_DEFAULTS} from "../../packages/planner/src/elevenlabs-performance";
// Entirely synthetic qualification data. Never an active policy, a real account or a real licence.
// The voice id is the service's own shape (20 alphanumerics) and belongs to no account.
export const ELEVENLABS_POLICY=audioPolicy({provider:"elevenlabs",voiceId:"ZZfixtureVoice000000",label:"Fixture voice (ElevenLabs)",
  accountRevision:"a".repeat(64),catalogueRevision:"b".repeat(64),licenceEvidenceSha256:"c".repeat(64),priceEvidenceSha256:"d".repeat(64),
  sex:"female",heldUsd:.5,maxCharacters:10000,validFrom:"2026-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z"});
export const ELEVENLABS_PROFILE=audioVoiceProfile({schema:"hv-audio-voice/4",provider:"elevenlabs",language:"en",
  voice:{id:ELEVENLABS_POLICY.voiceId,catalogueRevision:ELEVENLABS_POLICY.catalogueRevision,permissionRevision:ELEVENLABS_POLICY.permissionRevision},
  controls:{speed:1,volume:1,emotion:"neutral",...ELEVENLABS_DEFAULTS},pronunciations:[]});
