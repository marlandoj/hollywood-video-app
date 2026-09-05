import { expect, test } from "bun:test";
import { FailoverGenerator, type GenParams, type ProviderAdapter } from "../src/index";
import { validateProviderReceipt, type ProviderRequestReceipt } from "../src/receipts";
const request = "https://queue.fal.run/fal-ai/flux/schnell/requests/request-1";
const receipt: ProviderRequestReceipt = {schema:"fal-request/1",requestId:"request-1",model:"fal-ai/flux/schnell",
  statusUrl:request+"/status",responseUrl:request,cancelUrl:request+"/cancel",quotedCost:{provider:"fal-image",model:"fal-ai/flux/schnell",
    prompt_tokens:4,output_frames:1,gpu_seconds:0,total_cost_usd:0.003}};
test("provider receipts bind a request and bounded cost quotation to trusted queue URLs",()=>{
  expect(validateProviderReceipt(receipt)).toEqual(receipt);
  for (const statusUrl of ["https://evil.example/requests/request-1/status",receipt.statusUrl+"?secret=1",receipt.statusUrl.replace("request-1","another")])
    expect(()=>validateProviderReceipt({...receipt,statusUrl})).toThrow();
  expect(()=>validateProviderReceipt({...receipt,quotedCost:{...receipt.quotedCost,total_cost_usd:Infinity}})).toThrow();
  expect(()=>validateProviderReceipt({...receipt,model:"../escape"})).toThrow();
});
test("late provider acknowledgements retain their original attempt after failover",async()=>{
  let late: GenParams["onProviderRequest"], counter=0;
  const recorded: number[] = [];
  const primary: ProviderAdapter = {name:"primary",model:"fixture",async generate(_prompt,_seed,params){late=params.onProviderRequest;throw new Error("fixture failure");}};
  const secondary: ProviderAdapter = {name:"secondary",model:"fixture",async generate(_prompt,seed,params,path){
    await late?.(receipt); await params.onProviderRequest?.(receipt);
    return {path,provider:"secondary",model:"fixture",seed,durationSec:1,fingerprint:"0".repeat(64),cost:{provider:"fixture",model:"fixture",prompt_tokens:0,output_frames:30,gpu_seconds:0,total_cost_usd:0}};
  }};
  const result = await new FailoverGenerator(primary,secondary).generate("A quiet garden",1,{seed:1,beforeAttempt:()=>{
    const current=++counter;return {onProviderRequest:()=>{recorded.push(current);}};
  }},"unused-fixture.mp4");
  expect(result.failedOver).toBe(true);expect(recorded).toEqual([1,2]);
});
