import type {Job} from "../../queue/src/index";
import type {Project,PersistedProject} from "../../api/src/index";
import {VersionStore} from "../../parser/src/index";
import {contentHash as hash} from "../../generator/src/capabilities";
import {validateCompletedCurrentFilmSource} from "./current-film-job-context";
import {resolveProjectCurrentScreenplay} from "./current-screenplay-library";
import {currentCasting,assertCharacterPermission} from "./casting";
import {assertFrameAnchorCatalog} from "./frame-anchors";
import {validateReference} from "./references";
import {editFail} from "./edit-timeline";

/** Historical media may outlive its accepted head or original carrier. Current grants
 * are checked at the physical scene's current address; no generation approval is implied. */
export function assertCurrentFilmSourcePermission(job:Job,project:Project|PersistedProject|null|undefined,now=Date.now()):void {
  const plan=validateCompletedCurrentFilmSource(job);
  if(!project||project.id!==job.projectId||!Number.isSafeInteger(now)||now<0||!project.rightsAttestedAt
    ||!Number.isFinite(Date.parse(project.rightsAttestedAt))||Date.parse(project.rightsAttestedAt)>now
    ||!Number.isFinite(Date.parse(project.deleteAfter))||Date.parse(project.deleteAfter)<=now)editFail("Current project rights or retention are unavailable for this film.");
  const versions=Array.isArray(project.versions)?project.versions:VersionStore.prototype.history.call(project.versions);
  const {library,head}=resolveProjectCurrentScreenplay(project.currentScreenplay,{projectId:project.id,versions});
  if(!head||hash(library.origin)!==hash(plan.library.origin)||library.version<plan.library.version
    ||hash(library.proposals.slice(0,plan.library.proposals.length))!==hash(plan.library.proposals)
    ||hash(library.acceptances.slice(0,plan.library.acceptances.length))!==hash(plan.library.acceptances))editFail("The retained film lost its saved canonical ancestry.");
  // An unrelated script PUT cannot silently move scene-scoped grants to a different screenplay.
  if(hash(versions.at(-1)??null)!==hash(head.script))editFail("Review the current screenplay ancestry before using this retained film.");
  const casting=currentCasting(project.id,project.castingHistory),document=head.state.context.plan.document;
  const catalog=new Set((project.referenceAssets??[]).map(asset=>hash(validateReference(asset,project.id))));
  for(const slot of plan.materialization.slots){
    const scene=document.scenes.find(value=>value.headingLineId===slot.physical.headingLineId);
    for(const id of slot.shot.characterIds??[]){
      const saved=job.casting!.characters.find(value=>value.id===id),current=casting.characters.find(value=>value.id===id);
      if(!saved||!current)editFail("A retained character is no longer in this project's cast.");
      assertCharacterPermission(saved,slot.sceneIndex+1,now);
      if(current.permission.scope==="scenes"&&!scene)editFail("The retained scene no longer has a current scene-scoped character grant.");
      const number=scene?scene.sceneIndex+1:slot.sceneIndex+1;assertCharacterPermission(current,number,now);
      if(current.permission.scope==="scenes"&&current.sceneBindings.find(binding=>binding.sceneNumber===number)?.heading!==scene!.heading)
        editFail("The current character grant belongs to a different physical scene.");
      for(const asset of saved.references??[])if(!catalog.has(hash(validateReference(asset,project.id))))editFail("A retained character reference is no longer available in this project's catalog.");
    }
    assertFrameAnchorCatalog(slot.shot.direction?.frameAnchors,project.id,project.referenceAssets??[]);
  }
}
