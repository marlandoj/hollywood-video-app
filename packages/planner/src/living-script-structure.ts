import {createHash} from "node:crypto";
import {contentHash} from "../../generator/src/capabilities";
import {editFail,editId} from "./edit-timeline";

export const LIVING_SCRIPT_STRUCTURE_LIMITS={characters:200000,lines:20000,operations:256,locks:2048,metadataBytes:16*1024**2,ancestry:32} as const;
/** One-based, half-open physical lines. A terminal newline does not add an empty physical line. */
export interface LivingScriptPhysicalRange {startLine:number;endLine:number}
export interface LivingScriptStructureBase {
  schema:"hv-living-script-structure-base/1";projectId:string;version:number;text:string;
  scriptRevision:string;locks:LivingScriptPhysicalRange[];revision:string;
}
export interface LivingScriptStructureBlock extends LivingScriptPhysicalRange {id:string}
export interface LivingScriptStructureBoundary {beforeLine:number;id:string}
export interface LivingScriptStructureLine {line:number;id:string;start:number;end:number;text:string}
export type LivingScriptStructureOperation={id:string}&(
  {kind:"delete";block:LivingScriptStructureBlock}|
  {kind:"replace";block:LivingScriptStructureBlock;text:string}|
  {kind:"move";block:LivingScriptStructureBlock;to:LivingScriptStructureBoundary}|
  {kind:"insert";at:LivingScriptStructureBoundary;text:string}
);
export interface LivingScriptStructureRequest {baseRevision:string;operations:LivingScriptStructureOperation[]}
export interface LivingScriptStructureCorrespondence {
  beforeLine:number;beforeLineId:string;afterLine:number|null;afterLineId:string|null;
  treatment:"preserved"|"moved"|"replaced"|"deleted";operationId:string|null;
}
export type LivingScriptStructureInversePiece={kind:"retained";startLine:number;endLine:number}|{kind:"restore";operationId:string;text:string};
export interface LivingScriptStructurePatch {
  schema:"hv-living-script-structure/1";before:LivingScriptStructureBase;after:LivingScriptStructureBase;
  request:LivingScriptStructureRequest;correspondence:LivingScriptStructureCorrespondence[];
  introduced:{line:number;lineId:string;operationId:string;kind:"insert"|"replace"}[];
  inverse:{beforeRevision:string;afterRevision:string;pieces:LivingScriptStructureInversePiece[];sha256:string};revision:string;
}

function exact(value:unknown,keys:string[]):void {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))editFail("Use the exact supported structural screenplay fields.");
}
function integer(value:number,min:number,max:number,label:string):void {
  if(!Number.isSafeInteger(value)||Object.is(value,-0)||value<min||value>max)editFail("Use a bounded integer "+label+".");
}
function hash(value:unknown):void {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain the exact structural screenplay identity.");}
/** Inspect descriptors before cloning, hashing or reading caller fields. No getters or JSON hooks. */
function portable<T>(value:T):T {
  let nodes=0,bytes=0;const active=new Set<object>();
  const visit=(item:unknown,depth:number):void=>{
    if(++nodes>250000||depth>64)editFail("The structural screenplay metadata exceeds its capacity.");
    if(typeof item==="string"){bytes+=Buffer.byteLength(item,"utf8");if(bytes>LIVING_SCRIPT_STRUCTURE_LIMITS.metadataBytes)editFail("The structural screenplay metadata exceeds its capacity.");return;}
    if(item===null||typeof item==="boolean")return;
    if(typeof item==="number"){if(!Number.isFinite(item)||Object.is(item,-0))editFail("Use finite structural screenplay values.");return;}
    if(typeof item!=="object"||active.has(item))editFail("Use portable, non-cyclic structural screenplay records.");
    const array=Array.isArray(item),prototype=Object.getPrototypeOf(item),keys=Reflect.ownKeys(item);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Use plain structural screenplay records.");
    if(array&&keys.length!==item.length+1)editFail("Use dense structural screenplay arrays.");active.add(item);
    for(const key of keys){if(array&&key==="length")continue;const descriptor=Object.getOwnPropertyDescriptor(item,key)!;
      if(typeof key!=="string"||!descriptor.enumerable||!Object.hasOwn(descriptor,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))editFail("Use plain enumerable structural screenplay fields.");
      bytes+=Buffer.byteLength(key,"utf8");visit(descriptor.value,depth+1);
    }active.delete(item);
  };visit(value,0);if(Buffer.byteLength(JSON.stringify(value),"utf8")>LIVING_SCRIPT_STRUCTURE_LIMITS.metadataBytes)editFail("The structural screenplay metadata exceeds its capacity.");return structuredClone(value);
}
function script(text:string):void {
  if(typeof text!=="string"||text.length>LIVING_SCRIPT_STRUCTURE_LIMITS.characters||Buffer.from(text,"utf8").toString("utf8")!==text||/\r(?!\n)/.test(text)||[...text].some(char=>{const code=char.charCodeAt(0);return code<32&&code!==9&&code!==10&&code!==13||code>=127&&code<=159||code===8232||code===8233;}))editFail("Use bounded UTF-8 screenplay text with LF or CRLF physical lines.");
}
function physical(text:string):{start:number;end:number;text:string}[] {
  const lines:{start:number;end:number;text:string}[]=[];let start=0;
  while(start<text.length){const newline=text.indexOf("\n",start),end=newline<0?text.length:newline+1;lines.push({start,end,text:text.slice(start,end)});start=end;}
  if(lines.length>LIVING_SCRIPT_STRUCTURE_LIMITS.lines)editFail("The screenplay has too many physical lines.");return lines;
}
function ranges(input:LivingScriptPhysicalRange[],count:number):LivingScriptPhysicalRange[] {
  if(!Array.isArray(input)||input.length>LIVING_SCRIPT_STRUCTURE_LIMITS.locks)editFail("Use bounded protected screenplay ranges.");
  const result=input.map(range=>{exact(range,["startLine","endLine"]);integer(range.startLine,1,count,"protected range start");integer(range.endLine,range.startLine+1,count+1,"protected range end");return {...range};}).sort((a,b)=>a.startLine-b.startLine);
  for(let i=1;i<result.length;i++)if(result[i]!.startLine<result[i-1]!.endLine)editFail("Protected screenplay ranges must be disjoint.");return result;
}
function sealBase(input:{projectId:string;version:number;text:string;locks:LivingScriptPhysicalRange[]}):LivingScriptStructureBase {
  editId(input.projectId);integer(input.version,1,Number.MAX_SAFE_INTEGER,"screenplay version");script(input.text);
  const locks=ranges(input.locks,physical(input.text).length),scriptRevision=contentHash({scriptVersion:input.version,scriptText:input.text}),data={schema:"hv-living-script-structure-base/1" as const,projectId:input.projectId,version:input.version,text:input.text,locks,scriptRevision};
  return {...data,revision:contentHash(data)};
}
/** The caller must obtain current text and locks authoritatively. A seal grants no project authority. */
export function createLivingScriptStructureBase(input:{projectId:string;version:number;text:string;locks:LivingScriptPhysicalRange[]}):LivingScriptStructureBase {
  const copied=portable(input);exact(copied,["projectId","version","text","locks"]);return sealBase(copied);
}
function base(input:LivingScriptStructureBase):LivingScriptStructureBase {
  exact(input,["schema","projectId","version","text","locks","scriptRevision","revision"]);
  const expected=sealBase(input);if(contentHash(input)!==contentHash(expected))editFail("The structural screenplay base changed.");return expected;
}
function linesOf(input:LivingScriptStructureBase):LivingScriptStructureLine[] {
  return physical(input.text).map((line,index)=>({line:index+1,...line,id:contentHash({schema:"hv-living-script-physical-line/1",projectId:input.projectId,scriptRevision:input.scriptRevision,line:index+1,start:line.start,end:line.end})}));
}
export function livingScriptStructureLines(input:LivingScriptStructureBase):LivingScriptStructureLine[] {return linesOf(base(portable(input)));}
function blockOf(input:LivingScriptStructureBase,startLine:number,endLine:number):LivingScriptStructureBlock {
  const count=physical(input.text).length;integer(startLine,1,count,"block start");integer(endLine,startLine+1,count+1,"block end");
  return {startLine,endLine,id:contentHash({schema:"hv-living-script-physical-block/1",baseRevision:input.revision,startLine,endLine})};
}
export function livingScriptStructureBlock(input:LivingScriptStructureBase,startLine:number,endLine:number):LivingScriptStructureBlock {return blockOf(base(portable(input)),startLine,endLine);}
function boundaryOf(input:LivingScriptStructureBase,beforeLine:number):LivingScriptStructureBoundary {
  integer(beforeLine,1,physical(input.text).length+1,"block destination");return {beforeLine,id:contentHash({schema:"hv-living-script-physical-boundary/1",baseRevision:input.revision,beforeLine})};
}
export function livingScriptStructureBoundary(input:LivingScriptStructureBase,beforeLine:number):LivingScriptStructureBoundary {return boundaryOf(base(portable(input)),beforeLine);}

/** Protect complete comment/boneyard regions, including their delimiters, without parsing visible prose. */
function fountainRanges(lines:LivingScriptStructureLine[]):LivingScriptPhysicalRange[] {
  const found:LivingScriptPhysicalRange[]=[];let mode:"note"|"boneyard"|null=null,start=0;
  for(const line of lines){let at=0;while(at<line.text.length){
    if(mode){const close=mode==="note"?"]]":"*/",end=line.text.indexOf(close,at);if(end<0)break;found.push({startLine:start,endLine:line.line+1});mode=null;at=end+2;}
    else {const note=line.text.indexOf("[[",at),bone=line.text.indexOf("/*",at),next=note<0?bone:bone<0?note:Math.min(note,bone);if(next<0)break;mode=next===note?"note":"boneyard";start=line.line;at=next+2;}
  }}if(mode)found.push({startLine:start,endLine:lines.length+1});
  const union:LivingScriptPhysicalRange[]=[];for(const range of found){const last=union.at(-1);if(last&&range.startLine<last.endLine)last.endLine=Math.max(last.endLine,range.endLine);else union.push({...range});}return union;
}
const overlaps=(a:LivingScriptPhysicalRange,b:LivingScriptPhysicalRange)=>a.startLine<b.endLine&&b.startLine<a.endLine;
const inside=(range:LivingScriptPhysicalRange,boundary:number)=>range.startLine<boundary&&boundary<range.endLine;
const contains=(outer:LivingScriptPhysicalRange,inner:LivingScriptPhysicalRange)=>outer.startLine<=inner.startLine&&outer.endLine>=inner.endLine;

/** Operations address one immutable base. Equal-position insertions follow explicit request order.
 * The proposed version is before.version+1, not a global branch allocator or a committed revision. */
export function compileLivingScriptStructure(input:LivingScriptStructureBase,request:LivingScriptStructureRequest):LivingScriptStructurePatch {
  const copied=portable({input,request}),before=base(copied.input),asked=copied.request;exact(asked,["baseRevision","operations"]);hash(asked.baseRevision);
  if(asked.baseRevision!==before.revision)editFail("The screenplay or its locks changed. Resolve the stale structural proposal.");
  if(!Array.isArray(asked.operations)||!asked.operations.length||asked.operations.length>LIVING_SCRIPT_STRUCTURE_LIMITS.operations)editFail("Review one to 256 structural screenplay operations.");
  integer(before.version,1,Number.MAX_SAFE_INTEGER-1,"advanceable screenplay version");
  const old=linesOf(before),comments=fountainRanges(old),protectedRanges=[...before.locks,...comments],ids=new Set<string>();
  const removed=new Map<number,Exclude<LivingScriptStructureOperation,{kind:"insert"}>>(),destinations=new Map<number,LivingScriptStructureOperation[]>(),blocks:LivingScriptPhysicalRange[]=[];
  for(const operation of asked.operations){
    if(!operation||typeof operation!=="object"||!["delete","replace","move","insert"].includes(operation.kind))editFail("Use an explicit delete, replace, move or insert structural operation.");
    exact(operation,["id","kind",...(operation.kind==="insert"?["at","text"]:operation.kind==="replace"?["block","text"]:operation.kind==="move"?["block","to"]:["block"])]);
    editId(operation.id);if(ids.has(operation.id))editFail("Use distinct structural operation identities.");ids.add(operation.id);
    if(operation.kind!=="insert"){
      exact(operation.block,["startLine","endLine","id"]);const expected=blockOf(before,operation.block.startLine,operation.block.endLine);if(contentHash(expected)!==contentHash(operation.block))editFail("The structural block identity is stale or changed.");
      if(blocks.some(range=>overlaps(range,operation.block)))editFail("Structural source blocks overlap. Resolve the ambiguous edit.");blocks.push(operation.block);removed.set(operation.block.startLine,operation);
      for(const range of protectedRanges)if(overlaps(operation.block,range)&&(operation.kind!=="move"||!contains(operation.block,range)))editFail("Protected screenplay text can only move as a complete unchanged block.");
    }
    if(operation.kind==="replace"||operation.kind==="insert"){script(operation.text);if(!operation.text)editFail("Use delete for an empty replacement; inserted text must be nonempty.");physical(operation.text);}
    if(operation.kind==="move"||operation.kind==="insert"){
      const destination=operation.kind==="move"?operation.to:operation.at;exact(destination,["beforeLine","id"]);if(contentHash(boundaryOf(before,destination.beforeLine))!==contentHash(destination))editFail("The structural destination identity is stale or changed.");
      if(protectedRanges.some(range=>inside(range,destination.beforeLine)))editFail("Do not insert or move text inside a protected screenplay block.");
      if(operation.kind==="move"&&destination.beforeLine>=operation.block.startLine&&destination.beforeLine<=operation.block.endLine)editFail("Move the block to a distinct outside boundary.");
      destinations.set(destination.beforeLine,[...(destinations.get(destination.beforeLine)??[]),operation]);
    }
  }
  for(const boundary of destinations.keys())if(blocks.some(range=>inside(range,boundary)))editFail("A structural destination lies inside another edited block. Resolve the ambiguous edit.");
  type Piece={text:string;oldLine:number|null;operation:LivingScriptStructureOperation|null};const output:Piece[]=[];
  const fresh=(operation:Extract<LivingScriptStructureOperation,{kind:"replace"|"insert"}>)=>{for(const line of physical(operation.text))output.push({text:line.text,oldLine:null,operation});};
  for(let line=1;line<=old.length+1;){
    for(const operation of destinations.get(line)??[])if(operation.kind==="move")for(let n=operation.block.startLine;n<operation.block.endLine;n++)output.push({text:old[n-1]!.text,oldLine:n,operation});else if(operation.kind==="insert")fresh(operation);
    if(line===old.length+1)break;
    const operation=removed.get(line);if(operation){if(operation.kind==="replace")fresh(operation);line=operation.block.endLine;}else{output.push({text:old[line-1]!.text,oldLine:line,operation:null});line++;}
  }
  if(output.length>LIVING_SCRIPT_STRUCTURE_LIMITS.lines)editFail("The revised screenplay has too many physical lines.");
  if(output.slice(0,-1).some(line=>!line.text.endsWith("\n")))editFail("This edit would join unterminated physical lines. Review an explicit newline replacement first.");
  // Equal words can still have distinct physical ancestry (for example swapping repeated lines).
  const text=output.map(line=>line.text).join("");script(text);
  const positions=new Map<number,number>();output.forEach((piece,index)=>{if(piece.oldLine!==null){if(positions.has(piece.oldLine))editFail("An original line has ambiguous structural descendants.");positions.set(piece.oldLine,index+1);}});
  const locks=before.locks.map(range=>{const startLine=positions.get(range.startLine);if(startLine===undefined||Array.from({length:range.endLine-range.startLine},(_,offset)=>positions.get(range.startLine+offset)).some((position,offset)=>position!==startLine+offset))editFail("The structural edit changed a protected range.");return {startLine,endLine:startLine+range.endLine-range.startLine};});
  const after=sealBase({projectId:before.projectId,version:before.version+1,text,locks}),next=linesOf(after),afterComments=fountainRanges(next);
  const commentFlags=(ranges:LivingScriptPhysicalRange[],count:number)=>{const flags=new Uint8Array(count);for(const range of ranges)flags.fill(1,range.startLine-1,range.endLine-1);return flags;},oldFlags=commentFlags(comments,old.length),newFlags=commentFlags(afterComments,next.length),commentBoundaries=new Set(afterComments.map(range=>range.startLine+":"+range.endLine));
  for(const [oldLine,newLine]of positions)if(oldFlags[oldLine-1]!==newFlags[newLine-1])editFail("The structural edit changes surrounding comment or boneyard boundaries.");
  // A retained protected region must also keep its exact contiguous boundaries, not absorb new text.
  for(const range of comments){const startLine=positions.get(range.startLine)!,endLine=startLine+range.endLine-range.startLine;if(!commentBoundaries.has(startLine+":"+endLine))editFail("The structural edit changes a retained comment or boneyard region.");}
  const correspondence:LivingScriptStructureCorrespondence[]=old.map(line=>{
    const position=positions.get(line.line),source=position===undefined?asked.operations.find(op=>op.kind!=="insert"&&op.block.startLine<=line.line&&line.line<op.block.endLine):output[position-1]!.operation;
    return {beforeLine:line.line,beforeLineId:line.id,afterLine:position??null,afterLineId:position===undefined?null:next[position-1]!.id,treatment:position===undefined?source?.kind==="replace"?"replaced":"deleted":source?.kind==="move"?"moved":"preserved",operationId:source?.id??null};
  });
  const introduced=output.flatMap((piece,index)=>piece.oldLine===null?[{line:index+1,lineId:next[index]!.id,operationId:piece.operation!.id,kind:piece.operation!.kind as "insert"|"replace"}]:[]),pieces:LivingScriptStructureInversePiece[]=[];
  for(const row of correspondence){const previous=pieces.at(-1);if(row.afterLine!==null){if(previous?.kind==="retained"&&previous.endLine===row.afterLine)previous.endLine++;else pieces.push({kind:"retained",startLine:row.afterLine,endLine:row.afterLine+1});}
    else if(previous?.kind==="restore"&&previous.operationId===row.operationId)previous.text+=old[row.beforeLine-1]!.text;else pieces.push({kind:"restore",operationId:row.operationId!,text:old[row.beforeLine-1]!.text});
  }
  const inverse={beforeRevision:before.revision,afterRevision:after.revision,pieces,sha256:createHash("sha256").update(before.text,"utf8").digest("hex")};
  if(invert(after,inverse)!==before.text)editFail("The structural restoration proof lost original screenplay bytes.");
  const data={schema:"hv-living-script-structure/1" as const,before,after,request:asked,correspondence,introduced,inverse};return portable({...data,revision:contentHash(data)});
}
function invert(after:LivingScriptStructureBase,inverse:LivingScriptStructurePatch["inverse"]):string {
  if(inverse.afterRevision!==after.revision)editFail("The screenplay changed after the structural edit. Resolve restoration against the exact revision.");
  const lines=physical(after.text);return inverse.pieces.map(piece=>piece.kind==="restore"?piece.text:lines.slice(piece.startLine-1,piece.endLine-1).map(line=>line.text).join("")).join("");
}
export function validateLivingScriptStructure(input:LivingScriptStructurePatch):LivingScriptStructurePatch {
  const copied=portable(input);exact(copied,["schema","before","after","request","correspondence","introduced","inverse","revision"]);
  const expected=compileLivingScriptStructure(copied.before,copied.request);if(contentHash(expected)!==contentHash(copied))editFail("The structural screenplay patch, correspondence or restoration proof changed.");return expected;
}
/** Returns the historical base bytes/identity, not a newly committed version or permission to write. */
export function restoreLivingScriptStructure(input:LivingScriptStructurePatch,currentAfter:LivingScriptStructureBase):LivingScriptStructureBase {
  const copied=portable({input,currentAfter}),checked=validateLivingScriptStructure(copied.input),current=base(copied.currentAfter);
  if(current.revision!==checked.after.revision||invert(current,checked.inverse)!==checked.before.text)editFail("Restore only the exact reviewed structural screenplay result.");return structuredClone(checked.before);
}
/** Resolve a retained physical line through a contiguous reviewed ancestry; no text-search fallback.
 * Changed/replaced lines intentionally have no inferred descendant, even if replacement text matches. */
export function resolveLivingScriptStructureLine(input:LivingScriptStructurePatch[],identity:{projectId:string;scriptRevision:string;lineId:string}):LivingScriptStructureLine&{projectId:string;scriptRevision:string} {
  const copied=portable({input,identity});exact(copied.identity,["projectId","scriptRevision","lineId"]);editId(copied.identity.projectId);hash(copied.identity.scriptRevision);hash(copied.identity.lineId);
  if(!Array.isArray(copied.input)||!copied.input.length||copied.input.length>LIVING_SCRIPT_STRUCTURE_LIMITS.ancestry)editFail("Retain one to 32 complete structural ancestry patches.");
  const chain=copied.input.map(validateLivingScriptStructure),first=chain[0]!,last=chain.at(-1)!;
  if(first.before.projectId!==copied.identity.projectId||first.before.scriptRevision!==copied.identity.scriptRevision||!linesOf(first.before).some(line=>line.id===copied.identity.lineId))editFail("The retained line belongs to another or stale screenplay branch.");
  for(let i=1;i<chain.length;i++)if(chain[i]!.before.revision!==chain[i-1]!.after.revision)editFail("Resolve the structural ancestry gap or conflicting branch before editing this line.");
  let lineId=copied.identity.lineId;
  for(const patch of chain){const matches=patch.correspondence.filter(row=>row.beforeLineId===lineId);if(matches.length!==1)editFail("The retained line has ambiguous or missing structural ancestry.");const row=matches[0]!;
    if(row.afterLineId===null)editFail(row.treatment==="deleted"?"This retained line was deleted. Review an explicit new line instead.":"This retained line was replaced. Review its authored correspondence instead.");lineId=row.afterLineId;
  }
  const line=linesOf(last.after).find(value=>value.id===lineId);if(!line)editFail("The structural descendant is unavailable.");return {...line,projectId:last.after.projectId,scriptRevision:last.after.scriptRevision};
}
