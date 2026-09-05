import { EventEmitter } from "node:events";
import { parseArgs } from "node:util";
import { runBackupCycle } from "../packages/storage/src/backup-service";
const {values}=parseArgs({args:process.argv.slice(2),options:{help:{type:"boolean"},repository:{type:"string"},once:{type:"boolean"},"interval-seconds":{type:"string"}},strict:true});
if (values.help) {
  console.log("Scheduled local storage backups: --repository DIRECTORY [--interval-seconds 120] [--once]\nUses the private HV_PG_ADMIN_URL/HV_S3_* environment. Intervals must be 30–3600 seconds. Reports snapshot age through service-status.json; this does not establish off-host recovery.");process.exit(0);
}
const interval=Number(values["interval-seconds"] ?? "120")*1000,url=process.env.HV_PG_ADMIN_URL;
if (!values.repository || !url || !Number.isInteger(interval) || interval<30_000 || interval>3600_000) throw new Error("invalid backup service configuration; use --help");
let stopping=false;const stop=()=>{stopping=true;};process.on("SIGTERM",stop);process.on("SIGINT",stop);
try {
  while (!stopping) {
    const started=Date.now(),status=await runBackupCycle(url,values.repository);
    console.log(JSON.stringify({event:"backup.cycle",...status}));
    if (values.once) {process.exitCode=status.state==="healthy"?0:1;break;}
    const next=Math.max(Date.now()+1000,started+interval);
    while (!stopping && Date.now()<next) await Bun.sleep(Math.min(1000,next-Date.now()));
  }
} finally {
  EventEmitter.prototype.removeListener.call(process,"SIGTERM",stop);EventEmitter.prototype.removeListener.call(process,"SIGINT",stop);
}
