import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {PICTURE_QC_RECIPE,validatePictureQcReport} from "../../planner/src/picture-qc";

const root=mkdtempSync(join(tmpdir(),"hv-picture-qc-script-"));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const SCRIPT=fileURLToPath(new URL("../../../scripts/picture-qc.ts",import.meta.url));

async function media(name:string,args:string[]):Promise<string>{
  const path=join(root,name);
  const child=Bun.spawn(["ffmpeg","-v","error","-nostdin",...args,"-y",path],{cwd:root,stdin:"ignore",stdout:"ignore",stderr:"pipe"});
  const log=await new Response(child.stderr).text();
  expect({name,code:await child.exited,log}).toEqual({name,code:0,log:""});
  return path;
}
async function run(...args:string[]){
  const child=Bun.spawn([process.execPath,SCRIPT,...args],{cwd:root,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  return {code,stdout,stderr};
}

test("a finished film measures clean and says so, and a broken one reports what to look at",async()=>{
  const good=await media("good.mp4",["-f","lavfi","-i","testsrc2=size=320x240:rate=30:duration=2","-f","lavfi","-i",
    "sine=frequency=440:sample_rate=48000:duration=2","-map","0:v:0","-map","1:a:0","-vf","scale=in_range=full:out_range=limited",
    "-c:v","libx264","-pix_fmt","yuv420p","-r","30","-c:a","aac","-t","2"]);
  const passed=await run("--file",good);
  expect(passed.stderr).toBe("");
  expect(passed.stdout).toContain("320x240 30/1 yuv420p h264");
  expect(passed.stdout).toContain("aac 48000 Hz");
  expect(passed.stdout).toContain("verdict: pass");
  // The check says what it did not look at every time it runs, not only in its documentation.
  expect(passed.stdout).toContain(PICTURE_QC_RECIPE.notChecked[0]!);
  expect(passed.code).toBe(0);

  const bad=await media("bad.mp4",["-f","lavfi","-i","color=c=black:s=320x240:r=30:d=3","-f","lavfi","-i",
    "anullsrc=sample_rate=48000:channel_layout=mono","-map","0:v:0","-map","1:a:0","-c:v","libx264","-pix_fmt","yuv420p","-r","30","-c:a","aac","-t","3"]);
  const reviewed=await run("--file",bad,"--out",join(root,"report.json"));
  expect(reviewed.stdout).toContain("WARNING black-picture");
  expect(reviewed.stdout).toContain("WARNING frozen-picture");
  expect(reviewed.stdout).toContain("verdict: review");
  // A shell can tell "nothing to look at" from "look".
  expect(reviewed.code).toBe(2);

  // What it wrote is a report the contract still recognises as its own.
  const written=JSON.parse(readFileSync(join(root,"report.json"),"utf8"));
  expect(validatePictureQcReport(written)).toEqual(written);
  expect(written.verdict).toBe("review");
},120_000);

test("the check refuses what it cannot measure, on its own exit code",async()=>{
  const missing=await run("--file",join(root,"absent.mp4"));
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("could not run");
  expect(missing.stdout).toBe("");
  const text=join(root,"notafilm.mp4");
  await Bun.write(text,"this is not a film");
  const refused=await run("--file",text);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("could not run");
  const usage=await run("--file");
  expect(usage.code).toBe(1);
  expect(usage.stderr).toContain("Usage: bun scripts/picture-qc.ts");
},60_000);
