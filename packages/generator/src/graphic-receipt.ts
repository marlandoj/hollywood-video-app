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
/**
 * What a receipt's `browser` field has to look like -- a Chrome build string,
 * any version.
 *
 * Deliberately a shape and not the pinned version. This check used to be
 * `browser === "HeadlessChrome/" + GRAPHIC_CHROME_VERSION`, and the line beside
 * it recomputed `graphicHash(readFileSync(import.meta.resolve(
 * "@hyperframes/engine/package.json")))` and compared it to the value frozen
 * into the receipt -- so a retained receipt was re-bound, at every validation,
 * to the host doing the validating.
 *
 * The consequence was not confined to graphics. `validateSnapshot` reaches
 * `validateEditLibrary` -> `validateEditSourceReceipt` -> `editOriginalJob` ->
 * `validateGraphicOutput` -> here, so bumping `@hyperframes/engine`, or letting
 * bun re-resolve the lockfile so that one package.json's bytes differ at all,
 * or moving the pinned Chrome build, made **every state snapshot refuse to
 * restore** for every project whose editorial library held a single graphic
 * source. A restore is a cold process, so the in-process receipt cache does not
 * help; nothing in the repository failed at the moment of the bump, because
 * every test built its receipt from the same live constants in the same
 * process and the two sides therefore always agreed.
 *
 * A receipt is evidence of what a particular host did at a particular time. It
 * is checked for internal consistency and for its binding to the plan it was
 * rendered from; whether *this* host is qualified to render is a different
 * question, asked at render admission by `assertQualifiedGraphicRuntime`.
 */
export const GRAPHIC_BROWSER_SHAPE=/^(?:HeadlessChrome|Chrome)\/\d+\.\d+\.\d+\.\d+$/;

/** The engine version this program is qualified against, read from the package it will load. */
export function installedGraphicEngineVersion():string {
  const manifest=JSON.parse(readFileSync(new URL(import.meta.resolve("@hyperframes/engine/package.json")),"utf8")) as {version?:unknown};
  if(typeof manifest.version!=="string"||!manifest.version)editFail("The graphics engine package does not declare a version.");
  return manifest.version as string;
}

/**
 * Refuses to render on a host whose graphics runtime is not the qualified one.
 *
 * This is the check the receipt validator used to be doing by accident, moved
 * to where it belongs: admission of *new* work, where an unqualified engine or
 * browser must stop the render, rather than validation of *retained* work,
 * where it invalidated evidence that was never wrong.
 *
 * The engine is compared by declared version against `GRAPHIC_RECIPE.version`,
 * not by package bytes. Bytes change when a registry republishes or a lockfile
 * re-resolves, and neither of those is a different renderer; a version is what
 * the recipe declares and what `package.json` pins.
 */
export function assertQualifiedGraphicRuntime(browser:string,engineVersion=installedGraphicEngineVersion()):void {
  if(!["HeadlessChrome/"+GRAPHIC_CHROME_VERSION,"Chrome/"+GRAPHIC_CHROME_VERSION].includes(browser)){
    editFail("Install the pinned graphics Chrome version "+GRAPHIC_CHROME_VERSION+" before rendering.");
  }
  if(engineVersion!==GRAPHIC_RECIPE.version){
    editFail("Install the qualified graphics engine "+GRAPHIC_RECIPE.version+" before rendering; this host has "+engineVersion+".");
  }
}

export function graphicRevision(value:unknown):string {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain a valid graphic revision.");return value;}
/** Structural and authored-content validation, without launching Chrome or reading rendered media. */
export function validateGraphicReceipt(receipt:GraphicRenderReceipt,expectedPlan:MotionGraphicPlan):GraphicRenderReceipt {
  editRecord(receipt,["schema","plan","recipe","runtime","composition","fonts","license","frameIndex","layout","frames","master","revision"]);validateMotionGraphic(expectedPlan);
  const {revision,...data}=receipt;if(receipt.schema!=="hv-graphic-render/1"||revision!==contentHash(data)||contentHash(receipt.plan)!==contentHash(expectedPlan)||contentHash(receipt.recipe)!==contentHash(GRAPHIC_RECIPE)||JSON.stringify(receipt).length>16*1024**2)editFail("The graphic output differs from its reviewed plan.");
  const compiled=compileGraphic(expectedPlan),r=receipt.runtime;editRecord(r,["browser","browserSha256","ffmpegSha256","platform","enginePackageSha256"]);
  for(const hash of [r.browserSha256,r.ffmpegSha256,r.enginePackageSha256])graphicRevision(hash);
  if(!GRAPHIC_BROWSER_SHAPE.test(r.browser)||! /^(win32|linux|darwin)\/(x64|arm64)$/.test(r.platform))editFail("The retained graphic receipt does not name the runtime that produced it.");
  if(contentHash(receipt.composition)!==contentHash({file:"index.html",sha256:compiled.htmlSha256})||contentHash(receipt.fonts)!==contentHash(compiled.fonts.map(({data:_data,...font})=>font))||contentHash(receipt.license)!==contentHash({file:"INTER-LICENSE.txt",sha256:graphicHash(compiled.license)}))editFail("The graphic composition or retained font evidence changed.");
  editRecord(receipt.frameIndex,["file","sha256"]);if(receipt.frameIndex.file!=="rgba-frames.txt")editFail("The graphic lost its frame index.");graphicRevision(receipt.frameIndex.sha256);
  const layout=receipt.layout;editRecord(layout,["contentHeight","availableHeight","overflow","fontsReady","creditPixelsPerSecond"]);editNumber(layout.contentHeight,1,1000000,"Graphic content height");
  const speed=expectedPlan.kind==="credits"?(expectedPlan.height+layout.contentHeight)*30/(expectedPlan.frames-1):null;
  if(layout.availableHeight!==expectedPlan.height-2*expectedPlan.margin||layout.overflow!==false||layout.fontsReady!==true||layout.creditPixelsPerSecond!==speed||expectedPlan.kind!=="credits"&&layout.contentHeight>layout.availableHeight)editFail("The graphic layout no longer fits its reviewed safe area.");
  if(!Array.isArray(receipt.frames)||receipt.frames.length!==expectedPlan.frames)editFail("The graphic lost captured frames.");
  for(const [i,frame] of receipt.frames.entries()){editRecord(frame,["file","sha256","rgbaSha256","transparentPixels","visiblePixels"]);graphicRevision(frame.sha256);graphicRevision(frame.rgbaSha256);editNumber(frame.transparentPixels,0,expectedPlan.width*expectedPlan.height,"Transparent pixels");editNumber(frame.visiblePixels,0,expectedPlan.width*expectedPlan.height,"Visible pixels");if(frame.file!==`frames/${String(i).padStart(6,"0")}.png`||frame.transparentPixels+frame.visiblePixels!==expectedPlan.width*expectedPlan.height||expectedPlan.background!==null&&frame.transparentPixels!==0)editFail("The graphic changed frame order or transparency evidence.");}
  editRecord(receipt.master,["file","sha256","bytes"]);graphicRevision(receipt.master.sha256);editNumber(receipt.master.bytes,1,4*1024**3,"Graphic master bytes");if(receipt.master.file!=="graphic.mkv")editFail("The graphic master path changed.");return receipt;
}
