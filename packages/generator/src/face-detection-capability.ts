import {contentHash} from "./capabilities";

/**
 * HV-022-25: the first face-point finder, fal.ai's Moondream detection endpoint (the owner's decision of 2026-11-11:
 * "First face point: VEO or fal.ai"; fal.ai because the studio already holds a fal account for picture and stills).
 *
 * Pinned, like the lip-sync and voice capabilities, so a change to the endpoint, the request or the reading of its
 * answer is a new revision every detection names. It is not a performance lane (voice, lip-sync), so it is not in
 * `PERFORMANCE_REGISTRY` and needs no entry in capability-revision-pins.json; its revision is pinned by its own test.
 *
 * Closed: nothing in the studio builds a live detector. The only transport is one a caller injects (the tests' mock).
 */
export const FACE_DETECTION_MODEL="fal-ai/moondream-next/detection";
export const FACE_DETECTION_ENDPOINT="https://fal.run/"+FACE_DETECTION_MODEL;
/** The request fields the studio sends, besides the frame itself. `combine_points` is false so two faces are never merged into one point. */
export const FACE_DETECTION_REQUEST={task_type:"point_detection",detection_prompt:"face",combine_points:false,show_visualization:false,use_ensemble:false} as const;
const definition={schema:"hv-face-detection-capability/1",provider:"fal",model:FACE_DETECTION_MODEL,endpoint:FACE_DETECTION_ENDPOINT,
  modelVersion:"service-managed-not-pinnable",qualification:"closed-transport-fixtures-only",
  input:{image:"png-data-uri",frame:"verified-decoded-source-frame",frameChoice:"middle-of-line-window",request:FACE_DETECTION_REQUEST,maxResponseBytes:1048576},
  output:{field:"text_output",format:"undocumented",accepted:"json-object-points-array-of-normalized-x-y",
    // Anything else -- another shape, more keys, a number outside [0,1], text that is not JSON -- is no point.
    unparseable:"no-point",acceptance:"exactly-one-face-inside-the-frame",ignored:["image"]},
  selection:{mode:"detected-suggestion",ownerPointWins:true,coordinates:"native-input-pixels-floored"},
  billing:{listed:"usd-per-compute-second",listedUsd:0.0011,studioHold:"flat-per-detection-from-operator-policy",spentWithoutPoint:true},
  recovery:{submission:"one-call-per-detection-key",unfinished:"no-point-never-repeated"},
  knownGaps:["text_output format to be confirmed on the first live call","data-uri frame size limit to be confirmed on the first live call"],
  documentation:["https://fal.ai/models/fal-ai/moondream-next/detection/api"]};
function freeze<T>(value:T):T{if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export const FACE_DETECTION_CAPABILITY=freeze({...definition,revision:contentHash(definition)});
