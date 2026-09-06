import {resolve} from "node:path";
import {compileWanMovePacket,readPacketInput,verifyWanMovePacket,writeWanMovePacket,MAX_MOTION_PLAN_BYTES} from "../packages/generator/src/wan-move-packet";

const usage="Compile: bun scripts/subject-motion.ts compile --plan PLAN.json --image SOURCE.png --out NEW_DIRECTORY\nVerify:  bun scripts/subject-motion.ts verify DIRECTORY\nCreates local Wan-Move inputs only; no model execution, network access or provider spend.";
export function subjectMotionCli(args:string[]):void {
  if(args.length===1&&["--help","-h"].includes(args[0]!)){console.log(usage);return;}
  if(args[0]==="verify"&&args.length===2){console.log(JSON.stringify(verifyWanMovePacket(resolve(args[1]!))));return;}
  if(args.length!==7||args[0]!=="compile")throw new Error(usage);
  const options=new Map<string,string>();
  for(let i=1;i<args.length;i+=2){const key=args[i]!,value=args[i+1]!;if(!["--plan","--image","--out"].includes(key)||options.has(key)||!value)throw new Error(usage);options.set(key,value);}
  const plan=JSON.parse(readPacketInput(resolve(options.get("--plan")!),MAX_MOTION_PLAN_BYTES).toString("utf8"));
  const packet=compileWanMovePacket(plan,readPacketInput(resolve(options.get("--image")!)));
  const directory=writeWanMovePacket(options.get("--out")!,packet);
  console.log(JSON.stringify({directory,...verifyWanMovePacket(directory)}));
}
if(import.meta.main)try{subjectMotionCli(process.argv.slice(2));}catch(error){console.error((error as Error).message);process.exitCode=1;}
