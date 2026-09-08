import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {defaultMotionGraphic,motionGraphic,validateMotionGraphic,GRAPHIC_KINDS,type MotionGraphicPlan} from "../../planner/src/motion-graphics";
import {compileGraphic} from "../src/graphic-composition";
import {renderMotionGraphic,verifyGraphicBundle,graphicDecodedHashes} from "../src/graphic-render";
import {decodePng} from "@hyperframes/engine";

function changed(p:MotionGraphicPlan,patch:Record<string,unknown>){const {revision:_revision,...data}=p;return motionGraphic({...data,...patch});}
const empty=async()=>{};
function cleanup(parent:string){if(!parent.startsWith(realpathSync(tmpdir())+sep)||realpathSync(parent)!==parent)throw new Error("Unsafe fixture cleanup");rmSync(parent,{recursive:true,force:true});}
test("graphics bind readable text, layout and frame timing; compiler retains fonts and escapes markup",()=>{
  for(const kind of GRAPHIC_KINDS){const p=defaultMotionGraphic(kind,640,360),c=compileGraphic(p);expect(validateMotionGraphic(p)).toEqual(p);expect(c.fonts).toHaveLength(14);expect(c.license.toString()).toContain("SIL OPEN FONT LICENSE");expect(c.html).toContain("window.__hf={duration:p.frames/30,seek}");expect(c.html).not.toContain("https://");}
  const p=defaultMotionGraphic("title",640,360),xss=changed(p,{text:'</script><img src="https://invalid.test/pixel">',secondary:"Élodie — Мария — Ελληνικά"}),html=compileGraphic(xss).html;
  expect(html).toContain('&lt;/script&gt;&lt;img src=&quot;https://invalid.test/pixel&quot;&gt;');expect(html.match(/<script>/g)).toHaveLength(1);expect(html).toContain("default-src 'none'");
  expect(()=>compileGraphic(changed(p,{text:"😀"}))).toThrow("no glyph");expect(()=>changed(p,{text:"A\u202EB"})).toThrow("control");expect(()=>changed(p,{frames:2,enterFrames:1,exitFrames:1})).toThrow();expect(()=>changed(p,{background:"url(https://invalid.test)"})).toThrow("colors");expect(()=>validateMotionGraphic({...p,text:"Changed"})).toThrow("changed");expect(()=>changed(p,{html:"<script>"})).toThrow("supported");
});

const mediaTest=process.env.HV_GRAPHICS_CHROME_PATH?test:test.skip;
mediaTest("HyperFrames retains real transparent animation, lossless RGBA, fonts and repeatable seeks",async()=>{
  const parent=realpathSync(mkdtempSync(join(tmpdir(),"hv-graphics-"))),options={chromePath:process.env.HV_GRAPHICS_CHROME_PATH!,access:empty};
  try{
    const p=changed(defaultMotionGraphic("lower-third",320,180),{text:"Kevin",secondary:"Character performance",frames:16,enterFrames:4,exitFrames:4,fontSize:18,margin:16});
    const a=await renderMotionGraphic(p,parent,options),b=await renderMotionGraphic(p,parent,options);
    expect(a.receipt.frames.map(f=>f.rgbaSha256)).toEqual(b.receipt.frames.map(f=>f.rgbaSha256));
    expect(a.receipt.frames[0]!.visiblePixels).toBe(0);expect(a.receipt.frames.at(-1)!.visiblePixels).toBe(0);
    expect(a.receipt.frames[8]!.visiblePixels).toBeGreaterThan(100);expect(a.receipt.frames[8]!.transparentPixels).toBeGreaterThan(320*180*.75);
    expect(a.receipt.frames[4]!.rgbaSha256).toBe(a.receipt.frames[8]!.rgbaSha256);expect(a.receipt.frames[2]!.rgbaSha256).not.toBe(a.receipt.frames[8]!.rgbaSha256);
    expect(await verifyGraphicBundle(a.directory,a.receipt.revision,empty)).toEqual(a.receipt);expect(a.receipt.master.bytes).toBeGreaterThan(1000);expect(a.receipt.master.sha256).toBe(b.receipt.master.sha256);
    await expect(verifyGraphicBundle(a.directory,"f".repeat(64),empty)).rejects.toThrow("changed");
    const target=join(a.directory,a.receipt.frames[8]!.file);writeFileSync(target,Buffer.from("changed"));await expect(verifyGraphicBundle(a.directory,a.receipt.revision,empty)).rejects.toThrow("changed");
    const font=join(b.directory,b.receipt.fonts[0]!.file),originalFont=readFileSync(font);writeFileSync(font,Buffer.from("changed"));await expect(verifyGraphicBundle(b.directory,b.receipt.revision,empty)).rejects.toThrow("changed");writeFileSync(font,originalFont);
    writeFileSync(join(b.directory,"unrecorded.txt"),"extra");await expect(verifyGraphicBundle(b.directory,b.receipt.revision,empty)).rejects.toThrow("unexpected");rmSync(join(b.directory,"unrecorded.txt"));
    const credit=changed(defaultMotionGraphic("credits",320,180),{text:"Credits",frames:20,enterFrames:0,exitFrames:0,fontSize:18,margin:16,credits:[{role:"Performance",name:"Kevin"},{role:"Direction",name:"Marlando"}]});
    const c=await renderMotionGraphic(credit,parent,options);expect(c.receipt.layout.creditPixelsPerSecond).toBeGreaterThan(0);expect(new Set(c.receipt.frames.map(f=>f.rgbaSha256)).size).toBeGreaterThan(10);
    expect(c.receipt.frames.every(f=>f.transparentPixels===0)).toBe(true);
    const hashFile=readFileSync(join(c.directory,"rgba-frames.txt"),"utf8");expect(graphicDecodedHashes(hashFile,credit)).toEqual(c.receipt.frames.map(f=>f.rgbaSha256));expect(()=>graphicDecodedHashes(hashFile.replace("#tb 0: 1/30","#tb 0: 1/24"),credit)).toThrow("clock");
    const overflow=changed(p,{text:"Long text\n".repeat(35)});const before=readdirSync(parent);await expect(renderMotionGraphic(overflow,parent,options)).rejects.toThrow("safe area");expect(readdirSync(parent)).toEqual(before);
    const controller=new AbortController();await expect(renderMotionGraphic(p,parent,{...options,signal:controller.signal,progress:n=>{if(n===3)controller.abort();}})).rejects.toThrow();expect(readdirSync(parent)).toEqual(before);
    let available=true;await expect(renderMotionGraphic(p,parent,{...options,access:async()=>{if(!available)throw new Error("Permission withdrawn");},progress:n=>{if(n===4)available=false;}})).rejects.toThrow("Permission withdrawn");expect(readdirSync(parent)).toEqual(before);
    expect(JSON.parse(readFileSync(join(b.directory,"graphic.json"),"utf8")).revision).toBe(b.receipt.revision);
  }finally{cleanup(parent);}
},180000);

mediaTest("real title variants preserve declared background, supported scripts and watermark placement",async()=>{
  const parent=realpathSync(mkdtempSync(join(tmpdir(),"hv-graphic-variants-"))),options={chromePath:process.env.HV_GRAPHICS_CHROME_PATH!,access:empty};
  try{
    for(const kind of ["title","slate","watermark","kinetic"] as const){
      const p=changed(defaultMotionGraphic(kind,640,360),{text:kind==="watermark"?"REVIEW":"Élodie — Мария — Ελληνικά",secondary:kind==="watermark"?"":"Character performance",frames:8,enterFrames:0,exitFrames:0,fontSize:22,margin:24,background:kind==="slate"?"#123456":null});
      const result=await renderMotionGraphic(p,parent,options),frame=decodePng(readFileSync(join(result.directory,result.receipt.frames[4]!.file)));
      if(kind==="slate"){expect(Array.from(frame.data.slice(0,4))).toEqual([18,52,86,255]);expect(result.receipt.frames[4]!.transparentPixels).toBe(0);}else{expect(frame.data[3]).toBe(0);expect(result.receipt.frames[4]!.visiblePixels).toBeGreaterThan(100);}
      if(kind==="watermark"){let left=640,top=360;for(let y=0;y<360;y++)for(let x=0;x<640;x++)if(frame.data[(y*640+x)*4+3]){left=Math.min(left,x);top=Math.min(top,y);}expect(left).toBeGreaterThan(480);expect(top).toBeGreaterThan(300);}
    }
  }finally{cleanup(parent);}
},120000);
