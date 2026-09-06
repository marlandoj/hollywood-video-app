import {readFileSync,statSync} from "node:fs";
import {validateAudioPolicy,type AudioPolicy} from "../../planner/src/audio-jobs";

/** Operator-owned configuration is read on every admission and permission check,
 * so removal/revocation does not require a process restart. No client path input. */
export function configuredAudioPolicies():AudioPolicy[]{
  const path=process.env.HV_AUDIO_POLICY_FILE;if(!path)return [];
  if(statSync(path).size>1024*1024)throw new Error("The audio policy catalogue exceeds its limit.");
  const value=JSON.parse(readFileSync(path,"utf8"));
  if(!value||Object.keys(value).sort().join(",")!=="policies,schema"||value.schema!=="hv-audio-policies/1"||!Array.isArray(value.policies)||value.policies.length>32)throw new Error("Invalid configured audio policy catalogue.");
  const policies=value.policies.map((p:AudioPolicy)=>validateAudioPolicy(p));
  if(new Set(policies.map((p:AudioPolicy)=>p.voiceId)).size!==policies.length)throw new Error("Duplicate configured audio voice.");
  return policies;
}
