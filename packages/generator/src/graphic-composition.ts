import {validateMotionGraphic,type MotionGraphicPlan} from "../../planner/src/motion-graphics";
import {graphicFonts,graphicHash} from "./graphic-fonts";

const escape=(text:string)=>text.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
/** Only reviewed fields enter the composition. Neither user HTML nor arbitrary scripts are accepted. */
export function compileGraphic(plan:MotionGraphicPlan){
  const p=validateMotionGraphic(plan),assets=graphicFonts(p),fontFaces=assets.fonts.map(f=>`@font-face{font-family:HVInter;font-style:normal;font-weight:${f.weight};font-display:block;src:url("${f.file}") format("woff2");unicode-range:${f.range}}`).join("\n");
  const title=p.kind==="kinetic"?p.text.split(/(\s+)/u).map(word=>/\s/u.test(word)?escape(word):`<span class="word">${escape(word)}</span>`).join(""):escape(p.text);
  const rows=p.credits.map(row=>`<div class="credit"><div class="role">${escape(row.role)}</div><div class="name">${escape(row.name)}</div></div>`).join("");
  const settings=JSON.stringify({kind:p.kind,frames:p.frames,enter:p.enterFrames,exit:p.exitFrames,width:p.width,height:p.height,margin:p.margin}).replace(/</g,"\\u003c");
  const script=`"use strict";
const p=${settings},content=document.getElementById("content"),words=[...document.querySelectorAll(".word")];
const clamp=x=>Math.max(0,Math.min(1,x));
let height=0;
function seek(seconds){
 const frame=Math.max(0,Math.min(p.frames-1,Math.round(seconds*30))),incoming=p.enter?clamp(frame/p.enter):1,outgoing=p.exit?clamp((p.frames-1-frame)/p.exit):1;
 content.style.opacity=String(Math.min(incoming,outgoing));
 if(p.kind==="credits")content.style.transform="translateY("+(p.height-(p.height+height)*frame/(p.frames-1))+"px)";
 else content.style.transform="translateY("+((1-incoming)*8)+"px)";
 for(let i=0;i<words.length;i++){const phase=p.enter?clamp(frame/p.enter*words.length-i):1;words[i].style.opacity=String(phase);words[i].style.transform="translateY("+((1-phase)*8)+"px)";}
}
Promise.all([document.fonts.load("400 ${p.fontSize}px HVInter"),document.fonts.load("700 ${p.fontSize}px HVInter"),document.fonts.ready]).then(()=>{
 height=content.offsetHeight;
 const availableHeight=p.height-2*p.margin;
 window.__hvGraphic={contentHeight:height,availableHeight,overflow:content.scrollWidth>content.clientWidth+1||(p.kind!=="credits"&&height>availableHeight),fontsReady:document.fonts.status==="loaded",creditPixelsPerSecond:p.kind==="credits"?(p.height+height)*30/(p.frames-1):null};
 window.__hf={duration:p.frames/30,seek};seek(0);
}).catch(()=>{window.__hvGraphic={error:"Graphic fonts did not load."};});`;
  const scriptHash=Buffer.from(graphicHash(script),"hex").toString("base64");
  const vertical=p.kind==="credits"?"top:0;":p.kind==="lower-third"||p.kind==="watermark"?`bottom:${p.margin}px;`:`top:50%;translate:0 -50%;`;
  const html=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'"><title>Retained motion graphic</title><style>
${fontFaces}
*{box-sizing:border-box}html,body{margin:0;width:${p.width}px;height:${p.height}px;overflow:hidden;background:transparent}body{font-family:HVInter;font-synthesis:none;color:${p.color};text-align:${p.align}}#canvas{position:absolute;inset:0;background:${p.background??"transparent"}}
#content{position:absolute;left:${p.margin}px;width:${p.width-2*p.margin}px;${vertical}font-size:${p.fontSize}px;line-height:1.3;white-space:pre-wrap;overflow-wrap:anywhere}
.title{font-weight:700;margin:0;font-size:1em;line-height:1.18}.secondary{font-weight:400;font-size:.58em;margin-top:.5em}.secondary:empty,.title:empty{display:none}.accent{height:${Math.max(2,Math.round(p.fontSize*.06))}px;background:${p.accent};width:2em;margin:${p.align==="center"?".55em auto":p.align==="right"?".55em 0 .55em auto":".55em 0"}}
.credit{margin-top:1.2em}.role{font-weight:400;font-size:.55em;color:${p.accent}}.name{font-weight:700;font-size:.8em;margin-top:.15em}.word{display:inline-block}
</style></head><body><div id="canvas"></div><main id="content"><h1 class="title">${title}</h1>${p.kind==="slate"||p.kind==="lower-third"?'<div class="accent"></div>':""}<div class="secondary">${escape(p.secondary)}</div>${rows}</main><script>${script}</script></body></html>`;
  return {plan:p,html,htmlSha256:graphicHash(html),...assets};
}
