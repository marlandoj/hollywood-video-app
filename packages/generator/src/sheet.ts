import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { VideoClip } from "./index";
import { validateCharacterSheet, type CharacterSheetPlan } from "../../planner/src/sheets";
export const fileSha256=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
/** Assemble the actual generated views into a labeled contact sheet; no extra inference. */
export async function composeCharacterSheet(clips:VideoClip[], input:CharacterSheetPlan, outPath:string, signal:AbortSignal):Promise<string> {
  const plan=validateCharacterSheet(input);
  if(clips.length!==plan.views.length || clips.some(clip=>!clip.posterPath))throw new Error("Every sheet view must have a generated still.");
  const target=resolve(outPath),scratch=mkdtempSync(join(dirname(target),".hv-sheet-"));
  try {
    const columns=Math.min(4,Math.ceil(Math.sqrt(clips.length))), filters:string[]=[];
    for(const [index,view]of plan.views.entries()) {
      writeFileSync(join(scratch,"label-"+index+".txt"),view.label);
      filters.push(`[${index}:v]scale=512:512:force_original_aspect_ratio=decrease,pad=512:560:0:0:color=0x14171c,drawtext=font=DejaVu Sans:textfile=label-${index}.txt:expansion=none:fontcolor=white:fontsize=22:x=16:y=526[v${index}]`);
    }
    if(clips.length>1)filters.push(clips.map((_,index)=>`[v${index}]`).join("")+`xstack=inputs=${clips.length}:layout=`+clips.map((_,index)=>`${(index%columns)*512}_${Math.floor(index/columns)*560}`).join("|")+":fill=0x14171c[out]");
    signal.throwIfAborted();
    const child=Bun.spawn(["ffmpeg","-y","-v","error",...clips.flatMap(clip=>["-i",resolve(clip.posterPath!)]),"-filter_complex_threads","1","-filter_complex",filters.join(";"),"-map",clips.length>1?"[out]":"[v0]","-frames:v","1","-threads","1","-c:v","png","-map_metadata","-1","sheet.png"],{cwd:scratch,stdout:"ignore",stderr:"pipe"});
    const abort=()=>child.kill();const timer=setTimeout(abort,60_000);signal.addEventListener("abort",abort,{once:true});
    try {
      if(signal.aborted)abort();const [status,error]=await Promise.all([child.exited,new Response(child.stderr).text()]);signal.throwIfAborted();
      if(status!==0)throw new Error("Character sheet assembly failed: "+error.slice(-300));
    } finally {clearTimeout(timer);signal.removeEventListener("abort",abort);}
    renameSync(join(scratch,"sheet.png"),target);return fileSha256(target);
  } finally {rmSync(scratch,{recursive:true,force:true});}
}
