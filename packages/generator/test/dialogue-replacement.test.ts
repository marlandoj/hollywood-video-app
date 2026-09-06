import {afterAll,beforeAll,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ProjectService} from "../../api/src/index";
import {DurableJobStore,type Job} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {castingSnapshot} from "../../planner/src/casting";
import {directionSnapshot} from "../../planner/src/direction";
import {dialogueSource,createDialogueReplacement,validateDialogueReplacement,validateDialogueReplacementReport} from "../../planner/src/dialogue-replacement";
import {speechRuntimeRevision} from "../src/speech";
import {createProviderPlan} from "../src/catalog";
import {replaceLockedDialogue,inspectDialogueSource} from "../src/dialogue-replacement";

const root=mkdtempSync(join(tmpdir(),"hv-dialogue-replacement-")),artifacts=join(root,"artifacts");
const envKeys=["HV_TOKEN_SECRET","HV_NARRATION","HV_ANIMATIC_CAPTIONS","HV_ANIMATIC_PROVIDER_POOL"],originalEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
let source:Job;
let pinned:Awaited<ReturnType<typeof inspectDialogueSource>>;
const hash=(data:Uint8Array)=>createHash("sha256").update(data).digest("hex");
beforeAll(async()=>{
  Object.assign(process.env,{HV_TOKEN_SECRET:"dialogue-replacement-test-secret-at-least-thirty-two",HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_ANIMATIC_PROVIDER_POOL:'["mock"]'});
  const projects=new ProjectService(join(root,"projects.json")),owner=projects.createAnonymousProject();
  const script="INT. ROOM - DAY\n\nMarla welcomes Kevin.\n\nMARLA\nWelcome to the garden.\n\nKEVIN\nThank you for inviting me.\n\nEXT. PATH - DAY\n\nA quiet path.";
  projects.editScript(owner.token,script);const project=projects.attestRights(owner.token)!;
  const store=new DurableJobStore(join(root,"jobs.json"));
  store.enqueue({id:crypto.randomUUID(),idempotencyKey:"source",projectId:owner.projectId,stage:"animatic",tier:"free",scriptVersion:1,scriptText:script,
    rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:120,timeoutMs:60000,costCapUsd:5,budgetReservedUsd:0,
    retryPolicy:{maxRetries:0,backoffMs:1},providerPlan:createProviderPlan("animatic",5),casting:castingSnapshot(owner.projectId,0,[],0),direction:directionSnapshot(owner.projectId,0,[],0)});
  source=(await processNextJob(store,artifacts,{projects,ledger:new CostLedger(join(root,"ledger.json")),reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))}))!;
  expect(source.failureReason??source.cancelReason).toBeUndefined();expect(source.status).toBe("done");
  pinned=await inspectDialogueSource(source,artifacts);
},30000);
afterAll(()=>{rmSync(root,{recursive:true,force:true});for(const [key,value]of Object.entries(originalEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
function plan(text="Welcome home.",pace=250){
  const shot=source.output!.shotRenders![0]!,line=shot.clip.speech!.lines[0]!;
  return createDialogueReplacement(source,[{shotId:shot.shotId,index:0,sourceHash:line.source.hash,text,voice:{...line.voice,rateWpm:pace},notes:"A shorter greeting."}],pinned.revision,speechRuntimeRevision(),pinned.files);
}
test("locked dialogue remux changes one read and captions while retaining every encoded picture frame and untouched PCM",async()=>{
  const originalVideo=readFileSync(join(artifacts,source.output!.mp4Path)),originalWav=readFileSync(join(artifacts,source.output!.shotRenders![0]!.files.audio!.path));
  let checks=0;const admitted=plan(),result=await replaceLockedDialogue(source,admitted,artifacts,"dialogue-version-1",async()=>{checks++;});
  const report=result.report,wav=readFileSync(result.wavPath),original=source.output!.shotRenders![0]!.clip.speech!;
  expect(validateDialogueReplacementReport(source,report)).toEqual(report);
  const badReport=structuredClone(report);badReport.lines[1]!.startSample++;expect(()=>validateDialogueReplacementReport(source,badReport)).toThrow("timing");
  expect(checks).toBeGreaterThanOrEqual(4);expect(report.plan).toEqual(admitted);expect(report.totalFrames).toBe(dialogueSource(source).totalFrames);expect(wav.length).toBe(44+report.totalSamples*2);
  expect(report.sourceVideoSha256).toBe(hash(originalVideo));expect(report.videoSha256).toBe(hash(readFileSync(result.mp4Path)));expect(report.videoSha256).not.toBe(report.sourceVideoSha256);
  expect(report.lines[0]!.source).toEqual(original.lines[0]!.source);expect(report.lines[0]!.text).toBe("Welcome home.");expect(report.lines[0]!.startSample).toBe(original.lines[0]!.startSample);
  expect(report.lines[0]!.endSample).toBeLessThan(original.lines[0]!.endSample);expect(report.lines[0]!.pcmSha256).not.toBe(original.lines[0]!.pcmSha256);
  const kept=report.lines[1]!;expect(kept.replaced).toBe(false);expect(kept.startSample).toBe(original.lines[1]!.startSample);expect(kept.pcmSha256).toBe(original.lines[1]!.pcmSha256);
  expect(wav.subarray(44+kept.startSample*2,44+kept.endSample*2)).toEqual(originalWav.subarray(44+kept.startSample*2,44+kept.endSample*2));
  for(const line of report.lines)expect(hash(wav.subarray(44+line.startSample*2,44+line.endSample*2))).toBe(line.pcmSha256);
  expect(wav.subarray(44+report.lines[0]!.endSample*2,44+kept.startSample*2).every(byte=>byte===0)).toBe(true);
  const captions=readFileSync(result.captionsPath,"utf8");expect(captions).toContain("MARLA: Welcome home.");expect(captions).toContain("KEVIN: Thank you for inviting me.");expect(captions).not.toContain("Welcome to the garden.");
  expect(readFileSync(join(artifacts,source.output!.mp4Path))).toEqual(originalVideo);expect(readFileSync(result.hlsPlaylistPath,"utf8")).toContain("#EXT-X-ENDLIST");
  expect(readdirSync(result.directory).sort()).toEqual(["captions.srt","captions.vtt","dialogue.wav","export.mp4","hls","provenance.json"]);
  await expect(replaceLockedDialogue(source,admitted,artifacts,"dialogue-version-1",async()=>{})).rejects.toThrow("already exists");
},30000);
test("overflow, cancellation and permission revocation leave the source intact and publish no replacement",async()=>{
  await expect(replaceLockedDialogue(source,plan("We have a great deal to discuss before we can begin the long walk through the garden.",80),artifacts,"overflow",async()=>{})).rejects.toThrow("is available in the locked picture");
  expect(existsSync(join(artifacts,source.projectId,"overflow"))).toBe(false);
  const abort=new AbortController();let count=0;
  await expect(replaceLockedDialogue(source,plan(),artifacts,"cancelled",async()=>{if(++count===3)abort.abort(new Error("user cancelled"));},abort.signal)).rejects.toThrow("user cancelled");
  count=0;await expect(replaceLockedDialogue(source,plan(),artifacts,"revoked",async()=>{if(++count===3)throw new Error("cast permission revoked");})).rejects.toThrow("permission revoked");
  expect(["cancelled","revoked"].some(id=>existsSync(join(artifacts,source.projectId,id)))).toBe(false);
  expect(readdirSync(join(artifacts,source.projectId)).some(name=>name.startsWith(".hv-dialogue-"))).toBe(false);
},30000);
test("cancelling active synthesis and revoking access at publication discard the unfinished branch",async()=>{
  const abort=new AbortController();let checks=0,timer:ReturnType<typeof setTimeout>|undefined;
  try{await expect(replaceLockedDialogue(source,plan("The garden is quiet. ".repeat(500),80),artifacts,"active-cancel",async()=>{
    if(++checks===3)timer=setTimeout(()=>abort.abort(new Error("cancel active read")),10);
  },abort.signal)).rejects.toThrow("cancel active read");}finally{if(timer)clearTimeout(timer);}
  checks=0;const publicationCheck=2+source.output!.shotRenders!.length+1;
  await expect(replaceLockedDialogue(source,plan(),artifacts,"late-revoke",async()=>{if(++checks===publicationCheck)throw new Error("permission revoked at publication");})).rejects.toThrow("at publication");
  expect(checks).toBe(publicationCheck);expect(existsSync(join(artifacts,source.projectId,"late-revoke"))).toBe(false);expect(existsSync(join(artifacts,source.projectId,"active-cancel"))).toBe(false);
},30000);
test("source revision, line identity, engine revision and edit fields are strictly bound",async()=>{
  const admitted=plan();expect(validateDialogueReplacement(source,admitted)).toEqual(admitted);
  const changed=structuredClone(admitted);changed.edits[0]!.text="Another reading.";expect(()=>validateDialogueReplacement(source,changed)).toThrow("plan changed");
  expect(()=>createDialogueReplacement(source,admitted.edits,"0".repeat(64),admitted.engineVersion,pinned.files)).toThrow("source cut changed");
  expect(()=>createDialogueReplacement(source,[admitted.edits[0],admitted.edits[0]],admitted.sourceRevision,admitted.engineVersion,pinned.files)).toThrow("only once");
  expect(()=>createDialogueReplacement(source,[{...admitted.edits[0],sourceHash:"f".repeat(64)}],admitted.sourceRevision,admitted.engineVersion,pinned.files)).toThrow("line changed");
  expect(()=>createDialogueReplacement(source,[{...admitted.edits[0],command:"anything"}],admitted.sourceRevision,admitted.engineVersion,pinned.files)).toThrow("supported");
  expect(()=>createDialogueReplacement(source,[{...admitted.edits[0],voice:{voice:"../../unowned"}}],admitted.sourceRevision,admitted.engineVersion,pinned.files)).toThrow("built-in");
  const stale=createDialogueReplacement(source,admitted.edits,admitted.sourceRevision,"espeak-"+"f".repeat(64),pinned.files);await expect(replaceLockedDialogue(source,stale,artifacts,"stale",async()=>{})).rejects.toThrow("runtime changed");
  await expect(replaceLockedDialogue(source,admitted,artifacts,"../foreign",async()=>{})).rejects.toThrow("new job");
  expect(()=>dialogueSource({...source,projectId:crypto.randomUUID()})).toThrow();expect(()=>dialogueSource({...source,linkExpiresAt:new Date(0).toISOString()})).toThrow("unexpired");
});
test("same-size media tampering and burned-in source captions are refused before publishing",async()=>{
  const audioPath=join(artifacts,source.output!.shotRenders![0]!.files.audio!.path),originalAudio=readFileSync(audioPath),bad=Buffer.from(originalAudio);bad[100]^=1;writeFileSync(audioPath,bad);
  try{await expect(replaceLockedDialogue(source,plan(),artifacts,"tampered-audio",async()=>{})).rejects.toThrow("checksum");}finally{writeFileSync(audioPath,originalAudio);}
  const videoPath=join(artifacts,source.output!.mp4Path),originalVideo=readFileSync(videoPath),badVideo=Buffer.from(originalVideo);badVideo[100]^=1;writeFileSync(videoPath,badVideo);
  try{await expect(replaceLockedDialogue(source,plan(),artifacts,"tampered-picture",async()=>{})).rejects.toThrow("checksum");}finally{writeFileSync(videoPath,originalVideo);}
  const burned=structuredClone(source);burned.providerPlan!.pool[0]!.snapshot.postProcessing.push("burn-in-captions");expect(()=>dialogueSource(burned)).toThrow("burned-in captions");
},30000);
