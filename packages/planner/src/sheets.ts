import { contentHash } from "../../generator/src/capabilities";
import { gateOrThrow } from "../../safety/src/index";
import type { ParseResult } from "../../parser/src/index";
import type { Shot } from "./index";
import { assertCharacterPermission, assertCurrentCastPermission, CastingConflict, CastingPermissionError, describeCharacter, validateCasting, type CastingSnapshot } from "./casting";
import { renderReferences } from "./reference-lock";

export type SheetKind = "turnaround" | "expressions" | "wardrobe" | "lighting" | "adult-ages";
export interface CharacterSheetPlan {
  schema:"hv-character-sheet/1"; revision:string; castingRevision:string; characterId:string; kind:SheetKind; seed:number; sceneNumber:number|null;
  views:{id:string;label:string;direction:string;sceneNumber:number}[];
}
export const SHEET_SIZE = "512x512";
const RECIPES:Record<Exclude<SheetKind,"wardrobe">,readonly (readonly [string,string])[]> = {
  turnaround:[["Front","Full body, straight-on front view, neutral standing pose."],["Side","Full body, exact side profile, neutral standing pose."],["Back","Full body, directly from behind, neutral standing pose."],["Three-quarter","Full body, three-quarter view, neutral standing pose."]],
  expressions:[["Neutral","Head-and-shoulders portrait, neutral expression."],["Joy","Head-and-shoulders portrait, joyful expression."],["Sadness","Head-and-shoulders portrait, sad expression."],["Anger","Head-and-shoulders portrait, angry expression."],["Surprise","Head-and-shoulders portrait, surprised expression."],["Concern","Head-and-shoulders portrait, concerned expression."]],
  lighting:[["Soft daylight","Three-quarter portrait in diffuse daylight."],["Warm side light","Three-quarter portrait in warm side light."],["Cool rim light","Three-quarter portrait with cool rim light."],["Low-key light","Three-quarter portrait with low-key studio lighting."]],
  "adult-ages":[["Young adult","Show a clearly adult, early-adulthood design variant."],["Middle adult","Show a clearly adult, middle-adulthood design variant."],["Older adult","Show a clearly adult, older-adulthood design variant."]],
};
export function createCharacterSheet(casting:CastingSnapshot, parsed:ParseResult, characterId:string, input:unknown):CharacterSheetPlan {
  validateCasting(casting,casting.projectId);
  if(!input || typeof input!=="object" || Array.isArray(input) || Object.keys(input).some(key=>!["kind","seed","sceneNumber"].includes(key)))throw new Error("Choose a sheet type, seed and scene scope.");
  const options=input as {kind:SheetKind;seed:number;sceneNumber:number|null};
  if(!["turnaround","expressions","wardrobe","lighting","adult-ages"].includes(options.kind) || !Number.isSafeInteger(options.seed) || options.seed<0 || options.seed>2147483647
    || !(options.sceneNumber===null || (Number.isInteger(options.sceneNumber) && parsed.scenes.some(scene=>scene.index+1===options.sceneNumber))))throw new Error("Invalid character sheet settings.");
  const character=casting.characters.find(value=>value.id===characterId);if(!character)throw new Error("Save this character before generating a sheet.");
  if(!parsed.scenes.length)throw new Error("Save a screenplay with a scene before generating a sheet.");
  const sceneNumber=options.sceneNumber ?? parsed.scenes[0]!.index+1;
  const views=options.kind==="wardrobe"
    ? [{label:"Default wardrobe",direction:"Full-body front view showing the default wardrobe.",sceneNumber},
      ...character.wardrobe.filter(entry=>entry.sceneNumber!==null && (options.sceneNumber===null || entry.sceneNumber===options.sceneNumber)).map(entry=>({label:"Scene "+entry.sceneNumber+" wardrobe",direction:"Full-body front view showing this scene's wardrobe.",sceneNumber:entry.sceneNumber!}))]
    : RECIPES[options.kind].map(([label,direction])=>({label,direction,sceneNumber}));
  if(views.length>60)throw new Error("Choose one scene to keep this wardrobe sheet within 60 views.");
  const definition={castingRevision:casting.revision,characterId,kind:options.kind,seed:options.seed,sceneNumber:options.sceneNumber,views:views.map((view,index)=>({id:"sheet-"+(index+1),...view}))};
  return {schema:"hv-character-sheet/1",...definition,revision:contentHash(definition)};
}
export function validateCharacterSheet(input:CharacterSheetPlan):CharacterSheetPlan {
  if(!input || Object.keys(input).sort().join(",")!=="castingRevision,characterId,kind,revision,sceneNumber,schema,seed,views" || input.schema!=="hv-character-sheet/1"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.characterId) || !/^[a-f0-9]{64}$/.test(input.castingRevision) || !["turnaround","expressions","wardrobe","lighting","adult-ages"].includes(input.kind)
    || !Number.isSafeInteger(input.seed) || input.seed<0 || input.seed>2147483647 || !(input.sceneNumber===null || (Number.isInteger(input.sceneNumber)&&input.sceneNumber>=1&&input.sceneNumber<=1000))
    || !Array.isArray(input.views) || !input.views.length || input.views.length>60 || input.views.some((view,index)=>!view || Object.keys(view).sort().join(",")!=="direction,id,label,sceneNumber"
      || view.id!=="sheet-"+(index+1) || typeof view.label!=="string" || view.label.length>100 || typeof view.direction!=="string" || view.direction.length>1000
      || !Number.isInteger(view.sceneNumber) || view.sceneNumber<1 || view.sceneNumber>1000))throw new Error("Invalid saved character sheet.");
  const {schema:_schema,revision,...definition}=input;if(contentHash(definition)!==revision)throw new Error("The saved character sheet changed.");return structuredClone(input);
}
export function characterSheetShots(input:CharacterSheetPlan, casting:CastingSnapshot, parsed:ParseResult, now=Date.now()):Shot[] {
  const plan=validateCharacterSheet(input);
  if(plan.castingRevision!==casting.revision || createCharacterSheet(casting,parsed,plan.characterId,{kind:plan.kind,seed:plan.seed,sceneNumber:plan.sceneNumber}).revision!==plan.revision)
    throw new CastingConflict("The character sheet no longer matches its saved cast and recipe.");
  const character=casting.characters.find(value=>value.id===plan.characterId)!;
  if(plan.sceneNumber===null && character.permission.scope!=="project")throw new CastingPermissionError("Select a permitted scene for this character sheet.");
  for(const binding of character.sceneBindings)if(parsed.scenes.find(scene=>scene.index+1===binding.sceneNumber)?.heading!==binding.heading)
    throw new CastingConflict("Scene "+binding.sceneNumber+" changed. Review and save the character before generating a sheet.");
  return plan.views.map(view=>{
    assertCharacterPermission(character,view.sceneNumber,now);
    // A sheet is a render, and a locked look decides what conditions a render -- in order. Reading
    // `character.references` here made the one render whose output becomes the next reference set
    // the one render the lock did not reach. `renderReferences` is that decision, in one place.
    const referenceAssets=renderReferences(character);
    // A fictional character's prompt is unchanged, so its retained sheet recipes keep their hashes.
    const subject=character.kind==="consented-real-person"?"the named cast member, as shown in the reference images":"the named original fictional character";
    const prompt="Character design study. One view of only "+subject+". Plain neutral background; no lettering, labels, grid, additional figures or contact sheet. Preserve the character's identity and traits across views.\n"
      +describeCharacter(character,view.sceneNumber,plan.kind==="wardrobe" && view.id==="sheet-1" ? character.wardrobe.find(entry=>entry.sceneNumber===null)?.description ?? "No default costume specified." : undefined)+"\nView direction: "+view.direction
      +(plan.kind==="adult-ages"?" This selected study intentionally varies adult age while preserving other traits.":"")
      +(referenceAssets.length?"\n"+referenceAssets.map((_,index)=>"Reference image "+(index+1)+" depicts "+character.name+".").join("\n"):"");
    gateOrThrow(prompt);
    return {id:view.id,sceneIndex:view.sceneNumber-1,prompt,sourcePrompt:character.name+" — "+view.label,dialogue:[],durationSec:1,seed:plan.seed,
      characterIds:[character.id],castingRevision:casting.revision,...(referenceAssets.length?{referenceAssets}:{})};
  });
}
export function assertSheetDispatch(plan:CharacterSheetPlan,saved:CastingSnapshot,current:CastingSnapshot,shotId:string,parsed:ParseResult,now=Date.now()):void {
  validateCharacterSheet(plan);
  const view=plan.views.find(value=>value.id===shotId);if(!view)throw new Error("The sheet dispatch does not name a planned view.");
  if(plan.sceneNumber===null && current.characters.find(value=>value.id===plan.characterId)?.permission.scope!=="project")
    throw new CastingPermissionError("This character no longer permits a project-wide sheet. Select a permitted scene and generate a new sheet.");
  assertCurrentCastPermission(saved,current,[plan.characterId],view.sceneNumber,now,parsed.scenes[view.sceneNumber-1]?.heading);
}
