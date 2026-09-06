export type GenerationStage="animatic"|"final"|"character-sheet";
export type JobStage=GenerationStage|"take-preview"|"take-final";
export function isTakeStage(stage:string):boolean{return stage==="take-preview"||stage==="take-final";}
export function generationStage(stage:JobStage):GenerationStage{return stage==="take-preview"?"animatic":stage==="take-final"?"final":stage;}
export function isFilmStage(stage:string):boolean{return stage==="animatic"||stage==="final";}
