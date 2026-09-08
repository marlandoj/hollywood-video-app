import {contentHash} from "../../generator/src/capabilities";
import {castingSnapshot,validateCasting,type CastingSnapshot} from "./casting";
import {directionSnapshot,validateDirection,type DirectionSnapshot} from "./direction";
import {editFail} from "./edit-timeline";
import type {LivingScriptRenderInputs} from "./living-script-generation";

export interface LivingScriptSettingsBaseline {casting:CastingSnapshot;direction:DirectionSnapshot}
/** Current baseline and proposed settings are separate identities. A changed candidate is the
 * next explicit snapshot; rebinding direction to the pending screenplay never commits it early.
 * This validates review metadata, not permission for new actors, assets or provider spending. */
export function validateLivingScriptSettings(baseline:LivingScriptSettingsBaseline,candidate:Pick<LivingScriptRenderInputs,"casting"|"direction">,projectId:string):LivingScriptSettingsBaseline{
  if(!baseline||typeof baseline!=="object"||Array.isArray(baseline)||Object.keys(baseline).sort().join(",")!=="casting,direction")editFail("Retain the exact current cast and direction baseline.");
  const before={casting:validateCasting(baseline.casting,projectId),direction:validateDirection(baseline.direction,projectId)};
  const after={casting:validateCasting(candidate.casting??castingSnapshot(projectId,0,[],0),projectId),direction:validateDirection(candidate.direction??directionSnapshot(projectId,0,[],0),projectId)};
  for(const key of ["casting","direction"] as const){
    if(contentHash(before[key])!==contentHash(baseline[key])||candidate[key]&&contentHash(after[key])!==contentHash(candidate[key]))editFail("Retain the exact complete cast and direction snapshots without unreviewed fields.");
    if(contentHash(before[key])===contentHash(after[key]))continue;
    if(after[key].version!==before[key].version+1||Date.parse(after[key].createdAt)<Date.parse(before[key].createdAt))editFail("Review changed cast or direction as the next explicit snapshot after its current baseline.");
  }
  return structuredClone(after);
}
