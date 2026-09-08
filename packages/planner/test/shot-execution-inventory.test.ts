import {expect,test} from "bun:test";
import {contentHash as hash} from "../../generator/src/capabilities";
import {renderRecord,type ShotRenderRecord} from "../src/shot-reuse";
import {validateShotExecutionInventory,advanceShotExecutionInventory,type ShotExecutionInventoryRow} from "../src/shot-execution-inventory";

/** Sealed metadata fixtures test inventory invariants only; they do not claim real media or dispatch. */
function record(index:number,reused=false,jobId="film"):ShotRenderRecord {
  const shotId="shot-1-"+index;return renderRecord({projectId:"execution-inventory",jobId,shotId,inputHash:"a".repeat(64),clip:{provider:"mock",model:"mock-deterministic-v1",seed:7000+index,durationSec:2,fingerprint:"b".repeat(64)},files:{video:{path:`execution-inventory/${jobId}/clips/${shotId}.mp4`,sha256:"c".repeat(64),bytes:10}},origin:{jobId:reused?"original":jobId,shotId},...(reused?{reusedFrom:{jobId:"original",shotId,revision:"d".repeat(64)}}:{})});
}
const row=(record:ShotRenderRecord):ShotExecutionInventoryRow=>({shotId:record.shotId,recordRevision:record.revision,capture:null,unavailableReason:record.reusedFrom?"reused-source":"legacy-checkpoint"});

test("legacy absence can migrate only the already durable prefix; new copied rows remain explicitly unavailable",()=>{
  const records=[record(1),record(2,true)],rows=records.map(row),before=hash({records,rows});
  expect(advanceShotExecutionInventory(undefined,rows,records,1)).toEqual(rows);
  expect(advanceShotExecutionInventory([rows[0]!],rows,records,1)).toEqual(rows);
  expect(validateShotExecutionInventory(JSON.parse(JSON.stringify(rows)),records)).toEqual(rows);
  expect(hash({records,rows})).toBe(before);
  expect(()=>advanceShotExecutionInventory(undefined,rows,records,0)).toThrow(/newly generated/);
  expect(()=>advanceShotExecutionInventory(undefined,[row(record(1)),row(record(2))],[record(1),record(2)],1)).toThrow(/newly generated/);
});

test("record order, job identity, complete count and copied-versus-original absence cannot be forged",()=>{
  const records=[record(1),record(2,true)],rows=records.map(row);
  expect(()=>validateShotExecutionInventory(rows.slice().reverse(),records)).toThrow(/ordered immutable/);
  expect(()=>validateShotExecutionInventory(rows.slice(0,1),records)).toThrow(/one execution/);
  expect(()=>validateShotExecutionInventory([rows[0]!,rows[0]!],[records[0]!,records[0]!])).toThrow(/unique ordered/);
  const reason=structuredClone(rows);reason[1]!.unavailableReason="legacy-checkpoint";expect(()=>validateShotExecutionInventory(reason,records)).toThrow(/explicit reason/);
  const foreign=[records[0]!,record(2,true,"other")];expect(()=>validateShotExecutionInventory(foreign.map(row),foreign)).toThrow(/Invalid saved shot render/);
  const replaced=structuredClone(rows);replaced[0]!.recordRevision="e".repeat(64);expect(()=>validateShotExecutionInventory(replaced,records)).toThrow(/immutable shot record/);
});

test("checkpoint evidence cannot be truncated, resealed against changed records or silently replaced",()=>{
  const records=[record(1),record(2,true)],rows=records.map(row);
  expect(()=>advanceShotExecutionInventory(rows,rows.slice(0,1),records.slice(0,1),2)).toThrow(/truncate/);
  expect(()=>advanceShotExecutionInventory([],rows,records,1)).toThrow(/complete checkpoint prefix/);
  const changed=structuredClone(records),{schema:_schema,revision:_revision,...data}=changed[0]!;changed[0]=renderRecord({...data,clip:{...data.clip,seed:99}});
  expect(()=>advanceShotExecutionInventory(rows,changed.map(row),changed,2)).toThrow(/immutable shot record/);
  expect(()=>advanceShotExecutionInventory(undefined,rows,records,NaN)).toThrow(/portable/);
});

test("metadata shape is checked before access, with dense arrays and independently returned values",()=>{
  const records=[record(1)],rows=records.map(row);let reads=0;const hostile={...rows[0]!,get capture(){reads++;return null;}};
  expect(()=>validateShotExecutionInventory([hostile],records)).toThrow(/accessors/);expect(reads).toBe(0);
  const sparse=structuredClone(rows);delete sparse[0];expect(()=>validateShotExecutionInventory(sparse,records)).toThrow(/dense/);
  const result=validateShotExecutionInventory(rows,records);result[0]!.shotId="changed";expect(rows[0]!.shotId).toBe("shot-1-1");
  const extra=structuredClone(rows);Object.assign(extra[0]!,{approved:true});expect(()=>validateShotExecutionInventory(extra,records)).toThrow(/immutable shot record/);
});
