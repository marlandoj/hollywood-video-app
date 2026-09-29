import {contentHash} from "../../generator/src/capabilities";
import {parseFountain,type SceneBeat} from "../../parser/src/index";
import {compileEditScriptSource} from "./edit-script-source";
import type {EditSourceReceipt} from "./edit-sources";
import {editFail} from "./edit-timeline";
import {createLivingScriptStructureBase,livingScriptStructureLines,validateLivingScriptStructure,type LivingScriptStructureBase,type LivingScriptStructurePatch} from "./living-script-structure";

export const LIVING_SCRIPT_DOCUMENT_LIMITS={bytes:64*1024**2,nodes:1000000,ancestry:32,relations:100000} as const;
export interface LivingScriptDocumentContext {base:LivingScriptStructureBase;ancestry:LivingScriptStructurePatch[]}
export interface LivingScriptDocumentLine {
  id:string;physicalLineId:string;line:number;start:number;end:number;text:string;
  origin:{scriptRevision:string;physicalLineId:string;patchRevision:string|null};
}
export interface LivingScriptDocumentBeat {
  id:string;parserBeatId:string;kind:SceneBeat["kind"];sceneId:string;sceneIndex:number;
  startLine:number;endLine:number;lineIds:string[];anchorLineId:string;contentRevision:string;character:string|null;
}
export interface LivingScriptDocumentScene {
  id:string;sceneIndex:number;heading:string;headingLineId:string;startLine:number;endLine:number;beats:LivingScriptDocumentBeat[];
}
export interface LivingScriptDocumentRelation {
  patchRevision:string;kind:"scene"|"beat";beforeIds:string[];afterIds:string[];
  treatment:"moved"|"changed"|"introduced"|"deleted"|"replaced"|"split"|"merged"|"repartitioned"|"role-changed"|"unbound";
}
export interface LivingScriptDocument {
  schema:"hv-living-script-document/1";context:LivingScriptDocumentContext;projectId:string;
  scriptRevision:string;rootScriptRevision:string;ancestryRevision:string;lines:LivingScriptDocumentLine[];
  scenes:LivingScriptDocumentScene[];relations:LivingScriptDocumentRelation[];
  removedLines:{id:string;patchRevision:string;treatment:"deleted"|"replaced"}[];
  unbound:{lineIds:string[];reason:string}[];parse:{rejected:boolean;rejectionReason:string|null;warnings:ReturnType<typeof parseFountain>["warnings"]};
  complete:boolean;revision:string;
}
export interface LivingScriptDocumentSource {
  schema:"hv-living-script-document-source/1";document:LivingScriptDocument;
  source:{sourceId:string;sourceRevision:string;receiptRevision:string;indexRevision:string;scriptRevision:string};
  entries:{entryId:string;kind:string;originalLineIds:string[];currentLineIds:string[];
    status:"retained"|"moved"|"context-changed"|"partial"|"deleted"|"replaced"|"unbound";reason:string|null}[];revision:string;
}
const hash=(value:unknown)=>contentHash(value);
function exact(value:unknown,keys:string[]):void {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))editFail("Retain the exact structural document fields.");}
/** Inspect descriptors before accessing fields; reject excessive work before cloning/compiling. */
function portable<T>(input:T):T {
  let nodes=0,bytes=0;const active=new Set<object>();
  const visit=(value:unknown,depth:number):void=>{
    if(++nodes>LIVING_SCRIPT_DOCUMENT_LIMITS.nodes||depth>160)editFail("The structural document exceeds its metadata capacity.");
    if(typeof value==="string"){bytes+=Buffer.byteLength(value,"utf8");if(bytes>LIVING_SCRIPT_DOCUMENT_LIMITS.bytes)editFail("The structural document exceeds its metadata capacity.");return;}
    if(value===null||typeof value==="boolean")return;if(typeof value==="number"&&Number.isFinite(value)&&!Object.is(value,-0))return;
    if(typeof value!=="object"||active.has(value))editFail("Retain portable structural document data.");
    const array=Array.isArray(value),keys=Reflect.ownKeys(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Retain plain structural document records.");
    if(array&&keys.length!==value.length+1)editFail("Retain dense structural document arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const property=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!property.enumerable||!Object.hasOwn(property,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))editFail("Retain document data without accessors or hidden fields.");
      bytes+=Buffer.byteLength(key,"utf8");visit(property.value,depth+1);
    }active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>LIVING_SCRIPT_DOCUMENT_LIMITS.bytes)editFail("The structural document exceeds its metadata capacity.");return structuredClone(input);
}
class Budget {
  bytes=0;nodes=0;relations=0;
  add(value:unknown):void {const visit=(item:unknown):void=>{if(++this.nodes>LIVING_SCRIPT_DOCUMENT_LIMITS.nodes)editFail("The structural document exceeds its incremental output capacity.");if(item&&typeof item==="object")for(const child of Object.values(item))visit(child);};visit(value);this.bytes+=Buffer.byteLength(JSON.stringify(value),"utf8")+1;if(this.bytes>LIVING_SCRIPT_DOCUMENT_LIMITS.bytes)editFail("The structural document exceeds its incremental output capacity.");}
  relation():void {if(++this.relations>LIVING_SCRIPT_DOCUMENT_LIMITS.relations)editFail("The structural document exceeds its ancestry relation capacity.");}
}
const seal=<T extends object>(data:T):T&{revision:string}=>({...data,revision:hash(data)});
function checkedBase(value:LivingScriptStructureBase):LivingScriptStructureBase {
  exact(value,["schema","projectId","version","text","scriptRevision","locks","revision"]);
  const result=createLivingScriptStructureBase({projectId:value.projectId,version:value.version,text:value.text,locks:value.locks});
  if(hash(result)!==hash(value))editFail("The current structural document base changed.");return result;
}
function rootLines(base:LivingScriptStructureBase):LivingScriptDocumentLine[] {return livingScriptStructureLines(base).map(line=>{
  const origin={scriptRevision:base.scriptRevision,physicalLineId:line.id,patchRevision:null};return {...line,physicalLineId:line.id,id:hash({schema:"hv-document-line/1",origin}),origin};
});}
function advanceLines(before:LivingScriptDocumentLine[],patch:LivingScriptStructurePatch,removed:LivingScriptDocument["removedLines"],budget:Budget):LivingScriptDocumentLine[] {
  const retained=new Map(patch.correspondence.filter(row=>row.afterLine!==null).map(row=>[row.afterLine!,before[row.beforeLine-1]!])),introduced=new Map(patch.introduced.map(row=>[row.line,row]));
  for(const row of patch.correspondence)if(row.afterLine===null){budget.relation();const value={id:before[row.beforeLine-1]!.id,patchRevision:patch.revision,treatment:row.treatment as "deleted"|"replaced"};budget.add(value);removed.push(value);}
  return livingScriptStructureLines(patch.after).map(line=>{const previous=retained.get(line.line);if(previous)return {...line,id:previous.id,physicalLineId:line.id,origin:previous.origin};
    if(!introduced.has(line.line))editFail("The structural document lost an introduced line's ancestry.");
    const origin={scriptRevision:patch.after.scriptRevision,physicalLineId:line.id,patchRevision:patch.revision};return {...line,id:hash({schema:"hv-document-line/1",origin}),physicalLineId:line.id,origin};
  });
}
type Shape={scenes:LivingScriptDocumentScene[];unbound:LivingScriptDocument["unbound"];parse:LivingScriptDocument["parse"]};
function shape(base:LivingScriptStructureBase,lines:LivingScriptDocumentLine[]):Shape {
  const parsed=parseFountain(base.text),raw=lines.map(line=>line.text.replace(/\r?\n$/,"")),protectedLines=new Set<number>(),unsupported=new Set<number>();let block=false,note:number|null=null;
  for(const [index,line]of raw.entries()){
    if(block){protectedLines.add(index+1);if(line.includes("*/"))block=false;}
    else if(line.includes("/*")&&!line.includes("*/")){protectedLines.add(index+1);block=true;}
    else if(/\[\[[^\]]*\]\]|\/\*[\s\S]*?\*\//.test(line))protectedLines.add(index+1);
    // The parser supports inline notes. Multiline notes must not create invented headings/beats.
    if(note!==null){unsupported.add(index+1);if(line.includes("]]"))note=null;}
    else if(!protectedLines.has(index+1)&&line.includes("[[")&&!line.includes("]]")){note=index;unsupported.add(index+1);}
  }
  const headings=raw.flatMap((line,index)=>!protectedLines.has(index+1)&&(/^(INT\.?\/EXT|INT|EXT|EST|I\/E)[.\s]/i.test(line.trim())||/^\.(?!\.)/.test(line.trim()))?[index+1]:[]);
  if(parsed.scenes.length!==headings.length)editFail("The parser lost its exact physical scene headings.");
  const unbound:LivingScriptDocument["unbound"]=parsed.unparseable.filter(item=>lines[item.line-1]).map(item=>({lineIds:[lines[item.line-1]!.id],reason:"The current parser does not bind this physical construct."}));
  if(unsupported.size)unbound.push({lineIds:[...unsupported].map(line=>lines[line-1]!.id),reason:"Multiline note boundaries are not supported by the current parser; their contents have no scene or beat identity."});
  const scenes:LivingScriptDocumentScene[]=[];
  for(const scene of parsed.scenes){
    const startLine=headings[scene.index]!,endLine=headings[scene.index+1]??lines.length+1;
    if(unsupported.has(startLine)){const ids=lines.slice(startLine-1,endLine-1).map(line=>line.id);unbound.push({lineIds:ids,reason:"This parsed scene starts inside an unsupported protected construct."});continue;}
    const headingLineId=lines[startLine-1]!.id,id=hash({schema:"hv-document-scene/1",headingLineId}),beats:LivingScriptDocumentBeat[]=[];
    for(const beat of scene.beats??[]){
      const span=lines.slice(beat.startLine-1,beat.endLine),visible=span.filter(line=>!protectedLines.has(line.line)&&raw[line.line-1]!.trim());
      if(!visible.length||span.some(line=>unsupported.has(line.line))){unbound.push({lineIds:span.map(line=>line.id),reason:"This parser beat crosses an unsupported physical span."});continue;}
      const actual=visible.map(line=>raw[line.line-1]!.trim()),valid=beat.kind==="dialogue"?(actual.length===beat.lines.length||actual.length===beat.lines.length+1&&actual[0]!.replace(/\s*\(.*\)$/," ").trim()===beat.character)&&hash(actual.slice(actual.length-beat.lines.length))===hash(beat.lines):actual.length===1&&actual[0]===beat.text;
      if(!valid)editFail("The parser beat lost its exact physical-span evidence.");
      const anchorLineId=visible[0]!.id,{id:_id,startLine:_start,endLine:_end,...content}=beat;
      beats.push({id:hash({schema:"hv-document-beat/1",kind:beat.kind,anchorLineId}),parserBeatId:beat.id,kind:beat.kind,sceneId:id,sceneIndex:scene.index,startLine:beat.startLine,endLine:beat.endLine+1,lineIds:visible.map(line=>line.id),anchorLineId,contentRevision:hash(content),character:beat.kind==="dialogue"?beat.character:null});
    }
    scenes.push({id,sceneIndex:scene.index,heading:scene.heading,headingLineId,startLine,endLine,beats});
  }
  return {scenes,unbound,parse:{rejected:parsed.rejected,rejectionReason:parsed.rejectionReason??null,warnings:parsed.warnings}};
}
function relate(old:Shape,next:Shape,patch:LivingScriptStructurePatch,relations:LivingScriptDocumentRelation[],budget:Budget):void {
  const add=(kind:LivingScriptDocumentRelation["kind"],beforeIds:string[],afterIds:string[],treatment:LivingScriptDocumentRelation["treatment"])=>{budget.relation();const value={patchRevision:patch.revision,kind,beforeIds,afterIds,treatment};budget.add(value);relations.push(value);};
  const oldScenes=new Map(old.scenes.map(scene=>[scene.headingLineId,scene])),newScenes=new Map(next.scenes.map(scene=>[scene.headingLineId,scene])),unbound=new Set(next.unbound.flatMap(value=>value.lineIds));
  for(const scene of next.scenes){const previous=oldScenes.get(scene.headingLineId);scene.id=previous?.id??hash({schema:"hv-document-scene-created/1",patchRevision:patch.revision,headingLineId:scene.headingLineId});for(const beat of scene.beats)beat.sceneId=scene.id;}
  const sceneContent=(scene:LivingScriptDocumentScene)=>hash({heading:scene.heading,beats:scene.beats.map(beat=>({kind:beat.kind,lineIds:beat.lineIds,contentRevision:beat.contentRevision}))});
  for(const scene of old.scenes){const current=newScenes.get(scene.headingLineId);if(!current)add("scene",[scene.id],[],unbound.has(scene.headingLineId)?"unbound":patch.correspondence[scene.startLine-1]?.treatment==="replaced"?"replaced":"deleted");else if(sceneContent(scene)!==sceneContent(current))add("scene",[scene.id],[scene.id],"changed");else if(current.sceneIndex!==scene.sceneIndex||current.startLine!==scene.startLine)add("scene",[scene.id],[scene.id],"moved");}
  for(const scene of next.scenes)if(!oldScenes.has(scene.headingLineId))add("scene",[],[scene.id],"introduced");
  const before=old.scenes.flatMap(scene=>scene.beats),after=next.scenes.flatMap(scene=>scene.beats),owners=new Map<string,number>();
  for(const [i,beat]of before.entries())for(const line of beat.lineIds){if(owners.has(line))editFail("A physical line belongs to ambiguous parser beats.");owners.set(line,i);}
  const parents=after.map(beat=>[...new Set(beat.lineIds.flatMap(line=>owners.has(line)?[owners.get(line)!]:[]))]),children=before.map(()=>[] as number[]);
  parents.forEach((values,child)=>values.forEach(parent=>children[parent]!.push(child)));
  const visited=new Set<number>(),replaced=new Set(patch.correspondence.filter(row=>row.treatment==="replaced").map(row=>row.beforeLine));
  const created=(beat:LivingScriptDocumentBeat)=>hash({schema:"hv-document-beat-created/1",patchRevision:patch.revision,anchorLineId:beat.anchorLineId,kind:beat.kind});
  for(let i=0;i<before.length;i++){
    if(!children[i]!.length){const beat=before[i]!;add("beat",[beat.id],[],beat.lineIds.some(line=>unbound.has(line))?"unbound":Array.from({length:beat.endLine-beat.startLine},(_,n)=>n+beat.startLine).some(line=>replaced.has(line))?"replaced":"deleted");continue;}
    if(visited.has(i))continue;const oldSet=new Set<number>(),newSet=new Set<number>(),queue=[i];
    while(queue.length){const n=queue.pop()!;if(oldSet.has(n))continue;oldSet.add(n);visited.add(n);for(const child of children[n]!){if(newSet.has(child))continue;newSet.add(child);for(const parent of parents[child]!)if(!oldSet.has(parent))queue.push(parent);}}
    const olds=[...oldSet].sort((a,b)=>a-b),news=[...newSet].sort((a,b)=>a-b),oldBeats=olds.map(n=>before[n]!),newBeats=news.map(n=>after[n]!);
    if(olds.length===1&&news.length===1){const a=oldBeats[0]!,b=newBeats[0]!;
      if(a.kind!==b.kind){b.id=created(b);add("beat",[a.id],[b.id],"role-changed");}
      else if(a.anchorLineId!==b.anchorLineId){b.id=created(b);add("beat",[a.id],[b.id],"replaced");}
      else {b.id=a.id;if(a.contentRevision!==b.contentRevision||hash(a.lineIds)!==hash(b.lineIds))add("beat",[a.id],[b.id],"changed");else if(a.sceneId!==b.sceneId||a.startLine!==b.startLine||a.parserBeatId!==b.parserBeatId)add("beat",[a.id],[b.id],"moved");}
    }else {for(const beat of newBeats)beat.id=hash({schema:"hv-document-beat-repartition/1",patchRevision:patch.revision,anchorLineId:beat.anchorLineId,kind:beat.kind});add("beat",oldBeats.map(beat=>beat.id),newBeats.map(beat=>beat.id),olds.length===1?"split":news.length===1?"merged":"repartitioned");}
  }
  for(const [i,beat]of after.entries())if(!parents[i]!.length){beat.id=created(beat);add("beat",[],[beat.id],"introduced");}
}

/** Pure physical ancestry, not acceptance, source availability, permission or safe-reuse proof.
 * The service must supply an authoritative current base and its accepted contiguous ancestry. */
export function compileLivingScriptDocument(input:LivingScriptDocumentContext):LivingScriptDocument {
  const context=portable(input);exact(context,["base","ancestry"]);const base=checkedBase(context.base);
  if(!Array.isArray(context.ancestry)||context.ancestry.length>LIVING_SCRIPT_DOCUMENT_LIMITS.ancestry)editFail("Retain up to 32 contiguous structural ancestry patches.");
  const ancestry=context.ancestry.map(validateLivingScriptStructure),root=ancestry[0]?.before??base;
  for(const [index,patch]of ancestry.entries())if(patch.before.projectId!==base.projectId||index&&hash(patch.before)!==hash(ancestry[index-1]!.after))editFail("The structural document ancestry has a gap, foreign project or conflicting branch.");
  if(hash(ancestry.at(-1)?.after??root)!==hash(base))editFail("The structural ancestry does not end at the exact current screenplay and locks.");
  const budget=new Budget(),relations:LivingScriptDocumentRelation[]=[],removedLines:LivingScriptDocument["removedLines"]=[];
  budget.add({schema:"hv-living-script-document/1",context,projectId:base.projectId,scriptRevision:base.scriptRevision,rootScriptRevision:root.scriptRevision,ancestryRevision:hash(ancestry.map(patch=>patch.revision)),lines:[],scenes:[],relations:[],removedLines:[],unbound:[],parse:null,complete:false,revision:"0".repeat(64)});
  let lines=rootLines(root),current=shape(root,lines);
  for(const patch of ancestry){lines=advanceLines(lines,patch,removedLines,budget);const next=shape(patch.after,lines);relate(current,next,patch,relations,budget);current=next;}
  for(const line of lines)budget.add(line);for(const scene of current.scenes)budget.add(scene);for(const entry of current.unbound)budget.add(entry);budget.add(current.parse);
  return seal({schema:"hv-living-script-document/1" as const,context,projectId:base.projectId,scriptRevision:base.scriptRevision,rootScriptRevision:root.scriptRevision,ancestryRevision:hash(ancestry.map(patch=>patch.revision)),lines,scenes:current.scenes,relations,removedLines,unbound:current.unbound,parse:current.parse,complete:!current.parse.rejected&&!current.unbound.length});
}
export function validateLivingScriptDocument(input:LivingScriptDocument):LivingScriptDocument {
  const document=portable(input),compiled=compileLivingScriptDocument(document.context);if(hash(document)!==hash(compiled))editFail("The structural document identities or ancestry changed.");return compiled;
}

/** Bootstrap only from an actual validated original index. Different versions with identical text
 * remain different roots. Entries without physical screenplay evidence remain explicitly unbound. */
export function bootstrapLivingScriptDocument(source:EditSourceReceipt,input:LivingScriptDocumentContext):LivingScriptDocumentSource {
  const copied=portable({source,input}),index=compileEditScriptSource(copied.source),document=compileLivingScriptDocument(copied.input),root=document.context.ancestry[0]?.before??document.context.base;
  if(copied.source.job.currentFilm)editFail("Retain the current film's existing canonical document ancestry instead of bootstrapping another root.");
  if(copied.source.job.projectId!==document.projectId||index.scriptRevision===null||index.scriptText===null||index.scriptRevision!==root.scriptRevision||index.scriptText!==root.text)editFail("The retained source must match the exact document ancestry root, including its screenplay version.");
  const oldLines=rootLines(root),before=shape(root,oldLines),currentLines=new Map(document.lines.map(line=>[line.id,line])),removed=new Map(document.removedLines.map(line=>[line.id,line])),budget=new Budget();
  const semantic=(scenes:LivingScriptDocumentScene[])=>{const result=new Map<string,{kind:string;sceneId:string;beatId:string|null;character:string|null}>();for(const scene of scenes){result.set(scene.headingLineId,{kind:"scene",sceneId:scene.id,beatId:null,character:null});for(const beat of scene.beats)for(const id of beat.lineIds)result.set(id,{kind:beat.kind,sceneId:scene.id,beatId:beat.id,character:beat.character});}return result;},oldSemantic=semantic(before.scenes),newSemantic=semantic(document.scenes),entries:LivingScriptDocumentSource["entries"]=[];
  const binding={sourceId:index.sourceId,sourceRevision:index.sourceRevision,receiptRevision:index.receiptRevision,indexRevision:index.revision,scriptRevision:index.scriptRevision};budget.add({schema:"hv-living-script-document-source/1",document,source:binding,entries:[],revision:"0".repeat(64)});
  for(const entry of index.entries){budget.relation();let status:LivingScriptDocumentSource["entries"][number]["status"]="unbound",reason:string|null=null;
    const originals=entry.startLine===null||entry.endLine===null?[]:oldLines.slice(entry.startLine-1,entry.endLine),originalLineIds=originals.map(line=>line.id),retained=originals.filter(line=>currentLines.has(line.id));
    if(!originals.length||originals.some(line=>oldSemantic.get(line.id)?.kind!==entry.kind)){reason="This retained entry has no exact supported physical screenplay binding.";}
    else if(!retained.length){status=originals.some(line=>removed.get(line.id)?.treatment==="replaced")?"replaced":"deleted";reason="This original entry has no inherited current physical line.";}
    else if(retained.length!==originals.length){status="partial";reason="Only some original physical lines survive; no replacement or split correspondence is inferred.";}
    else if(retained.some(line=>hash(oldSemantic.get(line.id))!==hash(newSemantic.get(line.id)??null))){status="context-changed";reason="The physical line survives in a different or unbound scene/beat/speaker context.";}
    else status=retained.some(line=>currentLines.get(line.id)!.line!==line.line)?"moved":"retained";
    const value={entryId:entry.id,kind:entry.kind,originalLineIds,currentLineIds:retained.map(line=>currentLines.get(line.id)!.physicalLineId),status,reason};budget.add(value);entries.push(value);
  }
  return seal({schema:"hv-living-script-document-source/1" as const,document,source:binding,entries});
}
export function validateLivingScriptDocumentSource(source:EditSourceReceipt,input:LivingScriptDocumentSource):LivingScriptDocumentSource {
  const copied=portable({source,input}),compiled=bootstrapLivingScriptDocument(copied.source,copied.input.document.context);if(hash(compiled)!==hash(copied.input))editFail("The retained source-to-document binding changed.");return compiled;
}
