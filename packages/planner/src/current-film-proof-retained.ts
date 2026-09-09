import {contentHash as hash} from "../../generator/src/capabilities";
import {validateEditSourceReceipt,type EditSourceReceipt} from "./edit-sources";
import {currentFilmV3Job} from "./current-film-runtime-context";
import {validateCurrentFilmPreparedProof} from "./current-film-prepared-proof";
import {resolveCurrentFilmProofCopies,validateCurrentFilmProofPreviewFiles,type CurrentFilmProofCarrierSelection} from "./current-film-proof-copies";
import type {CurrentFilmProofClosure} from "./current-film-proof-closure";
import type {RenderFile} from "./shot-reuse";

function fail(message:string):never {throw new Error(message);}
const same=(left:unknown,right:unknown)=>hash(left)===hash(right);
type Route={receiptRevision:string;copies:{original:RenderFile;source:RenderFile}[]};

/** Historical metadata only. Every returned scope is the complete specification
 * of this exact validated completed /4 owner, never a fabricated outer job row.
 * The original receipt/file/proof identities are retained without rewriting. */
export function resolveCurrentFilmRetainedProofSource(raw:EditSourceReceipt) {
  const receipt=validateEditSourceReceipt(raw);
  if(receipt.schema!=="hv-edit-source/4")fail("Retain an exact mixed editorial source for nested proof resolution.");
  const job=currentFilmV3Job(receipt.job);
  if(!job.currentFilmProof)fail("The mixed source lost its completed prepared proof.");
  const marker=validateCurrentFilmPreparedProof(job.currentFilmProof,job),resolved=resolveCurrentFilmProofCopies(marker.specification,job.currentFilm,job.id);
  const indexed=new Map(receipt.files.map(file=>[file.path,file]));
  const route=(copies:{original:RenderFile;owned:RenderFile}[]):Route=>({receiptRevision:receipt.revision,copies:copies.map(copy=>{
    if(!same(indexed.get(copy.owned.path),copy.owned)||copy.original.bytes!==copy.owned.bytes||copy.original.sha256!==copy.owned.sha256)
      fail("The complete mixed receipt lost an exact nested proof-owned file.");
    return {original:copy.original,source:copy.owned};
  })});
  const receipts=resolved.proof.carriers.map(group=>{
    const nested=resolved.closure.receipts.find(row=>row.receipt.revision===group.receiptRevision)?.receipt;
    if(!nested||!same(group.copies.map(copy=>copy.original),nested.files))fail("Nested proof changed the complete original receipt inventory.");
    return {receipt:nested,route:route(group.copies)};
  });
  const previews=resolved.proof.previews.map(group=>{
    const preview=resolved.closure.previews.find(row=>row.job.id===group.jobId);
    if(!preview||preview.revision!==group.jobRevision)fail("Nested proof changed the complete historical preview job.");
    validateCurrentFilmProofPreviewFiles(preview.job,group.copies.map(copy=>copy.original));
    return {...preview,route:route(group.copies)};
  });
  const references=resolved.proof.references.map(group=>{
    const reference=resolved.closure.references.find(row=>row.asset.id===group.assetId);
    if(!reference||!same(reference.file,group.copy.original))fail("Nested proof changed the historical reference file.");
    return {...reference,route:route([group.copy])};
  });
  return {receipt,job,marker,proof:resolved.proof,closure:resolved.closure,receipts,previews,references};
}

/** Internal derivation for fresh closure/copy compilation. Caller still performs
 * full closure recompilation, carrier selection, current permission and held
 * index/byte checks. These helpers grant no artifact or project authority. */
function mapRoute(closure:CurrentFilmProofClosure,selected:CurrentFilmProofCarrierSelection[],route:Route) {
  const original=closure.receipts.find(row=>row.receipt.revision===route.receiptRevision),choice=selected.find(row=>row.receiptRevision===route.receiptRevision);
  const candidate=original&&choice&&original.candidates.find(row=>row.kind===choice.kind&&row.jobId===choice.jobId
    &&row.jobRevision===choice.jobRevision&&row.evidenceRevision===choice.evidenceRevision);
  if(!original||!candidate)fail("Select the complete exact mixed-source carrier before deriving nested proof paths.");
  const files=route.copies.map(copy=>{
    const index=original.receipt.files.findIndex(file=>file.path===copy.source.path),source=original.receipt.files[index],carrier=candidate.files[index];
    if(index<0||!same(source,copy.source)||!carrier||carrier.bytes!==copy.original.bytes||carrier.sha256!==copy.original.sha256)
      fail("The retained proof route changed its original, source-owned or carrier file.");
    return {original:copy.original,carrier};
  });
  return {jobId:candidate.jobId,files};
}
function sources(closure:CurrentFilmProofClosure) {
  return closure.receipts.filter(row=>row.receipt.schema==="hv-edit-source/4").sort((a,b)=>a.receipt.revision.localeCompare(b.receipt.revision))
    .map(row=>resolveCurrentFilmRetainedProofSource(row.receipt));
}
export function resolveCurrentFilmProofPreviewCarrier(closure:CurrentFilmProofClosure,selected:CurrentFilmProofCarrierSelection[],jobId:string) {
  const expected=closure.previews.find(row=>row.job.id===jobId);
  if(!expected)fail("Resolve only a required historical preview.");
  const choices=sources(closure).flatMap(source=>source.previews.filter(row=>row.job.id===jobId));
  for(const row of choices)if(row.revision!==expected.revision||!same(row.job,expected.job))fail("Conflicting complete same-ID retained preview bodies.");
  const chosen=choices[0];if(!chosen)return undefined;
  const files=chosen.route.copies.map(copy=>copy.original);
  for(const row of choices)if(!same(row.route.copies.map(copy=>copy.original),files))fail("Conflicting complete retained preview file inventories.");
  return mapRoute(closure,selected,chosen.route);
}
export function resolveCurrentFilmProofReferenceCarrier(closure:CurrentFilmProofClosure,selected:CurrentFilmProofCarrierSelection[],assetId:string) {
  const expected=closure.references.find(row=>row.asset.id===assetId);
  if(!expected)fail("Resolve only a required historical reference.");
  const choices=sources(closure).flatMap(source=>source.references.filter(row=>row.asset.id===assetId));
  for(const row of choices)if(!same(row.asset,expected.asset)||!same(row.file,expected.file))fail("Conflicting retained reference identity or original bytes.");
  return choices[0]?mapRoute(closure,selected,choices[0].route):undefined;
}
