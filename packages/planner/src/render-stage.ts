export type GenerationStage="animatic"|"final"|"character-sheet";
export type JobStage=GenerationStage|"take-preview"|"take-final"|"dialogue-replacement"|"audio-take"|"lip-sync"|"sound-mix"|"picture-edit"|"assembly-edit"|"motion-graphic";
export function isTakeStage(stage:string):boolean{return stage==="take-preview"||stage==="take-final";}
export function generationStage(stage:JobStage):GenerationStage{if(stage==="dialogue-replacement"||stage==="audio-take"||stage==="lip-sync"||stage==="sound-mix"||stage==="picture-edit"||stage==="assembly-edit"||stage==="motion-graphic")throw new Error("Independent media jobs do not use video generation stages.");return stage==="take-preview"?"animatic":stage==="take-final"?"final":stage;}
export function isFilmStage(stage:string):boolean{return stage==="animatic"||stage==="final";}
