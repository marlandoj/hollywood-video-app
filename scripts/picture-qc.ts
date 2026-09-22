/**
 * Measures a delivered film and prints what it found. HV-026-01 built the check and nothing called
 * it; this is the operator's way to run it, on a master that already exists, without a project token
 * or a provider key.
 *
 *   bun scripts/picture-qc.ts --file export.mp4 [--out report.json]
 *
 * It reads one file and writes only what --out names. Exit 0 when the verdict is pass, 2 when it is
 * review, 1 when the check could not run — so a shell can tell "nothing to look at" from "look".
 */
import {writeFileSync} from "node:fs";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {measurePictureQc} from "../packages/generator/src/picture-qc";
import {PICTURE_QC_RECIPE} from "../packages/planner/src/picture-qc";

const option=(name:string,fallback?:string)=>{
  const index=process.argv.indexOf(name),value=index>=0?process.argv[index+1]:fallback;
  if(value===undefined||value.startsWith("--"))throw new Error("Give "+name+" a value. Usage: bun scripts/picture-qc.ts --file <film.mp4> [--out report.json]");
  return value;
};
const seconds=(value:number)=>Math.round(value*100)/100;
let file="",out="";
try{file=option("--file");out=option("--out","");}
catch(error){console.error((error as Error).message);process.exit(1);}
const scratch=mkdtempSync(join(tmpdir(),"hv-picture-qc-"));
try{
  const report=await measurePictureQc(file,scratch,async()=>{});
  const {programme,picture,sound}=report;
  console.log(file);
  console.log("  "+programme.width+"x"+programme.height+" "+programme.frameRate+" "+programme.pixelFormat+" "+programme.video
    +", "+(programme.audio?programme.audio+" "+programme.sampleRate+" Hz "+programme.channels+" ch":"no audio")
    +", "+seconds(programme.durationSec)+" s, "+programme.bytes+" bytes");
  console.log("  luma "+(picture.lumaMin??"-")+"-"+(picture.lumaMax??"-")+" over "+picture.framesSampled+" frames"
    +", sound "+(sound.meanVolumeDb===null?"silent":seconds(sound.meanVolumeDb)+" dB mean")+(sound.maxVolumeDb===null?"":", "+seconds(sound.maxVolumeDb)+" dB peak"));
  for(const finding of report.findings)console.log("  "+finding.severity.toUpperCase()+" "+finding.code+": "+finding.message);
  console.log("  verdict: "+report.verdict);
  console.log("  not checked: "+PICTURE_QC_RECIPE.notChecked.join("; "));
  if(out){writeFileSync(out,JSON.stringify(report,null,2)+"\n");console.log("  written: "+out);}
  process.exit(report.verdict==="pass"?0:2);
}catch(error){
  console.error("The quality check could not run: "+(error instanceof Error?error.message:String(error)));
  process.exit(1);
}finally{rmSync(scratch,{recursive:true,force:true});}
