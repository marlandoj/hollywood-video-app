import {resolveCurrentFilmProofCopies,type CurrentFilmProofCopies,type CurrentFilmProofCopy} from "../../planner/src/current-film-proof-copies";
import type {CurrentFilmJobV3} from "../../planner/src/current-film-mixed-jobs";
import {prepareCurrentFilmCopyFiles} from "./current-film-copy-publication";

/** Copy the complete frozen historical inventory into its isolated target roots.
 * The reader resolves the exact carrier (including reference storage); no path is
 * inferred from a claimed original owner. This verifies bytes, not native media,
 * current rights or durable custody. The held caller must establish those gates. */
export async function prepareCurrentFilmProofCopies(value:CurrentFilmProofCopies,plan:CurrentFilmJobV3,jobId:string,artifactRoot:string,
  read:(copy:CurrentFilmProofCopy,signal:AbortSignal)=>Promise<Response>,access:()=>Promise<void>,signal?:AbortSignal):Promise<void> {
  signal?.throwIfAborted();const {proof,closure}=resolveCurrentFilmProofCopies(value,plan,jobId);
  const copies=[...proof.carriers.flatMap(group=>group.copies),...proof.previews.flatMap(group=>group.copies),...proof.references.map(group=>group.copy)],
    byPath=new Map(copies.map(copy=>[copy.owned.path,copy]));
  // Only the exact compiled current-film output picture may exceed 8 GiB.
  const pictures=new Set(closure.previews.filter(({job})=>job.currentFilm).map(({job})=>job.output!.mp4Path));
  const largeFiles=proof.previews.flatMap(group=>group.copies.filter(copy=>pictures.has(copy.original.path)).map(copy=>copy.owned));
  await prepareCurrentFilmCopyFiles(artifactRoot,{projectId:proof.projectId,jobId,jobPlanRevision:plan.revision,kind:"proof",ordinal:null,
    specificationRevision:proof.revision,largeFiles},copies.map(copy=>copy.owned),async(file,active)=>{
      const copy=byPath.get(file.path);if(!copy)throw new Error("The proof reader requested an unselected owned role.");
      return read(structuredClone(copy),active);
    },access,signal);
}
