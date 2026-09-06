export interface ReferenceAsset {
  schema: "hv-reference/1"; id: string; projectId: string; sha256: string; originalSha256: string;
  bytes: number; width: number; height: number; contentType: "image/png"; createdAt: string; attestedAt: string;
  source?: {kind:"character-sheet";jobId:string;viewId:string;castingRevision:string};
}
export const MAX_REFERENCE_BYTES = 4 * 1024 ** 2;
export const MAX_REFERENCE_ASSETS = 96;
export function validateReference(value: ReferenceAsset, projectId: string): ReferenceAsset {
  if (!value || Object.keys(value).filter(key=>key!=="source").sort().join(",") !== "attestedAt,bytes,contentType,createdAt,height,id,originalSha256,projectId,schema,sha256,width"
    || value.schema !== "hv-reference/1" || value.projectId !== projectId || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id)
    || ![value.sha256,value.originalSha256].every(hash => /^[a-f0-9]{64}$/.test(hash))
    || value.contentType !== "image/png" || !Number.isSafeInteger(value.bytes) || value.bytes < 24 || value.bytes > MAX_REFERENCE_BYTES
    || ![value.width,value.height].every(number => Number.isInteger(number) && number >= 1 && number <= 1024)
    || ![value.createdAt,value.attestedAt].every(date => typeof date === "string" && Number.isFinite(Date.parse(date))))
    throw new Error("Invalid character reference metadata.");
  if(value.source!==undefined && (!value.source || Object.keys(value.source).sort().join(",")!=="castingRevision,jobId,kind,viewId" || value.source.kind!=="character-sheet"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.source.jobId) || !/^sheet-[1-9][0-9]?$/.test(value.source.viewId) || !/^[a-f0-9]{64}$/.test(value.source.castingRevision)))throw new Error("Invalid reference source.");
  return structuredClone(value);
}
export function referenceObjectKey(asset: ReferenceAsset): string {
  validateReference(asset, asset.projectId);
  return "v1/" + asset.projectId + "/reference-" + asset.id + "/" + asset.sha256 + "/reference.png";
}
export function referenceLocalKey(asset: ReferenceAsset): string {
  validateReference(asset, asset.projectId);
  return asset.projectId + "/references/" + asset.id + "/" + asset.sha256 + ".png";
}
