import {mkdirSync,readFileSync,statSync} from "node:fs";
import {resolve} from "node:path";
import {motionGraphic} from "../packages/planner/src/motion-graphics";
import {renderMotionGraphic,verifyGraphicBundle} from "../packages/generator/src/graphic-render";

const [input,output,chromePath]=process.argv.slice(2);
if(!input||!output||!chromePath)throw new Error("Usage: bun scripts/render-graphic.ts graphic.json output-directory chrome-headless-shell-path");
if(statSync(input).size>128*1024)throw new Error("Graphic input exceeds 128 KiB.");
const plan=motionGraphic(JSON.parse(readFileSync(input,"utf8"))),destination=resolve(output);mkdirSync(destination,{recursive:true});
const result=await renderMotionGraphic(plan,destination,{chromePath:resolve(chromePath),access:async()=>{},progress:(n,total)=>{if(n===1||n===total||n%30===0)process.stderr.write(`Rendered ${n}/${total} frames\n`);}});
await verifyGraphicBundle(result.directory,result.receipt.revision,async()=>{});process.stdout.write(JSON.stringify({directory:result.directory,revision:result.receipt.revision,frames:result.receipt.frames.length,layout:result.receipt.layout},null,2)+"\n");
