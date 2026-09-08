import {readFileSync} from "node:fs";
import {contentHash} from "./capabilities";
import {compileGraphic} from "./graphic-composition";
import {graphicHash} from "./graphic-fonts";
import {GRAPHIC_CHROME_VERSION,GRAPHIC_RECIPE,validateMotionGraphic,type MotionGraphicPlan} from "../../planner/src/motion-graphics";
import {editRecord} from "../../planner/src/edit-timeline";
import {editFail,editNumber} from "../../planner/src/edit-errors";

export interface GraphicLayout {contentHeight:number;availableHeight:number;overflow:boolean;fontsReady:boolean;creditPixelsPerSecond:number|null}
export interface GraphicRenderReceipt {
  schema:"hv-graphic-render/1";plan:MotionGraphicPlan;recipe:typeof GRAPHIC_RECIPE;
  runtime:{browser:string;browserSha256:string;ffmpegSha256:string;platform:string;enginePackageSha256:string};
  composition:{file:string;sha256:string};fonts:{file:string;weight:number;range:string;sha256:string;bytes:number}[];
  license:{file:string;sha256:string};frameIndex:{file:string;sha256:string};layout:GraphicLayout;
  frames:{file:string;sha256:string;rgbaSha256:string;transparentPixels:number;visiblePixels:number}[];
  master:{file:string;sha256:string;bytes:number};revision:string;
}
export function graphicRevision(value:unknown):string {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain a valid graphic revision.");return value;}
/** Structural and authored-content validation, without launching Chrome or reading rendered media. */
export function validateGraphicReceipt(receipt:GraphicRenderReceipt,expectedPlan:MotionGraphicPlan):GraphicRenderReceipt {
  editRecord(receipt,["schema","plan","recipe","runtime","composition","fonts","license","frameIndex","layout","frames","master","revision"]);validateMotionGraphic(expectedPlan);
  const {revision,...data}=receipt;if(receipt.schema!=="hv-graphic-render/1"||revision!==contentHash(data)||contentHash(receipt.plan)!==contentHash(expectedPlan)||contentHash(receipt.recipe)!==contentHash(GRAPHIC_RECIPE)||JSON.stringify(receipt).length>16*1024**2)editFail("The graphic output differs from its reviewed plan.");
  const compiled=compileGraphic(expectedPlan),r=receipt.runtime;editRecord(r,["browser","browserSha256","ffmpegSha256","platform","enginePackageSha256"]);
  for(const hash of [r.browserSha256,r.ffmpegSha256,r.enginePackageSha256])graphicRevision(hash);
  if(!["HeadlessChrome/"+GRAPHIC_CHROME_VERSION,"Chrome/"+GRAPHIC_CHROME_VERSION].includes(r.browser)||! /^(win32|linux|darwin)\/(x64|arm64)$/.test(r.platform)||r.enginePackageSha256!==graphicHash(readFileSync(new URL(import.meta.resolve("@hyperframes/engine/package.json")))))editFail("The graphic renderer differs from its qualified package or browser.");
  if(contentHash(receipt.composition)!==contentHash({file:"index.html",sha256:compiled.htmlSha256})||contentHash(receipt.fonts)!==contentHash(compiled.fonts.map(({data:_data,...font})=>font))||contentHash(receipt.license)!==contentHash({file:"INTER-LICENSE.txt",sha256:graphicHash(compiled.license)}))editFail("The graphic composition or retained font evidence changed.");
  editRecord(receipt.frameIndex,["file","sha256"]);if(receipt.frameIndex.file!=="rgba-frames.txt")editFail("The graphic lost its frame index.");graphicRevision(receipt.frameIndex.sha256);
  const layout=receipt.layout;editRecord(layout,["contentHeight","availableHeight","overflow","fontsReady","creditPixelsPerSecond"]);editNumber(layout.contentHeight,1,1000000,"Graphic content height");
  const speed=expectedPlan.kind==="credits"?(expectedPlan.height+layout.contentHeight)*30/(expectedPlan.frames-1):null;
  if(layout.availableHeight!==expectedPlan.height-2*expectedPlan.margin||layout.overflow!==false||layout.fontsReady!==true||layout.creditPixelsPerSecond!==speed||expectedPlan.kind!=="credits"&&layout.contentHeight>layout.availableHeight)editFail("The graphic layout no longer fits its reviewed safe area.");
  if(!Array.isArray(receipt.frames)||receipt.frames.length!==expectedPlan.frames)editFail("The graphic lost captured frames.");
  for(const [i,frame] of receipt.frames.entries()){editRecord(frame,["file","sha256","rgbaSha256","transparentPixels","visiblePixels"]);graphicRevision(frame.sha256);graphicRevision(frame.rgbaSha256);editNumber(frame.transparentPixels,0,expectedPlan.width*expectedPlan.height,"Transparent pixels");editNumber(frame.visiblePixels,0,expectedPlan.width*expectedPlan.height,"Visible pixels");if(frame.file!==`frames/${String(i).padStart(6,"0")}.png`||frame.transparentPixels+frame.visiblePixels!==expectedPlan.width*expectedPlan.height||expectedPlan.background!==null&&frame.transparentPixels!==0)editFail("The graphic changed frame order or transparency evidence.");}
  editRecord(receipt.master,["file","sha256","bytes"]);graphicRevision(receipt.master.sha256);editNumber(receipt.master.bytes,1,4*1024**3,"Graphic master bytes");if(receipt.master.file!=="graphic.mkv")editFail("The graphic master path changed.");return receipt;
}
