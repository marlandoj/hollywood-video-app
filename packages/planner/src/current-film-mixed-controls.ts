import {contentHash} from "../../generator/src/capabilities";
import type {Job} from "../../queue/src/index";
import type {RenderClip} from "./shot-reuse";
import type {Shot} from "./index";
import {generationStage} from "./render-stage";

/** V3 retains these reports on the actual owning row, not a renamed film-level
 * projection. This comparison is metadata evidence; archive media verification
 * separately checks the sealed files and their decoded frame counts. */
export function assertCurrentFilmMixedControls(clip:RenderClip,shot:Shot,stage:Job["stage"]):void {
  const camera=shot.direction?.cameraPath,reportedCamera=clip.cameraPathControl,frames=Math.round(clip.durationSec*30);
  if(reportedCamera!==undefined&&(!reportedCamera||typeof reportedCamera!=="object"))throw new Error("Retain an explicit mixed current-film camera report.");
  if(Boolean(camera)!==Boolean(reportedCamera))throw new Error("Mixed current-film row lost its admitted camera path report.");
  if(camera&&reportedCamera&&(reportedCamera.mode!=="screen-space"||contentHash(reportedCamera.keyframes)!==contentHash(camera.keyframes)
    ||!Number.isInteger(reportedCamera.outputFrames)||reportedCamera.outputFrames<2||reportedCamera.outputFrames>18000||reportedCamera.outputFrames!==frames
    ||shot.direction!.durationFrames!==null&&reportedCamera.outputFrames!==shot.direction!.durationFrames))throw new Error("Mixed current-film camera report differs from its admitted keyframes or actual row clock.");
  const anchors=shot.direction?.frameAnchors,reportedAnchors=clip.frameAnchorControl;
  if(reportedAnchors!==undefined&&(!reportedAnchors||typeof reportedAnchors!=="object"))throw new Error("Retain an explicit mixed current-film anchor report.");
  if(Boolean(anchors)!==Boolean(reportedAnchors))throw new Error("Mixed current-film row lost its admitted frame anchor report.");
  if(anchors&&reportedAnchors&&(!["native","storyboard"].includes(reportedAnchors.mode)||contentHash(reportedAnchors.positions)!==contentHash(anchors.frames.map(frame=>frame.at))
    ||generationStage(stage)==="animatic"&&reportedAnchors.mode!=="storyboard"||generationStage(stage)==="final"&&anchors.fallback==="stop"&&reportedAnchors.mode!=="native"
    ||reportedAnchors.mode==="native"&&reportedAnchors.positions.some(at=>at!==0&&at!==10000)))throw new Error("Mixed current-film anchor report differs from its admitted positions or provider mode.");
}
