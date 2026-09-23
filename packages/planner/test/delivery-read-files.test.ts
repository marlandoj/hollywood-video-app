/**
 * HV-027-08 — a reframe copied the film's whole lossless conform to read its master.
 *
 * `deliveryBindingFor` names every file of the sealed conform — the master, `index.ffconcat`,
 * `final.wav` and every `part-NNNNN.mkv` — for all three kinds, because nothing enumerates another
 * job's artifacts under `s3` and the binding is made before a kind is chosen. That is right for a
 * *binding*: it is what the job is bound to. It was also what `renderDeliveryJob` copied:
 *
 *     const wanted=binding.files.reduce((total,file)=>total+file.bytes,0);
 *     assertEditFreeSpace(root,wanted*2);
 *     await withEditSourceAccess(access,signal,active=>
 *       copyDialogueFiles({…},binding.files,root,sources,active,reader));
 *
 * Only the mezzanine branch touches the conform directory. The reframe branch opens `master` and
 * nothing else — so a creator asking for a 1:1 crop of a finished film pulled the whole lossless
 * picture master through the artifact reader, re-digested it, and reserved twice its size before
 * starting. On a host without that headroom the crop was refused outright, with the editorial
 * worker's message — *"The editorial worker needs more free workspace… use a smaller assembly"* —
 * for bytes the job never opens.
 *
 * Nothing caught it because the end-to-end delivery test renders a 640×360 three-second fixture,
 * where the whole conform is a few megabytes, and `delivery-reframe.test.ts` calls the renderer
 * directly and never goes through `renderDeliveryJob`.
 */
import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {contentHash} from "../../generator/src/capabilities";
import {DELIVERY_KINDS,deliveryBinding,deliveryJobPlan,deliveryReadFiles,type DeliveryBinding,type DeliveryFile} from "../src/delivery-jobs";

const PROJECT="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",JOB="bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ROOT=PROJECT+"/"+JOB+"/export/conform",MASTER=ROOT+"/export.mp4",PARTS=15,PART_BYTES=60_000_000,MASTER_BYTES=4_000_000;
const digest=(seed:string)=>seed.repeat(64).slice(0,64);
const at=(path:string,bytes:number):DeliveryFile=>({path,sha256:contentHash(path),bytes});
/** The fixture the rest of this epic's tests use: an HD film of 900 frames. */
const made=():DeliveryBinding=>deliveryBinding({storage:"s3",
  source:{projectId:PROJECT,jobId:JOB,stage:"picture-edit",outputRevision:digest("d")},
  master:at(MASTER,MASTER_BYTES),
  files:[at(MASTER,MASTER_BYTES),at(ROOT+"/picture/index.ffconcat",512),at(ROOT+"/audio/final.wav",44+900*1600*6),
    ...Array.from({length:PARTS},(_,index)=>at(ROOT+"/picture/part-"+String(index).padStart(5,"0")+".mkv",PART_BYTES))],
  conform:{width:1920,height:1080,frames:900,pictureFramesSha256:digest("c"),pictureBytes:PARTS*PART_BYTES,mixBytes:44+900*1600*6}});
const bytes=(files:DeliveryFile[])=>files.reduce((total,file)=>total+file.bytes,0);

test("a mezzanine reads the whole conform and a reframe reads the master alone",()=>{
  const binding=made();
  const mezzanine=deliveryJobPlan(binding,"mezzanine"),square=deliveryJobPlan(binding,"reframe-1:1");
  expect(deliveryReadFiles(mezzanine).map(file=>file.path)).toEqual(binding.files.map(file=>file.path));
  expect(deliveryReadFiles(square).map(file=>file.path)).toEqual([MASTER]);
  // The master is in both, because it is what the binding is bound to.
  for (const kind of DELIVERY_KINDS) expect(deliveryReadFiles(deliveryJobPlan(binding,kind)).some(file=>file.path===binding.master.path)).toBe(true);
  // And the binding itself is untouched: what a job is bound to is not what it opens.
  expect(binding.files).toHaveLength(PARTS+3);
});

test("and the difference is the whole picture master, measured on this epic's own fixture",()=>{
  const binding=made();
  const all=bytes(deliveryReadFiles(deliveryJobPlan(binding,"mezzanine")));
  const one=bytes(deliveryReadFiles(deliveryJobPlan(binding,"reframe-9:16")));
  // 15 parts of 60 MB, a mix, an index and a 4 MB master: a crop used to copy 228 times what it reads.
  expect({all,one,times:Math.round(all/one)}).toEqual({all:PARTS*PART_BYTES+MASTER_BYTES+512+44+900*1600*6,one:MASTER_BYTES,times:228});
  // The reservation follows the copy, because it is the copy it is reserving for.
  expect(one*2).toBeLessThan(all);
});

test("and the renderer copies what it reads rather than what it is bound to",()=>{
  // The guard on the call site, because the selection is only a fix if the renderer uses it -- and
  // it has to reserve from the same list, or the refusal comes back for bytes nobody opens.
  const source=readFileSync(new URL("../../generator/src/delivery-media.ts",import.meta.url),"utf8");
  const render=source.slice(source.indexOf("export async function renderDeliveryJob("),source.indexOf("export async function sealDeliveryJob("));
  expect(render).toContain("const needed=deliveryReadFiles(plan)");
  expect(render).toContain("const wanted=needed.reduce(");
  expect(render).not.toContain("binding.files");
  // The mezzanine still reads the conform directory out of what it copied, which is why its list is
  // the whole inventory.
  expect(render).toContain("deliveryConformDirectory(binding.master.path)");
});
