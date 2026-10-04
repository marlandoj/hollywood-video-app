export type GenerationStage="animatic"|"final"|"character-sheet";
export type JobStage=GenerationStage|"take-preview"|"take-final"|"dialogue-replacement"|"audio-take"|"lip-sync"|"sound-mix"|"picture-edit"|"assembly-edit"|"motion-graphic"|"delivery"|"feature-film";
export function isTakeStage(stage:string):boolean{return stage==="take-preview"||stage==="take-final";}
export function generationStage(stage:JobStage):GenerationStage{if(stage==="dialogue-replacement"||stage==="audio-take"||stage==="lip-sync"||stage==="sound-mix"||stage==="picture-edit"||stage==="assembly-edit"||stage==="motion-graphic"||stage==="delivery"||stage==="feature-film")throw new Error("Independent media jobs do not use video generation stages.");return stage==="take-preview"?"animatic":stage==="take-final"?"final":stage;}
export function isFilmStage(stage:string):boolean{return stage==="animatic"||stage==="final";}
/**
 * "The latest finished cut of this project", declared once.
 *
 * The owner's create-review-link path and the reviewer's unbound read path both
 * answer this question, and before this function they answered it with two
 * different comparators — completion time then identity on one side, identity
 * alone on the other. Job identities are random UUIDs, so the two orders agree
 * only by chance: an unbound review link could show a cut the owner's own
 * "latest" never pointed at. Completion time is the ordering the question means;
 * identity breaks ties so the answer is total and stable.
 *
 * The parameter is structural rather than `Job` so that this module, which
 * `packages/queue` imports, does not import `packages/queue` back.
 */
export function latestFinishedCut<T extends {id:string;projectId:string;stage:string;status:string;completedAt?:string|null;output?:unknown}>(jobs:readonly T[],projectId:string):T|undefined{
  return jobs.filter(job=>job.projectId===projectId&&isFilmStage(job.stage)&&job.status==="done"&&job.output)
    .sort((a,b)=>(a.completedAt??"").localeCompare(b.completedAt??"")||a.id.localeCompare(b.id)).at(-1);
}
