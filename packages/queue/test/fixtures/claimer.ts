import { DurableJobStore } from "../../src/index";

// Spawned by the interprocess claim test: drains the shared queue and prints
// every job id this process managed to claim, one per line.
const [queuePath, workerId = "claimer"] = process.argv.slice(2);
const store = new DurableJobStore(queuePath!);
const claimed: string[] = [];
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
}
console.log(claimed.join("\n"));
