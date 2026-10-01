import {createHash} from "node:crypto";
import {lstatSync,mkdirSync,opendirSync,readFileSync,realpathSync,rmdirSync,unlinkSync,type Stats} from "node:fs";
import {join} from "node:path";
import type {Job} from "../../queue/src/index";
import {verifyRecordedClipFrames,verifyRecordedSpeechMedia} from "../../queue/src/current-film-media";
import {verifyCurrentFilmMixedMedia} from "../../queue/src/current-film-mixed-media";
import {buildCaptions} from "../../assembler/src/index";
import {resolveCurrentFilmProofCopies,type CurrentFilmProofCopies,type CurrentFilmProofCopy} from "../../planner/src/current-film-proof-copies";
import type {CurrentFilmJobV3} from "../../planner/src/current-film-mixed-jobs";
import {currentFilmV3Job} from "../../planner/src/current-film-runtime-context";
import {currentFilmV2Job} from "../../planner/src/current-film-job-context";
import {resolveCurrentFilmMixedAssembly} from "../../planner/src/current-film-mixed-clock";
import {renderShots,type RenderFile,type ShotRenderRecord} from "../../planner/src/shot-reuse";
import type {ReferenceAsset} from "../../planner/src/references";
import {contentHash as hash} from "./capabilities";
import {provenanceSidecarAgrees} from "../../planner/src/provenance";
import {withEditSourceAccess,verifyEditOriginalMedia,verifyEditOriginalSemantics,measureEditSourceFacts} from "./edit-source-media";
import {currentFilmWorkspaceGuard} from "./current-film-workspace";

type Access=()=>Promise<void>;
function fail(message:string):never {throw new Error(message);}
function components(root:string,key:string,create=false):string {
  if(!/^[A-Za-z0-9._/-]+$/.test(key)||key.split("/").some(part=>!part||part==="."||part===".."))fail("Proof media escaped its exact owned namespace.");
  let path=root;
  for(const part of key.split("/")){
    path=join(path,part);if(create)try{mkdirSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    if(lstatSync(path).isSymbolicLink()||realpathSync(path)!==path)fail("Proof verification refuses linked or redirected paths.");
  }return path;
}
function owned(root:string,file:RenderFile):string {const path=components(root,file.path),stat=lstatSync(path);if(!stat.isFile()||stat.size!==file.bytes)fail("An owned proof role is missing or changed.");return path;}
function boundedText(path:string,max:number):string {const size=lstatSync(path).size;if(size<1||size>max)fail("Proof metadata exceeds its bounded file size.");return readFileSync(path,"utf8");}
function allCopies(proof:CurrentFilmProofCopies):CurrentFilmProofCopy[]{return [...proof.carriers.flatMap(group=>group.copies),...proof.previews.flatMap(group=>group.copies),...proof.references.map(group=>group.copy)];}
/** Refuse unknown entries immediately, including empty foreign directories. */
function exactTree(root:string,proof:CurrentFilmProofCopies):void {
  const base=`${proof.projectId}/${proof.jobId}/proof`,files=new Map(allCopies(proof).map(copy=>[copy.owned.path,copy.owned])),directories=new Set([base]);
  for(const key of files.keys()){const parts=key.split("/");while(parts.length>3){parts.pop();directories.add(parts.join("/"));}}
  const stack=[base],seen=new Set<string>();
  while(stack.length){const key=stack.pop()!,directory=components(root,key),handle=opendirSync(directory);
    try{for(let entry=handle.readSync();entry;entry=handle.readSync()){
      const child=key+"/"+entry.name,path=components(root,child),stat=lstatSync(path);
      if(stat.isDirectory()){if(!directories.has(child))fail("The owned proof tree contains an unreviewed directory.");stack.push(child);}
      else {const file=files.get(child);if(!stat.isFile()||!file||stat.size!==file.bytes)fail("The owned proof tree contains a missing, changed or unreviewed file.");seen.add(child);}
    }}finally{handle.closeSync();}
  }
  if(seen.size!==files.size)fail("The owned proof tree lost a required role.");
}
async function digest(path:string,file:RenderFile,signal:AbortSignal):Promise<void>{
  const sha=createHash("sha256");let bytes=0;
  for await(const part of Bun.file(path).stream()){signal.throwIfAborted();bytes+=part.byteLength;if(bytes>file.bytes)fail("Proof media exceeds its exact recorded size.");sha.update(part);}
  signal.throwIfAborted();if(bytes!==file.bytes||sha.digest("hex")!==file.sha256)fail("Owned proof media failed its exact recorded checksum.");
}
async function probe(path:string,signal:AbortSignal):Promise<{streams:Record<string,unknown>[]}>{
  signal.throwIfAborted();const child=Bun.spawn(["ffprobe","-v","error","-protocol_whitelist","file,crypto,pipe","-count_frames","-show_streams","-of","json",path],{stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  const abort=()=>child.kill();signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
  const text=async(stream:ReadableStream<Uint8Array>,limit:number)=>{const parts:Uint8Array[]=[];let bytes=0;for await(const part of stream){signal.throwIfAborted();bytes+=part.byteLength;if(bytes>limit)fail("Proof media probe exceeded its diagnostic bound.");parts.push(part);}return Buffer.concat(parts).toString();};
  try{
    const [code,out,err]=await Promise.all([child.exited,text(child.stdout,1024*1024),text(child.stderr,32768)]);signal.throwIfAborted();
    if(code!==0||err.trim())fail("Owned proof media could not be independently decoded.");const result=JSON.parse(out);
    if(!Array.isArray(result?.streams))fail("The proof media probe lost its stream inventory.");return result;
  }catch(error){abort();await child.exited;throw error;}finally{signal.removeEventListener("abort",abort);}
}
async function hls(job:Job,copies:CurrentFilmProofCopy[],root:string,frames:number,width:number,height:number,signal:AbortSignal):Promise<void>{
  const output=job.output!,playlist=copies.find(copy=>copy.original.path===output.hlsPlaylistPath)!;
  const lines=boundedText(owned(root,playlist.owned),1024*1024).split(/\r?\n/).map(line=>line.trim()),segments=lines.filter(line=>line&&!line.startsWith("#"));
  if(lines[0]!=="#EXTM3U"||!lines.includes("#EXT-X-ENDLIST")||!segments.length||segments.length>10000||new Set(segments).size!==segments.length
    ||segments.some(name=>!/^segment-\d{3,5}\.ts$/.test(name))||lines.some(line=>/URI\s*=/i.test(line)||line.startsWith("#EXT-X-KEY")))fail("The proof preview playlist contains unsupported or unowned media references.");
  const prefix=output.hlsPlaylistPath.slice(0,-"index.m3u8".length),indexed=copies.filter(copy=>copy.original.path.startsWith(prefix)&&/^segment-\d{3,5}\.ts$/.test(copy.original.path.slice(prefix.length))).map(copy=>copy.original.path.slice(prefix.length));
  if(hash([...segments].sort())!==hash(indexed.sort()))fail("The actual proof playlist and complete owned segment inventory differ.");
  const actual=await probe(owned(root,playlist.owned),signal),video=actual.streams.filter(stream=>stream.codec_type==="video"),audio=actual.streams.filter(stream=>stream.codec_type==="audio");
  if(actual.streams.length!==2||video.length!==1||audio.length!==1||video[0]!.codec_name!=="h264"||video[0]!.r_frame_rate!=="30/1"
    ||Number(video[0]!.nb_read_frames)!==frames||video[0]!.width!==width||video[0]!.height!==height||audio[0]!.codec_name!=="aac"
    ||Number(audio[0]!.sample_rate)!==44100||audio[0]!.channels!==2)fail("The decoded proof preview delivery differs from its actual film clock.");
}
async function legacyRecords(job:Job,root:string,access:Access,signal:AbortSignal):Promise<void>{
  if(job.currentFilm||!job.output?.shotRenders)return;
  for(const record of job.output.shotRenders){await access();signal.throwIfAborted();
    if(record.files.audio)await verifyRecordedSpeechMedia(record,owned(root,record.files.audio),signal);
    await verifyRecordedClipFrames(owned(root,record.files.video),record.clip.durationSec,signal);
  }
}
function previewRecipe(job:Job):{shots:ReturnType<typeof renderShots>;records:ShotRenderRecord[];overlap:number;frames:number}{
  if(job.currentFilm?.schema==="hv-current-film-job/3"){
    const mixed=currentFilmV3Job(job),assembly=resolveCurrentFilmMixedAssembly(mixed,mixed.currentFilmCheckpoint!);
    return {shots:assembly.slots.map(slot=>slot.target.shot),records:assembly.slots.map(slot=>slot.originalRecord),overlap:assembly.effectiveOverlapFrames/30,frames:mixed.output!.currentFilm.assembly.frames};
  }
  if(job.currentFilm){const current=currentFilmV2Job(job);return {shots:current.currentFilm!.materialization.slots.map(slot=>slot.shot),records:current.currentFilmCheckpoint!.rows.map(row=>row.record),overlap:current.output!.currentFilm!.assembly.effectiveOverlapFrames/30,frames:current.output!.currentFilm!.assembly.frames};}
  const shots=renderShots(job,Date.parse(job.completedAt!)),records=job.output!.shotRenders!;
  if(shots.length!==records.length||records.some((record,index)=>record.shotId!==shots[index]!.id))fail("The historical preview lost its complete ordered shot inventory.");
  return {shots,records,overlap:0,frames:records.reduce((count,record)=>count+Math.round(record.clip.durationSec*30),0)};
}
async function reference(asset:ReferenceAsset,file:RenderFile,root:string,signal:AbortSignal):Promise<void>{
  const path=owned(root,file);await digest(path,file,signal);const bytes=readFileSync(path);
  if(bytes.length>4*1024**2||bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.toString("ascii",12,16)!=="IHDR"
    ||bytes.readUInt32BE(16)!==asset.width||bytes.readUInt32BE(20)!==asset.height)fail("The proof reference changed its canonical PNG dimensions.");
  const actual=await probe(path,signal),stream=actual.streams[0];
  if(actual.streams.length!==1||stream?.codec_name!=="png"||stream.width!==asset.width||stream.height!==asset.height||Number(stream.nb_read_frames)!==1)fail("The canonical proof reference could not be decoded exactly.");
}
/** HV-016-30: a V3 preview kept as proof is verified in its copied namespace,
 * and that nests this verifier (for the preview's own proof) inside the final's
 * proof tree. The empty `.proof-check` parent it left there was an "unreviewed
 * directory" to the final's exact tree check, so a mixed final could never
 * prepare proof of a mixed preview. The parent is now removed once empty; a
 * concurrent verifier that loses the race to it recreates it once. */
function scratchDirectory(root:string,parentKey:string):string {
  for(let attempt=0;;attempt++){
    const path=join(components(root,parentKey,true),crypto.randomUUID());
    try{mkdirSync(path);return path;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT"||attempt)throw error;}
  }
}
function removeEmptyScratchParent(root:string,parentKey:string):void {
  try{rmdirSync(components(root,parentKey));}
  catch(error){if(!["ENOTEMPTY","EEXIST","ENOENT","EBUSY"].includes((error as NodeJS.ErrnoException).code??""))throw error;}
}
function cleanupScratch(scratch:string,identity:Stats,created:{path:string;identity:Stats}[]):void {
  const current=lstatSync(scratch);if(current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino||realpathSync(scratch)!==scratch)fail("The exclusive proof verification scratch changed identity.");
  for(const entry of created){const stat=lstatSync(entry.path);if(stat.isSymbolicLink()||stat.dev!==entry.identity.dev||stat.ino!==entry.identity.ino||realpathSync(entry.path)!==entry.path)fail("Proof verification scratch cannot follow a replaced directory.");
    for(const name of ["picture-probe.json","captions.srt","captions.vtt"]){const path=join(entry.path,name);try{const file=lstatSync(path);if(!file.isFile()||file.isSymbolicLink())fail("Proof verification scratch contains an unexpected metadata role.");unlinkSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
    rmdirSync(entry.path);
  }rmdirSync(scratch);
}

/** Verify already-owned proof in isolated original namespaces. No old source or
 * carrier directory, renderer, record rewrite or current custody grant is used.
 * The caller supplies fresh authority/lease checks; successful byte checks alone
 * must never be treated as permission to publish or checkpoint this specification. */
export async function verifyCurrentFilmProofMedia(raw:CurrentFilmProofCopies,plan:CurrentFilmJobV3,jobId:string,artifactRoot:string,access:Access,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();const {proof,closure}=resolveCurrentFilmProofCopies(raw,plan,jobId);
  if(lstatSync(artifactRoot).isSymbolicLink()||!lstatSync(artifactRoot).isDirectory())fail("Use a real owned proof workspace.");
  const root=realpathSync(artifactRoot),guard=currentFilmWorkspaceGuard(root,proof.projectId,jobId),permission=async()=>{guard.check();await access();};
  await withEditSourceAccess(permission,signal,async active=>{
    guard.check(true);exactTree(root,proof);const parentKey=`${proof.projectId}/${jobId}/.proof-check`,scratch=scratchDirectory(root,parentKey);
    const identity=lstatSync(scratch),created:{path:string;identity:Stats}[]=[];
    const directory=()=>{guard.check(true,{bytes:20*1024**2,files:3});const path=join(scratch,String(created.length));mkdirSync(path);created.push({path,identity:lstatSync(path)});return path;};
    try{
      for(const group of proof.carriers){active.throwIfAborted();await permission();const receipt=closure.receipts.find(value=>value.receipt.revision===group.receiptRevision)!.receipt;
        const namespace=components(root,`${proof.projectId}/${jobId}/proof/originals/${receipt.revision}`),scratch=directory();
        await verifyEditOriginalMedia(receipt.job,receipt.files,namespace,permission,active);await legacyRecords(receipt.job,namespace,permission,active);
        const measured=await measureEditSourceFacts(receipt.job,namespace,scratch,receipt.facts.label,permission,active);
        if(hash(measured)!==hash(receipt.facts))fail("The owned proof source differs from its exact retained picture, caption and speech facts.");
      }
      for(const group of proof.previews){active.throwIfAborted();await permission();const job=closure.previews.find(value=>value.job.id===group.jobId)!.job,
          namespace=components(root,`${proof.projectId}/${jobId}/proof/previews/${job.id}`),scratch=directory(),recipe=previewRecipe(job);
        for(const copy of group.copies){await permission();await digest(owned(root,copy.owned),copy.owned,active);}
        let width:number,height:number;
        if(job.currentFilm?.schema==="hv-current-film-job/3"){
          await verifyCurrentFilmMixedMedia(currentFilmV3Job(job),namespace,permission,active);const clock=job.output!.currentFilm!.assembly;width=clock.probe.video.width;height=clock.probe.video.height;
        }else {
          // HV-031-15: a signed preview's sidecar copy is the one its copied record names. (The
          // mixed verifier above makes the same check for a V3 preview.)
          const output=job.output!,record=JSON.parse(boundedText(components(namespace,output.manifestPath),16*1024**2)) as unknown;
          const sidecar=output.c2paPath===undefined?null:createHash("sha256").update(readFileSync(components(namespace,output.c2paPath))).digest("hex");
          if(!provenanceSidecarAgrees(record,sidecar))fail("The proof preview's C2PA sidecar and its provenance record disagree.");
          // The complete exact digest loop above includes the separately bounded
          // large current-film MP4; do not send it through the generic 8 GiB helper.
          await verifyEditOriginalSemantics(job,group.copies.map(copy=>copy.original),namespace,permission,active);await legacyRecords(job,namespace,permission,active);
          const measured=await measureEditSourceFacts(job,namespace,scratch,"Historical proof preview",permission,active);
          if(measured.frames!==recipe.frames)fail("The proof preview duration differs from its complete actual shot inventory.");width=measured.width;height=measured.height;
        }
        const srt=join(scratch,"captions.srt"),vtt=join(scratch,"captions.vtt");buildCaptions(recipe.shots.map((shot,index)=>({...shot,durationSec:recipe.records[index]!.clip.durationSec})),srt,vtt,recipe.overlap,recipe.records.map(record=>record.clip.speech));
        const expectedSrt=boundedText(srt,8*1024**2),expectedVtt=boundedText(vtt,8*1024**2),output=job.output!;
        if(expectedSrt!==boundedText(components(namespace,output.captionsPath.slice(0,-4)+".srt"),8*1024**2)||expectedVtt!==boundedText(components(namespace,output.captionsPath),8*1024**2))fail("The owned proof preview captions differ from its original measured performances.");
        await permission();await hls(job,group.copies,root,recipe.frames,width,height,active);
      }
      for(const group of proof.references){active.throwIfAborted();await permission();const asset=closure.references.find(value=>value.asset.id===group.assetId)!.asset;await reference(asset,group.copy.owned,root,active);}
      await permission();active.throwIfAborted();guard.check(true);exactTree(root,proof);
    }finally{
      // Only remove this invocation's known metadata files/directories after
      // identity checks. Published proof files and abandoned peers are untouched.
      cleanupScratch(scratch,identity,created);removeEmptyScratchParent(root,parentKey);
    }
  });
}
