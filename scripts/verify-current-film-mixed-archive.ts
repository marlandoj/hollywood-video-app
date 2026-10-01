import {existsSync,lstatSync,readdirSync,readFileSync,realpathSync} from "node:fs";
import {join} from "node:path";
import type {Job} from "../packages/queue/src/index";
import {currentFilmV3Job} from "../packages/planner/src/current-film-runtime-context";
import {currentFilmMixedRecordedFiles} from "../packages/planner/src/current-film-mixed-job-context";
import {verifyCurrentFilmMixedMedia} from "../packages/queue/src/current-film-mixed-media";

/** Size-only boundary after full job validation; it never proves file contents. */
export function mixedArchiveFileSize(key:string,bytes:number,video?:{path:string;bytes:number;sha256:string}):boolean {
  return Number.isSafeInteger(bytes)&&bytes>=0&&(bytes<=8*1024**3||Boolean(video&&key===video.path&&bytes===video.bytes&&bytes<=128*1024**3&&/^[a-f0-9]{64}$/.test(video.sha256)));
}
/** Only exact measured MP4 roles can use the larger per-file bound. */
export function mixedArchiveLargeFiles(raw:Job):Map<string,{path:string;bytes:number;sha256:string}>{
  const job=currentFilmV3Job(raw),files=new Map<string,{path:string;bytes:number;sha256:string}>();
  if(job.output)files.set(job.output.mp4Path,{path:job.output.mp4Path,...job.output.currentFilm.assembly.video});
  const proof=job.currentFilmProof?.specification;
  for(const group of proof?.previews??[]){
    const preview=proof!.frozenContext.jobs.find(value=>value.id===group.jobId),output=preview?.output,video=output?.currentFilm?.assembly.video;
    if(!output||!video)continue;
    const copy=group.copies.find(value=>value.original.path===output.mp4Path);
    if(copy&&copy.original.bytes===video.bytes&&copy.original.sha256===video.sha256)files.set(copy.owned.path,copy.owned);
  }
  return files;
}

/** Fixed historical archive bridge. The enclosing snapshot establishes project,
 * bootstrap and approval closure. This verifies exact V3-owned media without
 * authorizing a live job, inventing a public clip manifest or relaxing V2 sources. */
export async function verifyCurrentFilmMixedArchive(raw:Job,artifactRoot:string):Promise<void> {
  const job=currentFilmV3Job(raw);
  if(!["done","failed","cancelled"].includes(job.status))throw new Error("Archive only drained mixed current films.");
  const root=realpathSync(artifactRoot);
  if(lstatSync(artifactRoot).isSymbolicLink()||!lstatSync(root).isDirectory())throw new Error("Use a real archive artifact root.");
  const owner=job.projectId+"/"+job.id,actual=new Set<string>(),large=mixedArchiveLargeFiles(job);let nodes=0;
  const walk=(key:string,depth:number):void=>{
    if(++nodes>200000||depth>220)throw new Error("Mixed archive inventory exceeds its traversal bound.");
    const path=join(root,key),stat=lstatSync(path);
    if(stat.isSymbolicLink()||realpathSync(path)!==path)throw new Error("Mixed archives cannot follow links.");
    if(stat.isDirectory()){for(const name of readdirSync(path))walk(key+"/"+name,depth+1);return;}
    if(!stat.isFile()||!mixedArchiveFileSize(key,stat.size,large.get(key))||actual.size>=100000)throw new Error("Mixed archives require bounded regular owned files.");
    actual.add(key);
  };
  const projectPath=join(root,job.projectId);
  if(existsSync(projectPath)&&(lstatSync(projectPath).isSymbolicLink()||realpathSync(projectPath)!==projectPath))throw new Error("Mixed archive project cannot be linked.");
  if(existsSync(join(root,owner)))walk(owner,0);
  if(!job.currentFilmOrigins&&!job.currentFilmProof){
    if(job.currentFilmCheckpoint||job.output||job.checkpointShots||job.checkpointFrame||actual.size)throw new Error("Unprepared mixed archive contains unowned media or progress.");
    return;
  }
  const expected=new Set(currentFilmMixedRecordedFiles(job).map(file=>file.path));
  if(job.output){
    const key=job.output.hlsPlaylistPath,path=join(root,key);
    if(!actual.has(key)||!actual.has(job.output.manifestPath)||job.output.c2paPath&&!actual.has(job.output.c2paPath)||!key.endsWith("/index.m3u8")||lstatSync(path).size>1024*1024)throw new Error("Mixed archive lost its bounded delivery files.");
    const lines=readFileSync(path,"utf8").split(/\r?\n/).map(line=>line.trim()),segments=lines.filter(line=>line&&!line.startsWith("#"));
    if(lines[0]!=="#EXTM3U"||!lines.includes("#EXT-X-ENDLIST")||!segments.length||segments.length>10000||new Set(segments).size!==segments.length
      ||segments.some(name=>!/^segment-\d{3,5}\.ts$/.test(name))||lines.some(line=>line.includes("URI=")||line.startsWith("#EXT-X-KEY")))throw new Error("Mixed archive delivery lost its exact owned segment paths.");
    expected.add(job.output.manifestPath);if(job.output.c2paPath)expected.add(job.output.c2paPath);expected.add(key);
    for(const name of segments)expected.add(key.slice(0,-"index.m3u8".length)+name);
  }
  if(actual.size!==expected.size||[...actual].some(key=>!expected.has(key)))throw new Error("Mixed archive media differs from its complete owned inventory.");
  // Sealed role hashes, native PCM, final frame clock and exact public provenance
  // are checked here. ZIP entry hashes bind delivery bytes captured by the archive;
  // PostgreSQL export/restore additionally checks the held delivery artifact index.
  await verifyCurrentFilmMixedMedia(job,root,async()=>{});
}
