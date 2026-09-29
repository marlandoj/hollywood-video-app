import {afterAll,beforeAll,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {existsSync,lstatSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from "node:fs";
import {dirname,join,resolve,sep} from "node:path";
import {tmpdir} from "node:os";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {currentFilmV2Job,createCurrentFilmPreviewReview} from "../../planner/src/current-film-job-context";
import {DurableJobStore,type JobInput,type Job} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {currentFilmRuntimeRecordedFiles} from "../../planner/src/current-film-runtime-context";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3} from "../../planner/src/current-film-mixed-jobs";
import {compileCurrentFilmJob} from "../../planner/src/current-film-jobs";
import {compileCurrentFilmProofClosure} from "../../planner/src/current-film-proof-closure";
import {compileCurrentFilmProofTarget,type CurrentFilmProofTarget} from "../../planner/src/current-film-proof-target";
import {compileCurrentFilmProofCopies,freezeCurrentFilmProofContext,type CurrentFilmProofCopies,type CurrentFilmProofCopy} from "../../planner/src/current-film-proof-copies";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {bootstrapCurrentScreenplayLibrary,emptyCurrentScreenplayLibrary} from "../../planner/src/current-screenplay-library";
import {castingSnapshot} from "../../planner/src/casting";
import {referenceLocalKey} from "../../planner/src/references";
import {normalizeReference} from "../../storage/src/references";
import {contentHash as hash} from "../src/capabilities";
import {prepareCurrentFilmProofCopies} from "../src/current-film-proof-copy";
import {verifyCurrentFilmProofMedia} from "../src/current-film-proof-media";
import {soundProcessingCommand} from "../src/sound-finishing";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,plan:CurrentFilmJobV3,proof:CurrentFilmProofCopies,referencePlan:CurrentFilmJobV3,referenceProof:CurrentFilmProofCopies;
let root:string,referenceRoot:string,sourceRoot:string;const roots:string[]=[],targetId="owned-proof-media",referenceTarget="owned-reference-proof";
let targetProof:CurrentFilmProofCopies,targetRoot:string,deduplicated:CurrentFilmProofCopies,secondPreview:Job,targetJob:Job;
const finalTargetId="owned-proof-final-target";
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const all=(value:CurrentFilmProofCopies)=>[...value.carriers.flatMap(row=>row.copies),...value.previews.flatMap(row=>row.copies),...value.references.map(row=>row.copy)];
function workspace():string {const path=realpathSync(mkdtempSync(join(tmpdir(),"hv-owned-proof-")));roots.push(path);return path;}
function selection(target:CurrentFilmJobV3,jobs:Parameters<typeof freezeCurrentFilmProofContext>[0]["jobs"],project:Parameters<typeof freezeCurrentFilmProofContext>[0]["project"],proofTarget?:CurrentFilmProofTarget){
  const frozenContext=freezeCurrentFilmProofContext({project,jobs}),closure=compileCurrentFilmProofClosure(target,frozenContext,proofTarget);
  return {frozenContext,...(proofTarget?{target:proofTarget}:{}),carriers:closure.receipts.map(({receipt,candidates})=>{const {files:_files,...chosen}=candidates[0]!;return {receiptRevision:receipt.revision,...chosen};}),
    previews:closure.previews.map(({job})=>{
      const output=job.output!,paths=new Set(currentFilmRuntimeRecordedFiles(job).map(file=>file.path));
      for(const path of [output.mp4Path,output.hlsPlaylistPath,output.captionsPath,output.captionsPath.slice(0,-4)+".srt",output.manifestPath,`${job.projectId}/${job.id}/clips/manifest.json`])paths.add(path);
      const prefix=output.hlsPlaylistPath.slice(0,-"index.m3u8".length);for(const name of readdirSync(join(sourceRoot,dirname(output.hlsPlaylistPath))))paths.add(prefix+name);
      return {jobId:job.id,files:[...paths].sort().map(path=>{const bytes=readFileSync(join(sourceRoot,path));return {path,sha256:sha(bytes),bytes:bytes.length};})};
    })};
}
beforeAll(async()=>{
  f=await currentFilmSourceFixture();sourceRoot=f.studio.paths.artifactRoot;const final=await f.renderFinal(),source=currentFilmV2Job(final.job),base=source.currentFilm;
  if(!base)throw new Error("Retain the actual final fixture plan.");const slot=base.materialization.slots[0]!,record=source.currentFilmCheckpoint!.rows[0]!.record;
  plan=compileCurrentFilmMixedJob(base,{origins:[bindOriginalEditSource(final.receipt)],choices:[{ordinal:0,inputRevision:slot.inputRevision,originId:final.receipt.revision,
    source:{receiptRevision:final.receipt.revision,ordinal:0,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}}]});
  proof=compileCurrentFilmProofCopies(plan,targetId,selection(plan,[f.studio.film,f.job,final.job],f.projects.snapshot().projects[0]!));root=workspace();
  const read=async(copy:CurrentFilmProofCopy,signal:AbortSignal)=>{signal.throwIfAborted();return new Response(Bun.file(join(sourceRoot,copy.carrier.path)).stream(),{headers:{etag:'"'+copy.carrier.sha256+'"',"content-length":String(copy.carrier.bytes)}});};
  await prepareCurrentFilmProofCopies(proof,plan,targetId,root,read,async()=>{});
  // A distinct actual preview is generated before its own saved review. The
  // target is an admitted V3 envelope, with no fabricated output or Job rename.
  const input=(id:string,p:typeof f.plan|CurrentFilmJobV3,previewId:string|null=null,approvedAt:string|null=null):JobInput=>({
    id,idempotencyKey:id,projectId:p.projectId,currentFilm:p,tier:p.render.tier,stage:p.render.stage,scriptVersion:p.materialization.script.version,
    scriptText:p.materialization.script.text,casting:p.target.state.casting.candidate!,providerPlan:p.render.providerPlan,rightsAttestedAt:f.project.rightsAttestedAt,
    animaticJobId:previewId,animaticApprovedAt:approvedAt,totalFrames:p.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,
    retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:300000});
  f.store.enqueue(input("proof-target-second-preview",f.plan));
  const actual=await processNextJob(f.store,sourceRoot,f.context);
  if(!actual||actual.status!=="done")throw new Error("The second actual proof preview failed: "+actual?.failureReason);
  secondPreview=currentFilmV2Job(actual);
  const decision=f.projects.recordCurrentFilmDecision(f.studio.owner.token,secondPreview,createCurrentFilmPreviewReview(secondPreview),"approved","Review the distinct target preview")!;
  targetJob=DurableJobStore.fromJobs([]).enqueue(input(finalTargetId,plan,secondPreview.id,decision.approval.at));
  const savedProject=f.projects.snapshot().projects[0]!,jobs=[f.studio.film,f.job,final.job,secondPreview,targetJob],target=compileCurrentFilmProofTarget(targetJob);
  targetProof=compileCurrentFilmProofCopies(plan,finalTargetId,selection(plan,jobs,savedProject,target));targetRoot=workspace();
  await prepareCurrentFilmProofCopies(targetProof,plan,finalTargetId,targetRoot,read,async()=>{});
  const sameTarget=DurableJobStore.fromJobs([]).enqueue(input("owned-proof-deduplicated",plan,source.animaticJobId,source.animaticApprovedAt));
  deduplicated=compileCurrentFilmProofCopies(plan,sameTarget.id,selection(plan,jobs,savedProject,compileCurrentFilmProofTarget(sameTarget)));
  // A second genuine canonical project root declares an actual normalized PNG.
  // This is an all-fresh plan, not a fabricated rendered/captured reference job.
  const referenceFrame=join(f.studio.root,"proof-reference-frame.png");
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-i",join(sourceRoot,source.output!.mp4Path),
    "-map","0:v:0","-frames:v","1","-threads","1","-update","1",referenceFrame],f.studio.root,async()=>{},AbortSignal.timeout(30000));
  const canonical=await normalizeReference(readFileSync(referenceFrame),plan.projectId),original=f.originalProject.currentScreenplay!.origin!,at=Date.now(),characters=structuredClone(original.request.baseline.casting.characters);
  characters[0]!.references=[canonical.asset];const casting=castingSnapshot(plan.projectId,original.request.baseline.casting.version+1,characters,at);
  const library=bootstrapCurrentScreenplayLibrary(emptyCurrentScreenplayLibrary(plan.projectId),{...original.request,id:"actual-reference-proof",baseline:{...original.request.baseline,casting}},0,at).library,
    preview=compileCurrentFilmJob(library,{kind:"accepted",revision:library.headRevision!},{role:"preview",tier:"free",providerPlan:f.plan.render.providerPlan},at+1);
  referencePlan=compileCurrentFilmMixedJob(preview,{origins:[],choices:[]});referenceProof=compileCurrentFilmProofCopies(referencePlan,referenceTarget,selection(referencePlan,[f.studio.film],{...f.originalProject,currentScreenplay:library,referenceAssets:[canonical.asset]}));referenceRoot=workspace();
  await prepareCurrentFilmProofCopies(referenceProof,referencePlan,referenceTarget,referenceRoot,async(copy,signal)=>copy.carrier.path===referenceLocalKey(canonical.asset)
    ?new Response(new Uint8Array(canonical.data),{headers:{etag:'"'+copy.carrier.sha256+'"',"content-length":String(copy.carrier.bytes)}}):read(copy,signal),async()=>{});
  // Neither restored tree contains any legacy source/carrier directory. Close
  // the original fixture too, so later verification cannot accidentally use it.
  await f.close();expect(existsSync(sourceRoot)).toBe(false);
},300000);
afterAll(async()=>{
  for(const path of roots){const actual=resolve(path),parent=realpathSync(tmpdir());if(!actual.startsWith(parent+sep)||!actual.slice(parent.length+1).startsWith("hv-owned-proof-")||realpathSync(actual)!==actual)throw new Error("Unsafe owned proof test cleanup");rmSync(actual,{recursive:true,force:true});}
  if(f&&existsSync(sourceRoot))await f.close();
});

test("actual bootstrap, V2 final and reviewed preview verify only from independently owned roots without rewritten records or source files",async()=>{
  const before=hash({plan,proof}),digests=all(proof).map(copy=>sha(readFileSync(join(root,copy.owned.path))));let access=0;
  await verifyCurrentFilmProofMedia(proof,plan,targetId,root,async()=>{access++;});
  expect(access).toBeGreaterThan(proof.files);expect(hash({plan,proof})).toBe(before);expect(proof.mediaVerified).toBe(false);expect(proof.currentAuthority).toBe(false);
  expect(all(proof).map(copy=>sha(readFileSync(join(root,copy.owned.path))))).toEqual(digests);
  expect(existsSync(join(root,plan.projectId,f.job.id))).toBe(false);expect(existsSync(sourceRoot)).toBe(false);
  // HV-016-30: the emptied scratch parent is removed too, so nested verification leaves no directory.
  expect(existsSync(join(root,plan.projectId,targetId,".proof-check"))).toBe(false);
},180000);

test("missing and bit-flipped original/native/preview roles refuse without repairing any published file",async()=>{
  const native=proof.carriers.flatMap(group=>group.copies).find(copy=>copy.original.path.endsWith(".wav"))!,video=proof.previews[0]!.copies.find(copy=>copy.original.path.endsWith(".mp4"))!;
  const path=join(root,native.owned.path),bytes=readFileSync(path),inode=lstatSync(path).ino;
  try{const changed=Buffer.from(bytes);changed[44]=changed[44]!^1;writeFileSync(path,changed);await expect(verifyCurrentFilmProofMedia(proof,plan,targetId,root,async()=>{})).rejects.toThrow(/checksum|PCM|bytes/);expect(readFileSync(path)).toEqual(changed);}
  finally{writeFileSync(path,bytes);}expect(lstatSync(path).ino).toBe(inode);
  const picture=join(root,video.owned.path),held=picture+".test-held";renameSync(picture,held);
  try{await expect(verifyCurrentFilmProofMedia(proof,plan,targetId,root,async()=>{})).rejects.toThrow(/proof|role|file/);expect(existsSync(picture)).toBe(false);}
  finally{renameSync(held,picture);}
},180000);

test("a resealed preview inventory cannot omit or add segments relative to the actual unchanged playlist",async()=>{
  const base=proof.previews[0]!,segments=base.copies.filter(copy=>copy.original.path.endsWith(".ts"));expect(segments.length).toBeGreaterThan(0);
  const source=base.copies.find(copy=>copy.original.path.endsWith("index.m3u8"))!,playlist=readFileSync(join(root,source.owned.path),"utf8"),segment=segments[0]!,name=segment.original.path.split("/").at(-1)!;
  // Alter only the indexed segment identity and actual owned filename. The
  // original immutable Job and actual playlist bytes remain unchanged.
  const original=segment.original.path,extra=original.replace(/segment-\d{3,5}\.ts$/,"segment-99999.ts"),supplied=selectionFromProof(proof);
  supplied.previews[0]!.files=supplied.previews[0]!.files.map(file=>file.path===original?{...file,path:extra}:file);
  const changed=compileCurrentFilmProofCopies(plan,targetId,supplied),copy=changed.previews[0]!.copies.find(value=>value.original.path===extra)!;
  renameSync(join(root,segment.owned.path),join(root,copy.owned.path));
  try{await expect(verifyCurrentFilmProofMedia(changed,plan,targetId,root,async()=>{})).rejects.toThrow("segment inventory differ");expect(readFileSync(join(root,source.owned.path),"utf8")).toBe(playlist);expect(playlist).toContain(name);}
  finally{renameSync(join(root,copy.owned.path),join(root,segment.owned.path));}
},180000);
function selectionFromProof(value:CurrentFilmProofCopies){return {frozenContext:value.frozenContext,...(value.target?{target:value.target}:{}),carriers:value.carriers.map(({copies:_copies,...row})=>row),previews:value.previews.map(group=>({jobId:group.jobId,files:group.copies.map(copy=>copy.original)}))};}

test("the actual target preview and distinct historical preview both retain exact owned media, while a shared preview is copied once",async()=>{
  expect(targetJob.status).toBe("queued");expect(targetJob.output).toBeUndefined();expect(secondPreview.id).not.toBe(f.job.id);
  expect(targetProof.previews.map(row=>row.jobId).sort()).toEqual([f.job.id,secondPreview.id].sort());
  expect(deduplicated.previews.map(row=>row.jobId)).toEqual([f.job.id]);
  expect(deduplicated.previews[0]!.copies.map(copy=>copy.original)).toEqual(proof.previews[0]!.copies.map(copy=>copy.original));
  expect(new Set(all(targetProof).map(copy=>copy.owned.path)).size).toBe(targetProof.files);
  const before=hash({targetJob,targetProof}),originals=all(targetProof).map(copy=>sha(readFileSync(join(targetRoot,copy.owned.path))));
  await verifyCurrentFilmProofMedia(targetProof,plan,finalTargetId,targetRoot,async()=>{});
  expect(hash({targetJob,targetProof})).toBe(before);expect(all(targetProof).map(copy=>sha(readFileSync(join(targetRoot,copy.owned.path))))).toEqual(originals);
  expect(targetProof.mediaVerified).toBe(false);expect(existsSync(sourceRoot)).toBe(false);
  const role=targetProof.previews.find(row=>row.jobId===secondPreview.id)!.copies.find(copy=>copy.original.path.endsWith(".mp4"))!,
    path=join(targetRoot,role.owned.path),held=join(targetRoot,plan.projectId,finalTargetId,"missing-target-preview.mp4");
  renameSync(path,held);
  try{await expect(verifyCurrentFilmProofMedia(targetProof,plan,finalTargetId,targetRoot,async()=>{})).rejects.toThrow(/proof|role|file/);expect(existsSync(path)).toBe(false);}
  finally{renameSync(held,path);}
},180000);

test("canonical reference bytes independently decode and changed PNG data refuses",async()=>{
  expect(referenceProof.references).toHaveLength(1);await verifyCurrentFilmProofMedia(referenceProof,referencePlan,referenceTarget,referenceRoot,async()=>{});
  const file=referenceProof.references[0]!.copy.owned,path=join(referenceRoot,file.path),bytes=readFileSync(path);
  try{const changed=Buffer.from(bytes);changed[20]=changed[20]!^1;writeFileSync(path,changed);await expect(verifyCurrentFilmProofMedia(referenceProof,referencePlan,referenceTarget,referenceRoot,async()=>{})).rejects.toThrow(/checksum|PNG/);}
  finally{writeFileSync(path,bytes);}
},180000);

test("revoked access, cancellation, unknown files and linked proof paths fail without mutating owned state",async()=>{
  const before=hash(proof),denied=new Error("current proof access revoked");
  await expect(verifyCurrentFilmProofMedia(proof,plan,targetId,root,async()=>{throw denied;})).rejects.toBe(denied);
  const controller=new AbortController();controller.abort(denied);await expect(verifyCurrentFilmProofMedia(proof,plan,targetId,root,async()=>{},controller.signal)).rejects.toBe(denied);
  const extra=join(root,plan.projectId,targetId,"proof","unreviewed.bin");writeFileSync(extra,"leave untouched");
  try{await expect(verifyCurrentFilmProofMedia(proof,plan,targetId,root,async()=>{})).rejects.toThrow("unreviewed");expect(readFileSync(extra,"utf8")).toBe("leave untouched");}finally{unlinkSync(extra);}
  const original=proof.carriers[0]!.copies[0]!,path=join(root,original.owned.path),held=join(root,plan.projectId,targetId,"linked-test-held.bin");renameSync(path,held);
  try{symlinkSync(dirname(path),path,process.platform==="win32"?"junction":"dir");await expect(verifyCurrentFilmProofMedia(proof,plan,targetId,root,async()=>{})).rejects.toThrow(/linked|redirected/);}
  finally{if(lstatSync(path).isSymbolicLink())unlinkSync(path);renameSync(held,path);}
  expect(hash(proof)).toBe(before);
},180000);
