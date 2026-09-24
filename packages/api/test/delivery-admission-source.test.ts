/**
 * HV-027-09 — the admission check that the film is still the film compared the plan with itself.
 *
 * `POST /projects/:id/deliveries/:job` reads the project's jobs once, at the top of the handler:
 *
 *     const mine=await projectJobs(this.context.store,project.id);
 *     const source=mine.find(job=>job.id===editId(parts[0]));
 *     …
 *     binding=deliveryBindingForJob(source,this.context.storage);
 *
 * and then, after planning, pricing and the capacity decision, asks
 *
 *     assertDeliverySourceAvailable(binding,source);
 *
 * Every value `assertDeliverySourceAvailable` compares — the job id, project, stage, status, the
 * sealed revision and the master's path, digest and length — was read out of that same `source`
 * object by `deliveryBindingFor` a few lines earlier. The call could not fail. Its docstring's
 * purpose, "a film rendered again since the deliverable was planned is refused by name, not
 * delivered from the old bytes", was not served at the route: the PostgreSQL ledger re-reads the
 * source in its own transaction, and the local store had nothing at all until the worker opened the
 * files and failed.
 *
 * These tests do not drive the route, which needs a rendered picture edit to reach this line; they
 * show the difference between the two readings, and guard that the route now takes the second.
 */
import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {contentHash} from "../../generator/src/capabilities";
import {assertDeliverySourceAvailable,deliveryBinding,type DeliveryFile} from "../../planner/src/delivery-jobs";
import type {Job} from "../../queue/src/index";

const projectId=crypto.randomUUID(),jobId=crypto.randomUUID();
const ROOT=projectId+"/"+jobId+"/export/conform",MASTER=ROOT+"/export.mp4";
const at=(path:string,bytes:number):DeliveryFile=>({path,sha256:contentHash(path),bytes});
const files=[at(MASTER,4_000_000),at(ROOT+"/picture/index.ffconcat",512),at(ROOT+"/audio/final.wav",44+900*1600*6),at(ROOT+"/picture/part-00000.mkv",60_000_000)];
const binding=deliveryBinding({storage:"local",source:{projectId,jobId,stage:"picture-edit",outputRevision:"d".repeat(64)},
  master:at(MASTER,4_000_000),files,
  conform:{width:1920,height:1080,frames:900,pictureFramesSha256:"c".repeat(64),pictureBytes:60_000_000,mixBytes:44+900*1600*6}});
/** The film as the handler read it at the top, and as it is by the time the job is admitted. */
const snapshot={id:jobId,projectId,stage:"picture-edit",status:"done",output:{editorial:{revision:binding.source.outputRevision,files}}} as unknown as Job;
const rerendered={...snapshot,output:{editorial:{revision:"e".repeat(64),files}}} as unknown as Job;

test("the snapshot the binding was made from always agrees with it, which is why it proves nothing",()=>{
  expect(()=>assertDeliverySourceAvailable(binding,snapshot)).not.toThrow();
});

test("and the film read again is what can tell a re-render apart",()=>{
  expect(()=>assertDeliverySourceAvailable(binding,rerendered)).toThrow("rendered again since the deliverable was planned");
  // And a film that has gone -- removed, or not visible to this store any more -- is refused by name.
  expect(()=>assertDeliverySourceAvailable(binding,undefined)).toThrow("no longer available");
});

test("and the route asks the store, not the snapshot, on both backends",()=>{
  const source=readFileSync(new URL("../src/delivery-api.ts",import.meta.url),"utf8");
  const code=source.replaceAll(/^\s*\/\/.*$/gm,"");
  // Never the object the binding came from.
  expect(code).not.toContain("assertDeliverySourceAvailable(binding,source)");
  // Once at admission, and once more at the last moment on the local store, which has no transaction
  // to hold the source still between the two.
  expect(code.split("assertDeliverySourceAvailable(binding,await queue.get(source.id)??undefined)").length-1).toBe(2);
  const local=code.slice(code.indexOf("else{",code.indexOf("ledger instanceof PostgresCostLedger")));
  expect(local.indexOf("assertDeliverySourceAvailable(")).toBeLessThan(local.indexOf("queue.enqueue("));
});
