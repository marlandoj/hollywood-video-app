import {contentHash} from "../../generator/src/capabilities";
import type {CastingSnapshot} from "./casting";
import {assertFrameAnchorCatalog} from "./frame-anchors";
import type {CurrentDirectionContext,CurrentDirectionSnapshot} from "./living-script-current-direction";
import type {LivingScriptCastRebind} from "./living-script-cast-rebind";
import {renderCurrentScreenplay} from "./living-script-current-render";
import {editFail} from "./edit-timeline";
import {validateReference,type ReferenceAsset} from "./references";

/** These values must come from the freshly authorized project under its mutation/dispatch
 * fence. A historical target, receipt or cached validation cannot supply current authority. */
export interface CurrentScreenplayAuthority {
  projectId:string;documentRevision:string;casting:CastingSnapshot;
  rightsAttestedAt:string|null;deleteAfter:string;referenceAssets:ReferenceAsset[];
}

/** Recheck present permissions and the asset catalog against the complete effective film.
 * The service separately checks the saved head/proposal and exact screenplay baseline.
 * This function never grants permission, saves settings, or checks only changed shots. */
export function assertCurrentScreenplaySettings(
  state:{context:CurrentDirectionContext;direction:CurrentDirectionSnapshot;casting:LivingScriptCastRebind},
  current:CurrentScreenplayAuthority,now=Date.now(),
):ReturnType<typeof renderCurrentScreenplay> {
  if(!Number.isSafeInteger(now)||now<0||!Number.isFinite(Date.parse(current.deleteAfter))||Date.parse(current.deleteAfter)<=now
    ||!current.rightsAttestedAt||!Number.isFinite(Date.parse(current.rightsAttestedAt))||Date.parse(current.rightsAttestedAt)>now)
    editFail("Confirm current project rights and retention before using this screenplay.");
  if(state.context.plan.document.projectId!==current.projectId||current.casting.projectId!==current.projectId)
    editFail("Use the current screenplay and settings from this project.");
  const catalog=new Set(current.referenceAssets.map(asset=>contentHash(validateReference(asset,current.projectId))));
  for(const character of state.casting.candidate?.characters??[])
    for(const asset of character.references??[])
      if(!catalog.has(contentHash(validateReference(asset,current.projectId))))editFail("A current screenplay cast reference is no longer in this project's asset catalog.");
  for(const entry of state.direction.entries)assertFrameAnchorCatalog(entry.settings?.frameAnchors,current.projectId,current.referenceAssets);
  return renderCurrentScreenplay(state,{documentRevision:current.documentRevision,casting:current.casting},now);
}
