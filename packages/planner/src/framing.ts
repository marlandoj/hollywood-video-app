/** Fixed-point crop coordinates in the uncropped frame; equal scale on both axes. */
export interface ShotFraming {x:number;y:number;size:number}
export interface ShotOptics {sensorWidthMm:number;sensorHeightMm:number;squeeze:number;look:string}
export const DEFAULT_FRAMING:ShotFraming={x:0,y:0,size:10000};
export const DEFAULT_OPTICS:ShotOptics={sensorWidthMm:36,sensorHeightMm:20.25,squeeze:1,look:""};
const record=(input:unknown):Record<string,unknown>=>{if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Use a framing or optics record.");return input as Record<string,unknown>;};
export function framingSettings(input:unknown):ShotFraming {
  const value=record(input);if(Object.keys(value).sort().join(",")!=="size,x,y"||![value.x,value.y,value.size].every(Number.isInteger))throw new Error("Framing requires integer x, y and size in ten-thousandths of the source frame.");
  const {x,y,size}=value as unknown as ShotFraming;if(size<2500||size>10000||x<0||y<0||x+size>10000||y+size>10000)throw new Error("Keep the crop inside the source frame, at 25–100% of its width and height.");return {x,y,size};
}
export function opticsSettings(input:unknown):ShotOptics {
  const value={...DEFAULT_OPTICS,...record(input)} as ShotOptics;if(Object.keys(value).some(key=>!Object.hasOwn(DEFAULT_OPTICS,key)))throw new Error("Unsupported optics field.");
  for(const key of ["sensorWidthMm","sensorHeightMm"] as const)if(typeof value[key]!=="number"||!Number.isFinite(value[key])||value[key]<1||value[key]>100)throw new Error("Sensor dimensions must be between 1 and 100 mm.");
  if(typeof value.squeeze!=="number"||!Number.isFinite(value.squeeze)||value.squeeze<1||value.squeeze>2)throw new Error("Lens squeeze must be between 1 and 2.");
  if(typeof value.look!=="string"||value.look.length>400||[...value.look].some(c=>c.charCodeAt(0)<32&&![9,10,13].includes(c.charCodeAt(0))))throw new Error("Camera look must be text of at most 400 characters.");
  return {...value,look:value.look.trim()};
}
export function isCropped(value:ShotFraming|undefined):boolean {return Boolean(value&&framingSettings(value).size<10000);}
/** Rectilinear, infinity-focus approximation. No distortion, depth of field or model-output claim. */
export function opticalFieldOfView(optics:ShotOptics,focalLengthMm:number,framing:ShotFraming=DEFAULT_FRAMING):{horizontalDeg:number;verticalDeg:number} {
  const value=opticsSettings(optics),crop=framingSettings(framing);if(!Number.isFinite(focalLengthMm)||focalLengthMm<8||focalLengthMm>1000)throw new Error("Focal length must be between 8 and 1000 mm.");
  // Rays to the two sensor boundaries also handle crops away from the optical axis.
  const angle=(dimension:number,start:number)=>(Math.atan(dimension*((start+crop.size)/10000-.5)/focalLengthMm)-Math.atan(dimension*(start/10000-.5)/focalLengthMm))*180/Math.PI;
  return {horizontalDeg:angle(value.sensorWidthMm*value.squeeze,crop.x),verticalDeg:angle(value.sensorHeightMm,crop.y)};
}
export function framingFilter(value:ShotFraming,width:number,height:number):string {
  const crop=framingSettings(value);if(![width,height].every(n=>Number.isInteger(n)&&n>=16&&n<=8192&&n%2===0))throw new Error("Framing requires even output dimensions from 16 to 8192 pixels.");
  const w=Math.max(2,Math.floor(width*crop.size/10000/2)*2),h=Math.max(2,Math.floor(height*crop.size/10000/2)*2);
  const x=Math.min(width-w,Math.floor(width*crop.x/10000/2)*2),y=Math.min(height-h,Math.floor(height*crop.y/10000/2)*2);
  return `crop=${w}:${h}:${x}:${y},scale=${width}:${height}:flags=lanczos,setsar=1`;
}
export const CAMERA_PRESETS=[
  {id:"observational-16",name:"Observational 16 mm",description:"A small-format documentary direction; grain and response remain creative intent.",settings:{lensMm:16,lensType:"spherical",movement:"handheld",movementSpeed:"Gentle, responsive movement",optics:{sensorWidthMm:12.52,sensorHeightMm:7.04,squeeze:1,look:"Small-format documentary texture, natural light and restrained grain."}}},
  {id:"large-format-wide",name:"Large-format wide",description:"A wide, steady composition with a modeled 36 × 20.25 mm active area.",settings:{lensMm:24,lensType:"spherical",movement:"static",movementSpeed:"Still",optics:{sensorWidthMm:36,sensorHeightMm:20.25,squeeze:1,look:"Clean wide composition, layered foreground and background, restrained contrast."}}},
  {id:"anamorphic-drama",name:"Anamorphic drama",description:"A modeled 2× squeeze and slow dolly. Optical artifacts are prompt intent, not simulated glass.",settings:{lensMm:50,lensType:"anamorphic",movement:"dolly",movementSpeed:"Slow and deliberate",optics:{sensorWidthMm:24,sensorHeightMm:18,squeeze:2,look:"Anamorphic dramatic composition, subtle horizontal highlights and oval bokeh intent."}}},
  {id:"large-format-portrait",name:"Large-format portrait",description:"A longer-lens, steady portrait direction with a modeled 36 × 24 mm active area.",settings:{lensMm:85,lensType:"spherical",movement:"static",movementSpeed:"Still",optics:{sensorWidthMm:36,sensorHeightMm:24,squeeze:1,look:"Intimate portrait framing, gentle falloff and restrained background detail."}}},
] as const;
