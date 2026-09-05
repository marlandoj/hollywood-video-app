import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runWorker } from "../../packages/queue/src/worker";
const root=process.env.HV_FLEET_BARRIER_ROOT,slot=process.env.HV_FLEET_SLOT;
if (!root || !/^[0-9]+$/.test(slot ?? "")) throw new Error("fleet fixture configuration missing");
const signal=new AbortController(),drain=()=>signal.abort();
process.on("SIGTERM",drain);process.on("SIGINT",drain);
try {
  await runWorker({signal:signal.signal,onJobStarted:async job=>{
    const marker=resolve(root,"claim-"+slot+".json");
    if (!existsSync(marker)) writeFileSync(marker,JSON.stringify({jobId:job.id,projectId:job.projectId}),{mode:0o600});
    const deadline=Date.now()+30_000;
    while (!existsSync(resolve(root,"release"))) {
      if (Date.now()>deadline) throw new Error("fleet fixture barrier timed out");
      await Bun.sleep(25);
    }
  }});
} finally {
  EventEmitter.prototype.removeListener.call(process,"SIGTERM",drain);
  EventEmitter.prototype.removeListener.call(process,"SIGINT",drain);
}
