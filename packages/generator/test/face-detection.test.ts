import {expect,test} from "bun:test";
import {FACE_DETECTION_CAPABILITY,FACE_DETECTION_ENDPOINT,FACE_DETECTION_MODEL,FACE_DETECTION_REQUEST} from "../src/face-detection-capability";
import {FalFaceDetector,FaceDetectionError,faceDetectionDetail,parseFaceDetection} from "../src/fal-face-detection";
import {PERFORMANCE_REGISTRY} from "../src/performance-registry";

/**
 * HV-022-25: the fal face-point finder, through a mock transport only. No key is read from the environment and no
 * request leaves the process: every reply below is a fixture, including the undocumented `text_output`.
 */
const FRAME={png:new Uint8Array([0x89,0x50,0x4e,0x47,1,2,3]),width:320,height:240,rgbSha256:"9".repeat(64)};
const reply=(text:unknown,init:ResponseInit={status:200})=>new Response(JSON.stringify(typeof text==="string"?{text_output:text}:text),{...init,headers:{"content-type":"application/json"}});
function mock(answer:()=>Response|Promise<Response>){
  const calls:{url:string;init:RequestInit}[]=[];
  const fetchImpl=(async(url:string|URL|Request,init?:RequestInit)=>{calls.push({url:String(url),init:init!});return answer();}) as typeof fetch;
  return {calls,detector:new FalFaceDetector({apiKey:"fixture key",fetchImpl})};
}

test("the capability pins the endpoint, the request and how its answer is read; it is not a performance lane",()=>{
  expect(FACE_DETECTION_CAPABILITY.revision).toBe("369d8d37996503c4d5eab605cb78ea6fb6f8ea4039de21dc4f486c8caacf969c");
  expect(FACE_DETECTION_MODEL).toBe("fal-ai/moondream-next/detection");expect(FACE_DETECTION_ENDPOINT).toBe("https://fal.run/fal-ai/moondream-next/detection");
  // Two faces are never merged into one point, and no visualization is bought.
  expect(FACE_DETECTION_REQUEST).toEqual({task_type:"point_detection",detection_prompt:"face",combine_points:false,show_visualization:false,use_ensemble:false});
  expect(FACE_DETECTION_CAPABILITY.qualification).toBe("closed-transport-fixtures-only");
  expect(FACE_DETECTION_CAPABILITY.output.acceptance).toBe("exactly-one-face-inside-the-frame");
  expect(FACE_DETECTION_CAPABILITY.billing).toEqual({listed:"usd-per-compute-second",listedUsd:.0011,studioHold:"flat-per-detection-from-operator-policy",spentWithoutPoint:true});
  expect(Object.isFrozen(FACE_DETECTION_CAPABILITY)&&Object.isFrozen(FACE_DETECTION_CAPABILITY.input.request)).toBe(true);
  expect(PERFORMANCE_REGISTRY.some(c=>c.capabilityRevision===FACE_DETECTION_CAPABILITY.revision||c.schema===FACE_DETECTION_CAPABILITY.schema)).toBe(false);
});

test("the adapter is closed: it needs its key and its transport from the caller, and never reads FAL_KEY",()=>{
  const before=process.env.FAL_KEY;process.env.FAL_KEY="environment-key-that-must-not-be-used";
  try{
    expect(()=>new FalFaceDetector({apiKey:"",fetchImpl:fetch})).toThrow(FaceDetectionError);
    expect(()=>new FalFaceDetector({apiKey:"k"} as never)).toThrow("injected transport");
    expect(()=>new FalFaceDetector(undefined as never)).toThrow(FaceDetectionError);
  }finally{if(before===undefined)delete process.env.FAL_KEY;else process.env.FAL_KEY=before;}
});

test("one face: the exact request is sent once, and the point is the frame's own pixel",async()=>{
  const {calls,detector}=mock(()=>reply('{"points":[{"x":0.5,"y":0.25}]}'));
  const result=await detector.detect(FRAME);
  expect(result).toMatchObject({outcome:"one-face",faces:1,point:{x:160,y:60}});expect(result.responseSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(calls.length).toBe(1);expect(calls[0]!.url).toBe(FACE_DETECTION_ENDPOINT);
  const init=calls[0]!.init;expect(init.method).toBe("POST");expect(init.redirect).toBe("error");
  expect((init.headers as Record<string,string>).authorization).toBe("Key fixture key");
  expect(JSON.parse(String(init.body))).toEqual({image_url:"data:image/png;base64,"+Buffer.from(FRAME.png).toString("base64"),...FACE_DETECTION_REQUEST});
});

test("two faces, none, or a face outside the frame: no point",async()=>{
  expect(await mock(()=>reply('{"points":[{"x":0.2,"y":0.3},{"x":0.7,"y":0.3}]}')).detector.detect(FRAME)).toMatchObject({outcome:"several-faces",faces:2,point:null});
  expect(await mock(()=>reply('{"points":[]}')).detector.detect(FRAME)).toMatchObject({outcome:"no-face",faces:0,point:null});
  expect(await mock(()=>reply('{"points":[{"x":1,"y":0.5}]}')).detector.detect(FRAME)).toMatchObject({outcome:"out-of-bounds",faces:1,point:null});
  expect(await mock(()=>reply('{"points":[{"x":0.5,"y":1}]}')).detector.detect(FRAME)).toMatchObject({outcome:"out-of-bounds",faces:1,point:null});
  // The far edge of the last pixel is still inside.
  expect(parseFaceDetection({text_output:'{"points":[{"x":0.9999,"y":0}]}'},320,240)).toEqual({outcome:"one-face",faces:1,point:{x:319,y:0}});
});

test("anything that cannot be read with certainty is no point: other shapes, keys, values, encodings or text",async()=>{
  const unreadable=[
    "not json",'{"points":[{"x":0.5}]}','{"points":[{"x":"0.5","y":0.5}]}','{"points":[{"x":0.5,"y":0.5,"label":"face"}]}','{"points":[{"x":-0.1,"y":0.5}]}','{"points":[{"x":1.2,"y":0.5}]}',
    '{"points":{"x":0.5,"y":0.5}}','{"points":[],"extra":1}','{"objects":[{"x_min":0.1,"y_min":0.1,"x_max":0.2,"y_max":0.2}]}','[{"x":0.5,"y":0.5}]','{"points":[[0.5,0.5]]}',
    '{"points":[null]}','"face at the centre"','{"points":[{"x":5e-1,"y":0.5}]}'.replace("5e-1","NaN"),JSON.stringify({points:Array(65).fill({x:.5,y:.5})}),
  ];
  for(const text of unreadable)expect(parseFaceDetection({text_output:text},320,240)).toEqual({outcome:"unparseable",faces:null,point:null});
  for(const body of [null,[],"x",{},{text_output:5},{text_output:'{"points":[]}',timings:{}},{text_output:"x".repeat(65537)}])expect(parseFaceDetection(body,320,240).outcome).toBe("unparseable");
  // An image beside the text is ignored (show_visualization is false, so none should come).
  expect(parseFaceDetection({text_output:'{"points":[]}',image:null},320,240).outcome).toBe("no-face");
  expect(parseFaceDetection({text_output:'{"points":[]}'},0,240).outcome).toBe("unparseable");
  // Through the adapter: a body that is not UTF-8 JSON, or one past its limit, is unreadable too.
  expect((await mock(()=>new Response(new Uint8Array([0xff,0xfe,0x00]),{status:200})).detector.detect(FRAME)).outcome).toBe("unparseable");
  expect(await mock(()=>new Response("x".repeat(FACE_DETECTION_CAPABILITY.input.maxResponseBytes+1),{status:200})).detector.detect(FRAME)).toEqual({outcome:"unparseable",faces:null,point:null,responseSha256:null});
  expect((await mock(()=>new Response("{}",{status:200,headers:{"content-length":"99999999"}})).detector.detect(FRAME)).outcome).toBe("unparseable");
  expect(await mock(()=>reply("{")).detector.detect(FRAME)).toMatchObject({outcome:"unparseable",point:null});
});

test("a refused or failed call is no point, and the adapter never retries it",async()=>{
  for(const status of [400,401,402,429,500,503]){const {calls,detector}=mock(()=>reply('{"points":[{"x":0.5,"y":0.5}]}',{status}));
    expect(await detector.detect(FRAME)).toEqual({outcome:"failed",faces:null,point:null,responseSha256:null});expect(calls.length).toBe(1);}
  const {calls,detector}=mock(()=>{throw new TypeError("network down");});
  expect(await detector.detect(FRAME)).toEqual({outcome:"failed",faces:null,point:null,responseSha256:null});expect(calls.length).toBe(1);
});

test("each outcome has its plain detail for the creator",()=>{
  expect(faceDetectionDetail("several-faces",2)).toBe("2 faces found; choose the speaker under Direct lip-sync.");
  expect(faceDetectionDetail("no-face",0)).toBe("No face found; choose the speaker under Direct lip-sync.");
  expect(faceDetectionDetail(null,null)).toContain("did not finish");
});
