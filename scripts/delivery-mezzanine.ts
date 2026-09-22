/**
 * Makes the mezzanine master of a rendered editorial job and prints what it wrote.
 *
 *   bun scripts/delivery-mezzanine.ts --conform <job>/conform [--out mezzanine.mkv]
 *
 * The conform directory is the one an editorial render leaves: `conform.json`, `timeline.json`, the
 * `picture/` master and `audio/final.wav`. Nothing in it is written to. The mezzanine is the two
 * streams copied out of it, and the exit code says whether the copy is provably the film: 0 when the
 * mezzanine's frames are the conform's own, 1 when it could not be made or could not be proved.
 *
 * Like the quality check, this is the operator's way to use the work before a job stage carries it.
 */
import {readFileSync,statSync} from "node:fs";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {renderDeliveryMezzanine} from "../packages/generator/src/delivery-mezzanine";
import {DELIVERY_MEZZANINE_RECIPE,deliveryMezzaninePlan,mezzanineSource} from "../packages/planner/src/delivery-mezzanine";

const option=(name:string,fallback?:string)=>{
  const index=process.argv.indexOf(name),value=index>=0?process.argv[index+1]:fallback;
  if(value===undefined||value.startsWith("--"))throw new Error("Give "+name+" a value. Usage: bun scripts/delivery-mezzanine.ts --conform <job>/conform [--out mezzanine.mkv]");
  return value;
};
const megabytes=(value:number)=>(value/1024**2).toFixed(1)+" MB";
let conformDirectory="",out="";
try{conformDirectory=resolve(option("--conform"));out=resolve(option("--out",join(conformDirectory,"mezzanine.mkv")));}
catch(error){console.error((error as Error).message);process.exit(1);}
const scratch=mkdtempSync(join(tmpdir(),"hv-mezzanine-"));
try{
  const read=(name:string)=>{const path=join(conformDirectory,name);
    if(statSync(path).size>192*1024**2)throw new Error("This conform's "+name+" exceeds its metadata limit.");
    return JSON.parse(readFileSync(path,"utf8"));};
  const conform=read("conform.json"),timeline=read("timeline.json");
  const parts=conform.picture.parts.map((part:{file:string})=>statSync(join(conformDirectory,part.file)).size);
  const plan=deliveryMezzaninePlan(mezzanineSource(conform,timeline,parts));
  console.log(conformDirectory);
  console.log("  "+plan.output.width+"x"+plan.output.height+" "+plan.output.frames+" frames, "+plan.output.durationSec.toFixed(2)+" s"
    +", "+plan.output.video+" "+plan.output.pixelFormat+" + "+plan.output.audio+" "+plan.output.sampleRate+" Hz "+plan.output.channels+" ch");
  console.log("  about "+megabytes(plan.estimatedBytes)+" from "+megabytes(plan.source.pictureBytes)+" of picture and "+megabytes(plan.source.mixBytes)+" of sound");
  const result=await renderDeliveryMezzanine(conformDirectory,plan,out,scratch,async()=>{});
  console.log("  written: "+result.file.path+" ("+megabytes(result.file.bytes)+", sha256 "+result.file.sha256.slice(0,16)+"…)");
  // The render refuses rather than returning a mezzanine whose frames are not the conform's, so
  // reaching this line is the proof. It is printed with the hash it was checked against.
  console.log("  every frame is this film's own, against the conform's recorded hashes ("+result.pictureFramesSha256.slice(0,16)+"…)");
  console.log("  not carried: "+DELIVERY_MEZZANINE_RECIPE.notCarried.join("; "));
  process.exit(0);
}catch(error){
  console.error("The mezzanine could not be made: "+(error instanceof Error?error.message:String(error)));
  process.exit(1);
}finally{rmSync(scratch,{recursive:true,force:true});}
