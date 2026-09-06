export type GenerationStage="animatic"|"final"|"character-sheet";
export type JobStage=GenerationStage|"take-preview"|"take-final"|"dialogue-replacement";
export function isTakeStage(stage:string):boolean{return stage==="take-preview"||stage==="take-final";}
export function generationStage(stage:JobStage):GenerationStage{if(stage==="dialogue-replacement")throw new Error("Dialogue replacement is a media job, not a generation stage.");return stage==="take-preview"?"animatic":stage==="take-final"?"final":stage;}
export function isFilmStage(stage:string):boolean{return stage==="animatic"||stage==="final";}
