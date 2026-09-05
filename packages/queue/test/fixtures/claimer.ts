import { existsSync, writeFileSync } from "node:fs";
import { DurableJobStore } from "../../src/index";

// Spawned by the interprocess claim test: drains the shared queue and prints
// every job id this process managed to claim, one per line.
const [queuePath, workerId = "claimer"] = process.argv.slice(2);
const store = new DurableJobStore(queuePath!);
const claimed: string[] = [];
const participants = ["a","b","c","d"];
if (!participants.includes(workerId)) throw new Error("unknown claim fixture participant");
async function barrier(phase: string): Promise<void> {
  writeFileSync(`${queuePath}.${workerId}.${phase}`,"ready");
  const deadline = Date.now()+10_000;
  while (!participants.every(name=>existsSync(`${queuePath}.${name}.${phase}`))) {
    if (Date.now()>deadline) throw new Error("claim fixture participants did not reach "+phase);
    await Bun.sleep(2);
  }
}
await barrier("ready");
for (;;) {
  const job = store.claimNext(Date.now(), {}, { workerId, leaseMs: 60_000 });
  if (!job) break;
  claimed.push(job.id);
  store.complete(job.id, workerId, {
    mp4Path: `${job.projectId}/${job.id}/export.mp4`,
    hlsPlaylistPath: `${job.projectId}/${job.id}/hls/index.m3u8`,
    captionsPath: `${job.projectId}/${job.id}/captions.vtt`,
    manifestPath: `${job.projectId}/${job.id}/provenance.json`,
  });
  if (claimed.length===1) await barrier("first-claim");
}
console.log(claimed.join("\n"));
