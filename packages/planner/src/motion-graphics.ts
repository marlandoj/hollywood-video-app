import {contentHash} from "../../generator/src/capabilities";
import {editFail,editNumber} from "./edit-errors";
import {editRecord} from "./edit-timeline";

export const GRAPHIC_KINDS=["title","lower-third","credits","slate","watermark","kinetic"] as const;
export interface MotionGraphic {
  schema:"hv-motion-graphic/1";kind:typeof GRAPHIC_KINDS[number];width:number;height:number;frames:number;
  text:string;secondary:string;credits:{role:string;name:string}[];
  fontSize:number;margin:number;color:string;accent:string;background:string|null;
  align:"left"|"center"|"right";enterFrames:number;exitFrames:number;
}
export interface MotionGraphicPlan extends MotionGraphic {revision:string}
export const GRAPHIC_CHROME_VERSION="152.0.7977.75";
export const GRAPHIC_RECIPE={schema:"hv-hyperframes-graphic/1",engine:"@hyperframes/engine",version:"0.8.31",fps:30,capture:"png-software-screenshot",master:"ffv1-bgra-bitexact",font:"@fontsource/inter@5.2.8",fontValidation:"fontkit@2.0.4-cmap",timing:"integer-frame-seek",externalResources:false} as const;
function graphicText(value:unknown,max:number,required:boolean){
  if(typeof value!=="string"||value.length>max||(required&&!value.trim())||/[\p{Cc}\p{Cs}\p{Cf}]/u.test(value.replace(/\r?\n|\t/g,"")))editFail("Use readable graphic text within the indicated length, without hidden control characters.");
  return value;
}
export function motionGraphic(input:MotionGraphic):MotionGraphicPlan{
  const p=editRecord(input,["schema","kind","width","height","frames","text","secondary","credits","fontSize","margin","color","accent","background","align","enterFrames","exitFrames"]);
  if(p.schema!=="hv-motion-graphic/1"||!GRAPHIC_KINDS.includes(input.kind))editFail("Choose a supported title or motion graphic.");
  editNumber(p.width,64,1920,"Graphic width");editNumber(p.height,64,1080,"Graphic height");if(input.width%2||input.height%2)editFail("Use even graphic dimensions.");
  editNumber(p.frames,2,18000,"Graphic duration in frames");editNumber(p.fontSize,8,Math.floor(input.height/3),"Graphic font size");editNumber(p.margin,0,Math.floor(Math.min(input.width,input.height)/4),"Graphic safe inset");
  editNumber(p.enterFrames,0,input.frames-1,"Graphic entrance frames");editNumber(p.exitFrames,0,input.frames-1-input.enterFrames,"Graphic exit frames");
  graphicText(p.text,1000,input.kind!=="credits");graphicText(p.secondary,2000,false);
  if(!["left","center","right"].includes(input.align))editFail("Choose a text alignment.");
  for(const color of [input.color,input.accent,...(input.background===null?[]:[input.background])])if(typeof color!=="string"||!/^#[a-fA-F0-9]{6}$/.test(color))editFail("Use six-digit graphic colors.");
  if(!Array.isArray(input.credits)||input.credits.length>200||input.kind==="credits"&&!input.credits.length||input.kind!=="credits"&&input.credits.length)editFail("Use one to 200 role/name rows for credits, and no credit rows for other graphics.");
  for(const row of input.credits){editRecord(row,["role","name"]);graphicText(row.role,160,false);graphicText(row.name,240,true);}
  const data=structuredClone(input);return {...data,revision:contentHash(data)};
}
export function validateMotionGraphic(plan:MotionGraphicPlan):MotionGraphicPlan{
  const {revision,...input}=editRecord(plan,["schema","kind","width","height","frames","text","secondary","credits","fontSize","margin","color","accent","background","align","enterFrames","exitFrames","revision"]) as unknown as MotionGraphicPlan;
  const expected=motionGraphic(input);if(expected.revision!==revision)editFail("The saved motion graphic changed. Review its text and timing again.");return expected;
}
export function defaultMotionGraphic(kind:MotionGraphic["kind"],width=1280,height=720):MotionGraphicPlan{
  return motionGraphic({schema:"hv-motion-graphic/1",kind,width,height,frames:kind==="credits"?900:150,text:kind==="credits"?"Credits":"Your title",secondary:"",credits:kind==="credits"?[{role:"Directed by",name:"Your name"}]:[],fontSize:Math.max(8,Math.round(height*(kind==="watermark"?.035:kind==="lower-third"?.06:.09))),margin:Math.round(Math.min(width,height)*.08),color:"#ffffff",accent:"#d7b46a",background:kind==="slate"||kind==="credits"?"#111318":null,align:kind==="lower-third"||kind==="slate"?"left":kind==="watermark"?"right":"center",enterFrames:kind==="watermark"?0:12,exitFrames:kind==="watermark"?0:12});
}
