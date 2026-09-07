import {readFileSync,statSync} from "node:fs";
import {resolve} from "node:path";
import {validateLipSyncInvoice,PostgresLipSyncLedger} from "../packages/storage/src/lipsync-ledger";
import {StudioDatabase} from "../packages/storage/src/database";
const [file,mode]=process.argv.slice(2);
if(!file||mode!==undefined&&!["--check","--apply"].includes(mode))throw new Error("Usage: bun scripts/reconcile-lipsync.ts <invoice-allocation.json> [--check|--apply]");
const path=resolve(file);if(!statSync(path).isFile()||statSync(path).size>1024*1024)throw new Error("Use an allocation worksheet no larger than 1 MiB.");
const invoice=validateLipSyncInvoice(JSON.parse(readFileSync(path,"utf8")));
if(mode==="--apply"){
  const url=process.env.HV_PG_ADMIN_URL;if(!url)throw new Error("The operator database connection is required.");
  const database=new StudioDatabase(url);try{await new PostgresLipSyncLedger(database).settleLipSyncInvoice(invoice);}finally{await database.close();}
}
console.log(JSON.stringify({mode:mode==="--apply"?"applied":"validated-only",documentSha256:invoice.documentSha256,revision:invoice.revision,attempts:invoice.allocations.length,totalUsd:invoice.totalUsd,basis:"operator-invoice-allocation"}));
