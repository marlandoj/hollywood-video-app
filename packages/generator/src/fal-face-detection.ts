import {createHash} from "node:crypto";
import {FACE_DETECTION_CAPABILITY,FACE_DETECTION_ENDPOINT,FACE_DETECTION_REQUEST} from "./face-detection-capability";

/**
 * HV-022-25: what one face detection found on one verified frame, read strictly.
 *
 * `one-face` is the only outcome with a point. Every other answer -- no face, several, a face outside the frame,
 * an answer that cannot be read with certainty, or a call that failed -- is no point, and the line stays the
 * owner's to choose under Direct lip-sync. The studio never guesses which face speaks.
 */
export type FaceDetectionOutcome="one-face"|"no-face"|"several-faces"|"out-of-bounds"|"unparseable"|"failed";
export interface FaceDetectionResult {outcome:FaceDetectionOutcome;faces:number|null;point:{x:number;y:number}|null;responseSha256:string|null}
export interface FaceDetectionFrame {png:Uint8Array;width:number;height:number;rgbSha256:string}
/** A face-point finder. Only an injected one exists (the closed mock adapter below); nothing in the studio builds a live one. */
export interface FaceDetector {readonly capabilityRevision:string;detect(frame:FaceDetectionFrame,signal?:AbortSignal):Promise<FaceDetectionResult>}
export class FaceDetectionError extends Error {override name="FaceDetectionError";}

const MAX_POINTS=64,MAX_TEXT=65536;
const plain=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const unit=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=1;

/**
 * The provider's JSON answer, read for one face. `text_output` is undocumented, so exactly one shape is accepted:
 * `{"points":[{"x":…,"y":…},…]}` with every coordinate a number in [0,1] of the frame's width and height. Any other
 * key, shape or value is `unparseable`. A point at 1 (the frame's far edge) is outside the frame's pixels.
 */
export function parseFaceDetection(body:unknown,width:number,height:number):Omit<FaceDetectionResult,"responseSha256">{
  const none=(outcome:FaceDetectionOutcome,faces:number|null=null)=>({outcome,faces,point:null});
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)return none("unparseable");
  if(!plain(body)||typeof body.text_output!=="string"||body.text_output.length>MAX_TEXT||Object.keys(body).some(k=>k!=="text_output"&&k!=="image"))return none("unparseable");
  let parsed:unknown;try{parsed=JSON.parse(body.text_output);}catch{return none("unparseable");}
  if(!plain(parsed)||Object.keys(parsed).length!==1||!Array.isArray(parsed.points)||parsed.points.length>MAX_POINTS)return none("unparseable");
  const points=parsed.points as unknown[];
  if(points.some(p=>!plain(p)||Object.keys(p).length!==2||!unit(p.x)||!unit(p.y)))return none("unparseable");
  if(!points.length)return none("no-face",0);
  if(points.length>1)return none("several-faces",points.length);
  const only=points[0] as {x:number;y:number},x=Math.floor(only.x*width),y=Math.floor(only.y*height);
  if(x<0||y<0||x>=width||y>=height)return none("out-of-bounds",1);
  return {outcome:"one-face",faces:1,point:{x,y}};
}

/** What the studio would tell the creator about a detection that left no point. */
export function faceDetectionDetail(outcome:FaceDetectionOutcome|null,faces:number|null):string{
  switch(outcome){
    case "one-face":return "One face found; its point is the studio's suggestion until the owner chooses one.";
    case "no-face":return "No face found; choose the speaker under Direct lip-sync.";
    case "several-faces":return `${faces} faces found; choose the speaker under Direct lip-sync.`;
    case "out-of-bounds":return "The face found lies outside the frame; choose the speaker under Direct lip-sync.";
    case "unparseable":return "The detection's answer could not be read with certainty; choose the speaker under Direct lip-sync.";
    case "failed":return "The face detection did not answer; choose the speaker under Direct lip-sync.";
    default:return "The face detection for this line did not finish; choose the speaker under Direct lip-sync.";
  }
}

async function bounded(response:Response,maximum:number):Promise<Uint8Array>{
  const declared=response.headers.get("content-length");if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum))throw new FaceDetectionError("Unbounded face detection response.");
  if(!response.body)throw new FaceDetectionError("Empty face detection response.");
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  try{while(true){const read=await reader.read();if(read.done)break;total+=read.value.byteLength;if(total>maximum)throw new FaceDetectionError("Face detection response exceeds its limit.");chunks.push(read.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(chunks,total);
}

/**
 * The fal adapter, closed: both its key and its transport are the caller's, so it never reads `FAL_KEY` and never
 * reaches the network by default. The studio builds none; the tests inject a mock transport.
 */
export class FalFaceDetector implements FaceDetector {
  readonly capabilityRevision=FACE_DETECTION_CAPABILITY.revision;
  private readonly apiKey:string;private readonly fetchImpl:typeof fetch;
  constructor(options:{apiKey:string;fetchImpl:typeof fetch}){
    if(typeof options?.apiKey!=="string"||!options.apiKey.trim())throw new FaceDetectionError("The face detector needs its operator's key.");
    if(typeof options.fetchImpl!=="function")throw new FaceDetectionError("The face detector needs an injected transport.");
    this.apiKey=options.apiKey;this.fetchImpl=options.fetchImpl;
  }
  /** The exact JSON body sent for a frame. */
  static request(frame:FaceDetectionFrame){return {image_url:"data:image/png;base64,"+Buffer.from(frame.png).toString("base64"),...FACE_DETECTION_REQUEST};}
  async detect(frame:FaceDetectionFrame,signal?:AbortSignal):Promise<FaceDetectionResult>{
    let response:Response;
    try{response=await this.fetchImpl(FACE_DETECTION_ENDPOINT,{method:"POST",redirect:"error",signal,headers:{authorization:"Key "+this.apiKey,"content-type":"application/json",accept:"application/json"},body:JSON.stringify(FalFaceDetector.request(frame))});}
    catch{return {outcome:"failed",faces:null,point:null,responseSha256:null};}
    if(!response.ok){await response.body?.cancel().catch(()=>{});return {outcome:"failed",faces:null,point:null,responseSha256:null};}
    let bytes:Uint8Array;try{bytes=await bounded(response,FACE_DETECTION_CAPABILITY.input.maxResponseBytes);}catch{return {outcome:"unparseable",faces:null,point:null,responseSha256:null};}
    const responseSha256=createHash("sha256").update(bytes).digest("hex");
    let body:unknown;try{body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{return {outcome:"unparseable",faces:null,point:null,responseSha256};}
    return {...parseFaceDetection(body,frame.width,frame.height),responseSha256};
  }
}
