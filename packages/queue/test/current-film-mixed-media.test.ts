import {afterAll,beforeAll,expect,test} from "bun:test";
import {copyFileSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {dirname,join,resolve,relative} from "node:path";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {compileCurrentFilmMixedJob} from "../../planner/src/current-film-mixed-jobs";
import {compileCurrentFilmOrigins} from "../../planner/src/current-film-origins";
import {createCurrentFilmMixedCheckpoint} from "../../planner/src/current-film-mixed-context";
import {createCurrentFilmMixedOutput,currentFilmMixedRecordedFiles,type CurrentFilmMixedJob} from "../../planner/src/current-film-mixed-job-context";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {copyCurrentFilmOrigins} from "../../generator/src/current-film-origins-media";
import {copyCurrentFilmAdoption} from "../../generator/src/current-film-adoption-media";
import {verifyCurrentFilmMixedMedia} from "../src/current-film-mixed-media";
import {assembleCurrentFilmMixedAsync} from "../../assembler/src/index";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,root:string,fresh:CurrentFilmMixedJob,reused:CurrentFilmMixedJob;
beforeAll(async()=>{
  f=await currentFilmSourceFixture();root=mkdtempSync(join(f.studio.root,"mixed-restore-"));
  const {currentFilm:_plan,currentFilmCheckpoint:_checkpoint,output:_output,...base}=f.job;
  // Authentic original execution facts exercise the new verifier's format. This
  // fixture does not claim that V3 provider dispatch or queue activation occurred.
  const plan=compileCurrentFilmMixedJob(f.plan,{origins:[],choices:[]});
  fresh={...base,status:"running",completedAt:null,linkExpiresAt:null,currentFilm:plan,currentFilmOrigins:compileCurrentFilmOrigins(plan,f.job.id),checkpointShots:0,checkpointFrame:0};
  const rows=f.job.currentFilmCheckpoint!.rows.map(row=>({kind:"generated" as const,...row}));
  fresh.currentFilmCheckpoint=createCurrentFilmMixedCheckpoint(fresh,rows);fresh.checkpointShots=rows.length;fresh.checkpointFrame=f.job.checkpointFrame;
  for(const file of currentFilmMixedRecordedFiles(fresh)){const path=resolve(root,file.path);mkdirSync(dirname(path),{recursive:true});copyFileSync(resolve(f.studio.paths.artifactRoot,file.path),path);}
  const mixed=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:f.plan.materialization.slots.map((slot,ordinal)=>({
    ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,
      inputRevision:slot.inputRevision,recordRevision:f.job.currentFilmCheckpoint!.rows[ordinal]!.record.revision}}))});
  reused={...base,id:"mixed-restored-adoptions",status:"running",completedAt:null,linkExpiresAt:null,routeDecisions:[],currentFilm:mixed,checkpointShots:0,checkpointFrame:0};
  reused.currentFilmOrigins=await copyCurrentFilmOrigins(mixed,reused.id,f.studio.paths.artifactRoot,async()=>{});
  const adopted=[];
  for(const slot of mixed.materialization.slots){const adoption=await copyCurrentFilmAdoption(mixed,reused.id,slot.ordinal,f.studio.paths.artifactRoot,async()=>{});
    adopted.push({kind:"reused" as const,ordinal:slot.ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,adoption});}
  reused.currentFilmCheckpoint=createCurrentFilmMixedCheckpoint(reused,adopted);reused.checkpointShots=adopted.length;reused.checkpointFrame=adopted.reduce((sum,row)=>sum+row.adoption.frames,0);
  for(const file of currentFilmMixedRecordedFiles(reused)){const path=resolve(root,file.path);mkdirSync(dirname(path),{recursive:true});copyFileSync(resolve(f.studio.paths.artifactRoot,file.path),path);}
},240000);
afterAll(async()=>{await f?.close();});

test("actual generated prefix restores from its owned records without a clip manifest or cost receipt",async()=>{
  let checks=0;await verifyCurrentFilmMixedMedia(fresh,root,async()=>{checks++;});expect(checks).toBeGreaterThan(fresh.checkpointShots);
  expect(currentFilmMixedRecordedFiles(fresh).every(file=>lstatSync(resolve(root,file.path)).isFile())).toBe(true);
  const noOrigins=structuredClone(fresh);delete noOrigins.currentFilmOrigins;await expect(verifyCurrentFilmMixedMedia(noOrigins,root,async()=>{})).rejects.toThrow("prepared-original");
},90000);

test("complete original custody and reused roles restore without any original or carrier namespace",async()=>{
  // Remove only this test's previously copied generated owner, after proving it
  // stays in this unique fixture root. The retained owner is a separate subtree.
  const oldOwner=resolve(root,fresh.projectId,fresh.id),scope=resolve(root)+"/";
  if(!oldOwner.replaceAll("\\","/").startsWith(scope.replaceAll("\\","/")))throw new Error("Fixture cleanup escaped its root.");
  rmSync(oldOwner,{recursive:true});
  await verifyCurrentFilmMixedMedia(reused,root,async()=>{});
  expect(reused.currentFilmCheckpoint!.rows.every(row=>row.kind==="reused")).toBe(true);expect(reused.routeDecisions).toEqual([]);
  const {currentFilmCheckpoint:_checkpoint,...base}=reused;
  await verifyCurrentFilmMixedMedia({...base,checkpointShots:0,checkpointFrame:0},root,async()=>{});
},120000);

test("actual V3 export independently verifies its owned picture, captions and exact compact provenance",async()=>{
  const degradedShots=[reused.currentFilm.materialization.slots[0]!.renderId];
  const exported=await assembleCurrentFilmMixedAsync(reused,reused.currentFilmCheckpoint!,root,resolve(root,reused.projectId,reused.id),{access:async()=>{},degradedShots});
  const portable=(path:string)=>relative(root,path).replaceAll("\\","/");
  const job:CurrentFilmMixedJob={...reused,output:{mp4Path:portable(exported.mp4Path),hlsPlaylistPath:portable(exported.hlsPlaylistPath),captionsPath:portable(exported.vttPath),
    manifestPath:portable(exported.manifestPath),currentFilm:createCurrentFilmMixedOutput(reused,exported.currentFilmMixedClock,degradedShots)}};
  await verifyCurrentFilmMixedMedia(job,root,async()=>{});expect(job.output!.currentFilm.assembly.frames).toBe(f.job.output!.currentFilm!.assembly.frames);
  expect(job.output!.currentFilm.degradedShots).toEqual(degradedShots);
  const playlist=readFileSync(exported.hlsPlaylistPath),segment=playlist.toString("utf8").split(/\r?\n/).find(line=>line&&!line.startsWith("#"))!,segmentPath=join(dirname(exported.hlsPlaylistPath),segment),segmentBytes=readFileSync(segmentPath);
  try{rmSync(exported.hlsPlaylistPath);await expect(verifyCurrentFilmMixedMedia(job,root,async()=>{})).rejects.toThrow();}finally{writeFileSync(exported.hlsPlaylistPath,playlist);}
  try{rmSync(segmentPath);await expect(verifyCurrentFilmMixedMedia(job,root,async()=>{})).rejects.toThrow();}finally{writeFileSync(segmentPath,segmentBytes);}
  const manifest=readFileSync(exported.manifestPath),changed=JSON.parse(manifest.toString("utf8"));changed.shots[0].degraded=false;
  try{writeFileSync(exported.manifestPath,JSON.stringify(changed));await expect(verifyCurrentFilmMixedMedia(job,root,async()=>{})).rejects.toThrow();}finally{writeFileSync(exported.manifestPath,manifest);}
  const caption=readFileSync(exported.vttPath);try{writeFileSync(exported.vttPath,"changed captions");await expect(verifyCurrentFilmMixedMedia(job,root,async()=>{})).rejects.toThrow();}finally{writeFileSync(exported.vttPath,caption);}
},180000);

test("restore refuses corrupt unselected originals, missing adopted audio and revoked access",async()=>{
  const original=reused.currentFilmOrigins!.origins[0]!.copies.find(copy=>copy.original.path===f.job.output!.mp4Path)!,originalPath=resolve(root,original.owned.path),bytes=readFileSync(originalPath);
  try{const changed=Buffer.from(bytes);changed[changed.length-1]^=1;writeFileSync(originalPath,changed);await expect(verifyCurrentFilmMixedMedia(reused,root,async()=>{})).rejects.toThrow("checksum");}
  finally{writeFileSync(originalPath,bytes);}
  const audio=reused.currentFilmCheckpoint!.rows.flatMap(row=>row.kind==="reused"?row.adoption.copies:[]).find(copy=>copy.role==="audio")!,audioPath=resolve(root,audio.owned.path),wav=readFileSync(audioPath);
  const changedPcm=Buffer.from(wav);changedPcm[changedPcm.length-2]^=1;
  try{writeFileSync(audioPath,changedPcm);await expect(verifyCurrentFilmMixedMedia(reused,root,async()=>{})).rejects.toThrow("checksum");}finally{writeFileSync(audioPath,wav);}
  try{rmSync(audioPath);await expect(verifyCurrentFilmMixedMedia(reused,root,async()=>{})).rejects.toThrow();}finally{writeFileSync(audioPath,wav);}
  await expect(verifyCurrentFilmMixedMedia(reused,root,async()=>{throw new Error("fixture rights revoked");})).rejects.toThrow("rights revoked");
  const abort=new AbortController();abort.abort(new Error("fixture cancelled"));await expect(verifyCurrentFilmMixedMedia(reused,root,async()=>{},abort.signal)).rejects.toThrow("cancelled");
},120000);
