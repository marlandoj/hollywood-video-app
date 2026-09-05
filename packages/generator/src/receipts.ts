import type { CostRecord } from "./index";
export interface ProviderRequestReceipt {
  schema: "fal-request/1"; requestId: string; model: string;
  statusUrl: string; responseUrl: string; cancelUrl: string; quotedCost: CostRecord;
}
export function trustedQueueUrl(value: string, base = "https://queue.fal.run"): string {
  const url = new URL(value);
  if (url.origin !== base || url.protocol !== "https:" || url.username || url.password || url.hash || url.search)
    throw new Error("untrusted fal queue URL");
  return url.href;
}
export function validateProviderReceipt(receipt: ProviderRequestReceipt): ProviderRequestReceipt {
  if (receipt.schema !== "fal-request/1" || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.requestId)
    || !/^[A-Za-z0-9_./-]{1,256}$/.test(receipt.model) || receipt.model.split("/").some(part=>!part||part==="."||part===".."))
    throw new Error("invalid provider request receipt");
  const urls = [receipt.statusUrl,receipt.responseUrl,receipt.cancelUrl].map(value=>trustedQueueUrl(value));
  for (const [index,url] of urls.entries()) {
    if (!new URL(url).pathname.endsWith(`/requests/${receipt.requestId}`+["/status","","/cancel"][index]))
      throw new Error("provider request URL does not match its receipt");
  }
  const cost = receipt.quotedCost;
  if (!cost || cost.model !== receipt.model || !["fal","fal-image"].includes(cost.provider)
    || [cost.prompt_tokens,cost.output_frames,cost.gpu_seconds,cost.total_cost_usd].some(value=>!Number.isFinite(value)||value<0||value>1e9))
    throw new Error("invalid provider cost quotation");
  return {schema:"fal-request/1",requestId:receipt.requestId,model:receipt.model,statusUrl:urls[0]!,responseUrl:urls[1]!,cancelUrl:urls[2]!,
    quotedCost:{provider:cost.provider,model:cost.model,prompt_tokens:cost.prompt_tokens,output_frames:cost.output_frames,
      gpu_seconds:cost.gpu_seconds,total_cost_usd:cost.total_cost_usd}};
}
