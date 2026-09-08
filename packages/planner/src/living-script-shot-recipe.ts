import {contentHash as hash} from "../../generator/src/capabilities";
import {parseFountain,type Scene,type SceneBeat} from "../../parser/src/index";
import {coveragePrompt} from "./coverage";
import {editFail} from "./edit-timeline";
import type {Shot} from "./index";
import type {LivingScriptDocument,LivingScriptDocumentScene,LivingScriptDocumentBeat} from "./living-script-document";
import type {LivingScriptBaseRecipe,LivingScriptShotDialogue} from "./living-script-shot-plan";

export type LivingScriptMaterialRecipe=Extract<LivingScriptBaseRecipe,{kind:"legacy-default/1"}>|Omit<Extract<LivingScriptBaseRecipe,{kind:"authored-coverage/1"}>,"cutRevision">;
/** Internal shared construction after the enclosing plan compiler validates full identity and coverage. */
export type LivingScriptSceneView={scene:Scene;document:LivingScriptDocumentScene;beats:Map<string,SceneBeat>;physicalBeats:Map<string,LivingScriptDocumentBeat>;physical:Map<string,LivingScriptDocument["lines"][number]>};
export function livingScriptSceneViews(document:LivingScriptDocument):Map<string,LivingScriptSceneView> {
  const parsed=parseFountain(document.context.base.text),physical=new Map(document.lines.map(line=>[line.id,line]));
  return new Map(document.scenes.map(scene=>{const current=parsed.scenes[scene.sceneIndex]!,beats=new Map(current.beats!.map(beat=>[beat.id,beat]));return [scene.id,{document:scene,scene:current,physical,physicalBeats:new Map(scene.beats.map(beat=>[beat.id,beat])),beats:new Map(scene.beats.map(beat=>[beat.id,beats.get(beat.parserBeatId)!]))}];}));
}
export function livingScriptDialogueGroup(view:LivingScriptSceneView,beatIds:string[]):LivingScriptShotDialogue {
  return {beatIds,lineIds:beatIds.flatMap(id=>{const physical=view.physicalBeats.get(id)!,beat=view.beats.get(id)!;if(!physical||beat?.kind!=="dialogue")editFail("A shot dialogue recipe lost its exact beat role.");return physical.lineIds.slice(physical.lineIds.length-beat.lines.length);})};
}
export function livingScriptDefaultDialogue(view:LivingScriptSceneView):LivingScriptShotDialogue[] {
  const groups:LivingScriptShotDialogue[]=[];
  for(const beat of view.document.beats){const parsed=view.beats.get(beat.id)!;if(parsed.kind!=="dialogue")continue;
    const group=livingScriptDialogueGroup(view,[beat.id]);
    if(beat.lineIds.length===parsed.lines.length+1)groups.push(group);
    else {const previous=groups.at(-1);if(!previous)editFail("A default dialogue continuation lost its physical character cue.");previous.beatIds.push(...group.beatIds);previous.lineIds.push(...group.lineIds);}
  }
  return groups;
}
function groupDialogue(view:LivingScriptSceneView,group:LivingScriptShotDialogue):Shot["dialogue"][number] {
  const beats=group.beatIds.map(id=>view.beats.get(id));if(!beats.length||beats.some(beat=>beat?.kind!=="dialogue"))editFail("A shot recipe requires its exact current dialogue beats.");
  const first=beats[0] as Extract<SceneBeat,{kind:"dialogue"}>;
  if(beats.some(beat=>beat?.kind!=="dialogue"||beat.character!==first.character))editFail("A dialogue recipe changed its speaker context.");
  const current=livingScriptDialogueGroup(view,group.beatIds);
  if(hash(current.lineIds)!==hash(group.lineIds))editFail("A dialogue recipe changed its physical line membership.");
  return {character:first.character,lines:group.lineIds.map(id=>{const line=view.physical.get(id);if(!line)editFail("A dialogue recipe lost its physical line.");return line.text.trim();})};
}
/** Rebuild base inputs exclusively from the canonical current screenplay and exact recipe membership. */
export function materializeLivingScriptShotRecipe(row:{recipe:LivingScriptMaterialRecipe|null;renderId:string;base:{seed:number;requestedFrames:number}},view:LivingScriptSceneView):Shot {
  const recipe=row.recipe;if(!recipe)editFail("Review the unmapped shot recipe before materialization.");
  const dialogue=recipe.dialogue.map(group=>groupDialogue(view,group));let prompt:string;
  if(recipe.kind==="legacy-default/1"){
    const action=recipe.headingFallback?[view.scene.heading]:recipe.actionBeatIds.map(id=>{const beat=view.beats.get(id);if(beat?.kind!=="action")editFail("A default shot lost its exact current action membership.");return beat.text;});
    prompt=`${view.scene.heading}. ${action.join(" ")}`;
    return {id:row.renderId,sceneIndex:view.scene.index,prompt,dialogue,durationSec:row.base.requestedFrames/30,seed:row.base.seed};
  }
  const describe=(id:string)=>{const beat=view.beats.get(id);if(!beat)editFail("An authored shot lost its current beat or alternate-view anchor.");return beat.kind==="dialogue"?beat.character+": "+beat.lines.join(" "):beat.text;};
  const content=recipe.beatIds.length?recipe.beatIds.map(describe).join("\n"):"Silent alternate view"+(recipe.afterBeatId?" after: "+describe(recipe.afterBeatId):" before the opening action")+". Do not repeat dialogue or action.";
  prompt=[view.scene.heading,content,"Proposed coverage (creative intent):",coveragePrompt(recipe.coverage),recipe.sceneNotes?"Scene direction: "+recipe.sceneNotes:"",recipe.shotNotes?"Shot direction: "+recipe.shotNotes:""].filter(Boolean).join("\n");
  if(prompt.length>30000)editFail("This coverage shot is too long; review its beats and notes.");
  return {id:row.renderId,sceneIndex:view.scene.index,prompt,dialogue,durationSec:row.base.requestedFrames/30,seed:row.base.seed,coverageIntent:structuredClone(recipe.coverage),cutDurationFrames:recipe.durationFrames};
}
