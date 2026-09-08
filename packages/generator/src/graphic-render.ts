import {mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync,statfsSync,writeFileSync} from "node:fs";
import {join,sep} from "node:path";
import {randomUUID} from "node:crypto";
import {createCaptureSession,initializeSession,captureFrameToBuffer,closeCaptureSession,decodePng,type CaptureSession} from "@hyperframes/engine";
import {GRAPHIC_RECIPE,GRAPHIC_CHROME_VERSION,validateMotionGraphic,type MotionGraphicPlan} from "../../planner/src/motion-graphics";
import {editFail} from "../../planner/src/edit-errors";
import {contentHash} from "./capabilities";
import {compileGraphic} from "./graphic-composition";
import {graphicHash} from "./graphic-fonts";
import {soundDigest} from "./sound-media";
import {soundProcessingCommand} from "./sound-finishing";

export {GRAPHIC_CHROME_VERSION} from "../../planner/src/motion-graphics";
export interface GraphicLayout {contentHeight:number;availableHeight:number;overflow:boolean;fontsReady:boolean;creditPixelsPerSecond:number|null}
export interface GraphicRenderReceipt {
  schema:"hv-graphic-render/1";plan:MotionGraphicPlan;recipe:typeof GRAPHIC_RECIPE;
  runtime:{browser:string;browserSha256:string;ffmpegSha256:string;platform:string;enginePackageSha256:string};
  composition:{file:string;sha256:string};fonts:{file:string;weight:number;range:string;sha256:string;bytes:number}[];
  license:{file:string;sha256:string};frameIndex:{file:string;sha256:string};layout:GraphicLayout;
  frames:{file:string;sha256:string;rgbaSha256:string;transparentPixels:number;visiblePixels:number}[];
  master:{file:string;sha256:string;bytes:number};revision:string;
}
type Access=()=>Promise<void>;
export function graphicDecodedHashes(raw:string,plan:MotionGraphicPlan):string[]{
  if(!/^#tb 0: 1\/30\r?$/m.test(raw)||!raw.includes(`#dimensions 0: ${plan.width}x${plan.height}`))editFail("The graphic master changed its frame clock or dimensions.");
  const rows=raw.split(/\r?\n/).filter(line=>line&&!line.startsWith("#")).map(line=>line.split(",").map(s=>s.trim()));
  if(rows.length!==plan.frames||rows.some((row,i)=>row.length!==6||row[0]!=="0"||row[1]!==String(i)||row[2]!==String(i)||row[3]!=="1"||row[4]!==String(plan.width*plan.height*4)||!/^[a-f0-9]{64}$/.test(row[5]!)))editFail("The graphic master changed its frame order, timing or RGBA byte count.");
  return rows.map(row=>row[5]!);
}
/** Isolated, bounded render of our compiled composition. No caller-supplied HTML, URL or JS enters Chrome. */
export async function renderMotionGraphic(plan:MotionGraphicPlan,directory:string,options:{chromePath:string;access:Access;signal?:AbortSignal;progress?:(completed:number,total:number)=>void}):Promise<{directory:string;receipt:GraphicRenderReceipt}>{
  await options.access();options.signal?.throwIfAborted();
  const p=validateMotionGraphic(plan),compiled=compileGraphic(p),parent=realpathSync(directory),browserPath=realpathSync(options.chromePath);
  // Bound actual compressed storage; a raw-duration estimate would reject ordinary credit rolls.
  const capacity=statfsSync(parent),reserve=Math.min(8*1024**3,capacity.bavail*capacity.bsize-128*1024**2);
  if(reserve<128*1024**2)editFail("The graphic needs at least 256 MiB of free workspace. Free disk space before rendering.");
  const root=mkdtempSync(join(parent,"graphic-"));let session:CaptureSession|undefined,success=false,failure:unknown,pending:Promise<void>|undefined;
  const nonce=randomUUID(),files=new Map<string,{bytes:Uint8Array|string;type:string}>([[`/${nonce}/index.html`,{bytes:compiled.html,type:"text/html; charset=utf-8"}]]);
  for(const f of compiled.fonts)files.set(`/${nonce}/${f.file}`,{bytes:f.data,type:"font/woff2"});
  const serve=()=>Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){const url=new URL(request.url),file=files.get(url.pathname);if(!["GET","HEAD"].includes(request.method)||url.search||!file)return new Response("Not found",{status:404});return new Response(request.method==="HEAD"?null:typeof file.bytes==="string"?file.bytes:new Uint8Array(file.bytes),{headers:{"Content-Type":file.type,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});}});let server:ReturnType<typeof serve>|undefined;
  const abort=()=>{if(session)void session.browser.close().catch(()=>{});};
  const timer=setTimeout(()=>{failure=new Error("Motion graphic rendering exceeded 30 minutes.");abort();},30*60*1000);
  const lease=setInterval(()=>{if(pending)return;pending=options.access().catch(error=>{failure=error;abort();}).finally(()=>{pending=undefined;});},2000);
  options.signal?.addEventListener("abort",abort,{once:true});
  const access=async()=>{options.signal?.throwIfAborted();if(failure)throw failure;await options.access();const disk=statfsSync(parent);if(disk.bavail*disk.bsize<64*1024**2)editFail("Graphic rendering is running out of disk space. Free space before trying again.");};
  try{
    server=serve();const origin=server.url.origin;
    mkdirSync(join(root,"fonts"));mkdirSync(join(root,"frames"));
    writeFileSync(join(root,"index.html"),compiled.html,{flag:"wx"});writeFileSync(join(root,"INTER-LICENSE.txt"),compiled.license,{flag:"wx"});
    for(const f of compiled.fonts)writeFileSync(join(root,f.file),f.data,{flag:"wx"});
    await access();const browserSha256=(await soundDigest(browserPath,options.signal)).sha256;
    const ffmpeg=Bun.spawnSync(["ffmpeg","-version"],{stdin:"ignore",stdout:"pipe",stderr:"pipe",timeout:10000});if(ffmpeg.exitCode!==0)editFail("Install the FFmpeg graphics runtime.");
    session=await createCaptureSession(`${origin}/${nonce}`,join(root,"frames"),{width:p.width,height:p.height,fps:{num:30,den:1},format:"png",deviceScaleFactor:1,compositionDurationSeconds:p.frames/30},null,{chromePath:browserPath,forceScreenshot:true,browserGpuMode:"software",enableBrowserPool:false,staticFrameDedup:false,useDrawElement:false,enablePageSideCompositing:false,browserTimeout:15000,protocolTimeout:30000,playerReadyTimeout:15000,pageNavigationTimeout:15000});
    await access();
    const browser=await session.browser.version();if(!browser.endsWith("/"+GRAPHIC_CHROME_VERSION))editFail("Install the pinned graphics Chrome version "+GRAPHIC_CHROME_VERSION+" before rendering.");
    // Defense in depth: fonts and the composition are the only browser requests admitted.
    await session.page.setRequestInterception(true);
    session.page.on("request",request=>{const url=new URL(request.url());void (url.origin===origin&&!url.search&&files.has(url.pathname)?request.continue():request.abort("blockedbyclient")).catch(()=>{});});
    await initializeSession(session);await access();
    const layout=await session.page.evaluate("window.__hvGraphic") as GraphicLayout;
    if(!layout?.fontsReady||layout.overflow||!Number.isFinite(layout.contentHeight)||layout.contentHeight<1)editFail("Graphic text exceeds its safe area or fonts are unavailable. Reduce the type size or shorten the text, then render again.");
    if(session.warnings.length||session.scriptLoadFailures.length)editFail("The graphics runtime reported incomplete composition loading.");
    const frames:GraphicRenderReceipt["frames"]=[];let bytes=compiled.fonts.reduce((n,f)=>n+f.bytes,Buffer.byteLength(compiled.html)+compiled.license.length);
    for(let frame=0;frame<p.frames;frame++){
      await access();const captured=await captureFrameToBuffer(session,frame,frame/30),png=decodePng(captured.buffer);
      if(png.width!==p.width||png.height!==p.height||png.data.length!==p.width*p.height*4||captured.buffer.length>32*1024**2)editFail("A graphic frame changed its dimensions or exceeded its buffer limit.");
      let transparentPixels=0,visiblePixels=0;for(let i=3;i<png.data.length;i+=4){if(png.data[i]===0)transparentPixels++;else visiblePixels++;}
      const file=`frames/${String(frame).padStart(6,"0")}.png`;writeFileSync(join(root,file),captured.buffer,{flag:"wx"});bytes+=captured.buffer.length;
      if(bytes>reserve/2)editFail("The graphic exceeded its reserved frame storage.");
      frames.push({file,sha256:graphicHash(captured.buffer),rgbaSha256:graphicHash(png.data),transparentPixels,visiblePixels});options.progress?.(frame+1,p.frames);
    }
    await closeCaptureSession(session);session=undefined;await access();
    await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-framerate","30","-threads","1","-i",join(root,"frames/%06d.png"),"-vf","setsar=1","-frames:v",String(p.frames),"-an","-c:v","ffv1","-level","3","-threads","1","-pix_fmt","bgra","-fflags","+bitexact","-flags:v","+bitexact","-map_metadata","-1","-fs",String(Math.floor(reserve/2)-32*1024**2),join(root,"graphic.mkv")],root,access,options.signal);
    await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-threads","1","-i",join(root,"graphic.mkv"),"-map","0:v:0","-an","-c:v","rawvideo","-threads","1","-pix_fmt","rgba","-fps_mode","passthrough","-f","framehash",join(root,"rgba-frames.txt")],root,access,options.signal);
    const hashes=graphicDecodedHashes(readFileSync(join(root,"rgba-frames.txt"),"utf8"),p);
    if(hashes.length!==p.frames||hashes.some((h,i)=>h!==frames[i]!.rgbaSha256))editFail("The graphic master changed a retained RGBA frame or its alpha channel.");
    const masterBytes=statSync(join(root,"graphic.mkv")).size;if(masterBytes+bytes>reserve)editFail("The graphic master exceeded its reserved workspace.");
    const data={schema:"hv-graphic-render/1" as const,plan:p,recipe:GRAPHIC_RECIPE,runtime:{browser,browserSha256,ffmpegSha256:graphicHash(ffmpeg.stdout.toString().replace(/\r\n/g,"\n")),platform:process.platform+"/"+process.arch,enginePackageSha256:graphicHash(readFileSync(new URL(import.meta.resolve("@hyperframes/engine/package.json"))))},composition:{file:"index.html",sha256:compiled.htmlSha256},fonts:compiled.fonts.map(({data:_data,...f})=>f),license:{file:"INTER-LICENSE.txt",sha256:graphicHash(compiled.license)},frameIndex:{file:"rgba-frames.txt",sha256:graphicHash(readFileSync(join(root,"rgba-frames.txt")))},layout,frames,master:{file:"graphic.mkv",sha256:(await soundDigest(join(root,"graphic.mkv"),options.signal)).sha256,bytes:masterBytes}};
    const receipt={...data,revision:contentHash(data)};writeFileSync(join(root,"graphic.json"),JSON.stringify(receipt,null,2)+"\n",{flag:"wx"});clearInterval(lease);await pending;await access();success=true;return {directory:root,receipt};
  }catch(error){if(failure)throw failure;options.signal?.throwIfAborted();throw error;}
  finally{
    clearTimeout(timer);clearInterval(lease);options.signal?.removeEventListener("abort",abort);await pending;if(session)await closeCaptureSession(session);await server?.stop(true);
    if(!success){if(!root.startsWith(parent+sep)||realpathSync(root)!==root)editFail("Graphic cleanup escaped its owned workspace.");rmSync(root,{recursive:true,force:true});}
  }
}

/** Verify a retained bundle before any later admission or compositing, including unused fonts. */
export async function verifyGraphicBundle(directory:string,expectedRevision:string,access:Access,signal?:AbortSignal):Promise<GraphicRenderReceipt>{
  await access();signal?.throwIfAborted();
  const root=realpathSync(directory),path=join(root,"graphic.json");if(statSync(path).size>16*1024**2)editFail("Graphic receipt exceeds its limit.");
  const receipt=JSON.parse(readFileSync(path,"utf8")) as GraphicRenderReceipt,{revision,...data}=receipt;
  if(receipt.schema!=="hv-graphic-render/1"||revision!==expectedRevision||revision!==contentHash(data)||contentHash(receipt.recipe)!==contentHash(GRAPHIC_RECIPE))editFail("The retained graphic receipt changed.");
  const p=validateMotionGraphic(receipt.plan),compiled=compileGraphic(p);
  if(receipt.composition.file!=="index.html"||receipt.composition.sha256!==compiled.htmlSha256||contentHash(receipt.fonts)!==contentHash(compiled.fonts.map(({data:_data,...f})=>f))||receipt.license.file!=="INTER-LICENSE.txt"||receipt.license.sha256!==graphicHash(compiled.license)||receipt.frames.length!==p.frames||receipt.master.file!=="graphic.mkv")editFail("The graphic text, fonts or frame count changed.");
  for(let i=0;i<p.frames;i++)if(receipt.frames[i]!.file!==`frames/${String(i).padStart(6,"0")}.png`)editFail("The retained graphic frames changed order.");
  if(receipt.frameIndex.file!=="rgba-frames.txt")editFail("The graphic lost its frame index.");
  const expected=[{file:"index.html",sha256:compiled.htmlSha256},{file:"INTER-LICENSE.txt",sha256:graphicHash(compiled.license)},receipt.frameIndex,...receipt.fonts,...receipt.frames,{file:"graphic.mkv",sha256:receipt.master.sha256}];
  for(const file of expected){await access();signal?.throwIfAborted();if(!/^(?:index\.html|INTER-LICENSE\.txt|graphic\.mkv|rgba-frames\.txt|fonts\/[0-9a-z-]+\.woff2|frames\/\d{6}\.png)$/.test(file.file))editFail("The graphic contains an unsupported retained path.");const target=join(root,file.file);if(realpathSync(target)!==target||!target.startsWith(root+sep)||(await soundDigest(target,signal)).sha256!==file.sha256)editFail("A retained graphic file changed or escaped its bundle.");}
  if(contentHash(graphicDecodedHashes(readFileSync(join(root,"rgba-frames.txt"),"utf8"),p))!==contentHash(receipt.frames.map(f=>f.rgbaSha256)))editFail("The graphic's retained frame evidence changed.");
  if(contentHash(readdirSync(root).sort())!==contentHash(["fonts","frames","graphic.json","graphic.mkv","index.html","INTER-LICENSE.txt","rgba-frames.txt"].sort())||readdirSync(join(root,"frames")).length!==p.frames||readdirSync(join(root,"fonts")).length!==compiled.fonts.length||statSync(join(root,"graphic.mkv")).size!==receipt.master.bytes)editFail("The graphic contains unexpected files, frames, fonts or master size.");await access();signal?.throwIfAborted();return receipt;
}
