import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {contentHash} from "../../generator/src/capabilities";
import {
  createLivingScriptStructureBase,livingScriptStructureLines,livingScriptStructureBlock,livingScriptStructureBoundary,
  compileLivingScriptStructure,validateLivingScriptStructure,restoreLivingScriptStructure,resolveLivingScriptStructureLine,
  LIVING_SCRIPT_STRUCTURE_LIMITS as LIMITS,type LivingScriptStructureBase,type LivingScriptStructureOperation,
  type LivingScriptStructurePatch,type LivingScriptStructureRequest,type LivingScriptPhysicalRange,
} from "../src/living-script-structure";

const make=(text:string,locks:LivingScriptPhysicalRange[]=[],version=1)=>createLivingScriptStructureBase({projectId:"structure-project",version,text,locks});
const request=(base:LivingScriptStructureBase,operations:LivingScriptStructureOperation[]):LivingScriptStructureRequest=>({baseRevision:base.revision,operations});
const compile=(base:LivingScriptStructureBase,operations:LivingScriptStructureOperation[])=>compileLivingScriptStructure(base,request(base,operations));
const block=livingScriptStructureBlock,boundary=livingScriptStructureBoundary;
const identity=(base:LivingScriptStructureBase,line:number)=>({projectId:base.projectId,scriptRevision:base.scriptRevision,lineId:livingScriptStructureLines(base)[line-1]!.id});
const reseal=(patch:LivingScriptStructurePatch)=>{const {revision:_revision,...data}=patch;return {...data,revision:contentHash(data)};};

test("complete scene moves preserve CRLF, Unicode, comments, boneyard and inherited owner locks byte-for-byte",()=>{
  const text="Title: Café 🌿\r\n\r\n.INT. A - DAY\r\n[[Keep A.]]\r\nA waits.\r\n\r\n.EXT. B - NIGHT\r\n/*\r\nKeep B.\r\n*/\r\nB walks.\r\n",base=make(text,[{startLine:5,endLine:6}],41);
  const operations:LivingScriptStructureOperation[]=[{id:"move-a",kind:"move",block:block(base,3,7),to:boundary(base,12)}],beforeHash=contentHash({base,operations}),patch=compile(base,operations);
  expect(patch.after.text).toBe("Title: Café 🌿\r\n\r\n.EXT. B - NIGHT\r\n/*\r\nKeep B.\r\n*/\r\nB walks.\r\n.INT. A - DAY\r\n[[Keep A.]]\r\nA waits.\r\n\r\n");
  expect(patch.before.version).toBe(41);expect(patch.after.version).toBe(42);expect(patch.after.locks).toEqual([{startLine:10,endLine:11}]);
  expect(patch.correspondence[4]).toMatchObject({beforeLine:5,afterLine:10,treatment:"moved",operationId:"move-a"});
  for(const row of patch.correspondence){const old=livingScriptStructureLines(base)[row.beforeLine-1]!,next=livingScriptStructureLines(patch.after)[row.afterLine!-1]!;expect(Buffer.from(next.text)).toEqual(Buffer.from(old.text));}
  expect(resolveLivingScriptStructureLine([patch],identity(base,5))).toMatchObject({line:10,text:"A waits.\r\n",scriptRevision:patch.after.scriptRevision});
  expect(patch.inverse.sha256).toBe(createHash("sha256").update(text).digest("hex"));expect(restoreLivingScriptStructure(patch,patch.after)).toEqual(base);
  expect(contentHash({base,operations})).toBe(beforeHash);expect(validateLivingScriptStructure(JSON.parse(JSON.stringify(patch)))).toEqual(patch);
});

test("mixed delete, move, replace and insert compile against fixed original coordinates and restore independent expected bytes",()=>{
  const base=make("INT. ROOM\n\nOLD\nSame.\n\nKEEP\nSame.\nEND\n"),patch=compile(base,[
    {id:"replace",kind:"replace",block:block(base,3,5),text:"NEW\nChanged.\n"},
    {id:"gap",kind:"delete",block:block(base,5,6)},
    {id:"tail",kind:"insert",at:boundary(base,9),text:"Tail 🌿\n"},
    {id:"move",kind:"move",block:block(base,6,8),to:boundary(base,1)},
  ]);
  expect(patch.after.text).toBe("KEEP\nSame.\nINT. ROOM\n\nNEW\nChanged.\nEND\nTail 🌿\n");
  expect(patch.correspondence.map(row=>row.afterLine)).toEqual([3,4,null,null,null,1,2,7]);
  expect(patch.correspondence.map(row=>row.treatment)).toEqual(["preserved","preserved","replaced","replaced","deleted","moved","moved","preserved"]);
  expect(patch.introduced.map(row=>[row.line,row.operationId,row.kind])).toEqual([[5,"replace","replace"],[6,"replace","replace"],[8,"tail","insert"]]);
  const afterLines=patch.after.text.match(/[^\n]*\n|[^\n]+$/g)!;
  const restored=patch.inverse.pieces.map(piece=>piece.kind==="restore"?piece.text:afterLines.slice(piece.startLine-1,piece.endLine-1).join("")).join("");
  expect(restored).toBe("INT. ROOM\n\nOLD\nSame.\n\nKEEP\nSame.\nEND\n");expect(restoreLivingScriptStructure(patch,patch.after).text).toBe(restored);
  expect(()=>resolveLivingScriptStructureLine([patch],identity(base,3))).toThrow(/replaced/);
  expect(()=>resolveLivingScriptStructureLine([patch],identity(base,5))).toThrow(/deleted/);
  expect(resolveLivingScriptStructureLine([patch],identity(base,7)).line).toBe(2);
});

test("equal repeated text retains distinct identities through moves, and replacement does not inherit identity by words",()=>{
  const base=make("Again.\nAgain.\n"),lines=livingScriptStructureLines(base);expect(lines[0]!.id).not.toBe(lines[1]!.id);
  const patch=compile(base,[{id:"swap-a",kind:"move",block:block(base,1,2),to:boundary(base,3)},{id:"swap-b",kind:"move",block:block(base,2,3),to:boundary(base,1)}]);
  expect(patch.after.text).toBe(base.text);expect(patch.after.revision).not.toBe(base.revision);
  expect(resolveLivingScriptStructureLine([patch],identity(base,1)).line).toBe(2);expect(resolveLivingScriptStructureLine([patch],identity(base,2)).line).toBe(1);
  const replaced=compile(base,[{id:"replace-identical",kind:"replace",block:block(base,1,2),text:"Again.\n"}]);
  expect(replaced.after.text).toBe(base.text);expect(replaced.introduced).toHaveLength(1);
  expect(()=>resolveLivingScriptStructureLine([replaced],identity(base,1))).toThrow(/replaced/);
  expect(resolveLivingScriptStructureLine([replaced],identity(base,2)).line).toBe(2);
});

test("same-boundary insertions follow request order without trimming whitespace or normalizing mixed endings",()=>{
  const base=make("  🌿\r\nZ"),patch=compile(base,[{id:"a",kind:"insert",at:boundary(base,2),text:" A \n"},{id:"b",kind:"insert",at:boundary(base,2),text:"\tB\r\n"}]);
  expect(patch.after.text).toBe("  🌿\r\n A \n\tB\r\nZ");expect(livingScriptStructureLines(base)).toMatchObject([{line:1,start:0,end:6},{line:2,start:6,end:7}]);
  expect(restoreLivingScriptStructure(patch,patch.after)).toEqual(base);
  expect(livingScriptStructureLines(make("A\n"))).toHaveLength(1);expect(livingScriptStructureLines(make(""))).toHaveLength(0);
  expect(compile(make(""),[{id:"initial",kind:"insert",at:boundary(make(""),1),text:"INT. ROOM\n"}]).after.text).toBe("INT. ROOM\n");
  const all=compile(base,[{id:"all",kind:"delete",block:block(base,1,3)}]);expect(all.after.text).toBe("");expect(restoreLivingScriptStructure(all,all.after)).toEqual(base);
});

test("protected owner blocks and complete Fountain regions cannot be removed, replaced, split or spliced",()=>{
  const base=make("First\n/*\nHidden\n*/\nLocked A\nLocked B\nLast\n",[{startLine:5,endLine:7}]);
  for(const operation of [
    {id:"delete",kind:"delete",block:block(base,2,5)},
    {id:"replace",kind:"replace",block:block(base,5,7),text:"Changed\n"},
    {id:"split-comment",kind:"move",block:block(base,3,4),to:boundary(base,1)},
    {id:"split-lock",kind:"move",block:block(base,5,6),to:boundary(base,1)},
    {id:"inside-comment",kind:"insert",at:boundary(base,3),text:"New\n"},
    {id:"inside-lock",kind:"insert",at:boundary(base,6),text:"New\n"},
  ] as LivingScriptStructureOperation[])expect(()=>compile(base,[operation])).toThrow(/protected/i);
  const moved=compile(base,[{id:"lock",kind:"move",block:block(base,5,7),to:boundary(base,1)}]);expect(moved.after.locks).toEqual([{startLine:1,endLine:3}]);
  const note=make("A\n[[\nKeep\n]]\nB\n");expect(()=>compile(note,[{id:"note",kind:"delete",block:block(note,3,4)}])).toThrow(/protected/i);
});

test("moving or inserting comment delimiters cannot change the protection of untouched physical lines",()=>{
  const base=make("Visible\n/*\nHidden\n");
  expect(()=>compile(base,[{id:"move-open",kind:"move",block:block(base,2,4),to:boundary(base,1)}])).toThrow(/comment|boneyard/);
  const plain=make("A\nB\n");expect(()=>compile(plain,[{id:"open",kind:"insert",at:boundary(plain,2),text:"[[\n"}])).toThrow(/comment|boneyard/);
  const adjacent=make("A\n[[Old]]\nB\n"),patch=compile(adjacent,[{id:"new-note",kind:"insert",at:boundary(adjacent,2),text:"[[New]]\n"}]);
  expect(patch.after.text).toBe("A\n[[New]]\n[[Old]]\nB\n");expect(restoreLivingScriptStructure(patch,patch.after)).toEqual(adjacent);
});

test("ambiguous overlaps, interior destinations, stale identities and duplicate operations reject explicitly",()=>{
  const base=make("A\nB\nC\nD\n"),del:LivingScriptStructureOperation={id:"delete",kind:"delete",block:block(base,2,4)};
  expect(()=>compile(base,[del,{id:"replace",kind:"replace",block:block(base,3,5),text:"R\n"}])).toThrow(/overlap|ambiguous/);
  expect(()=>compile(base,[del,{id:"inside",kind:"insert",at:boundary(base,3),text:"R\n"}])).toThrow(/ambiguous/);
  expect(()=>compile(base,[del,{...del}])).toThrow(/distinct/);
  expect(()=>compile(base,[{id:"noop",kind:"move",block:block(base,2,4),to:boundary(base,4)}])).toThrow(/outside/);
  const stale=make(base.text,[],2);expect(()=>compileLivingScriptStructure(stale,request(base,[del]))).toThrow(/stale/);
  expect(()=>compile(stale,[del])).toThrow(/identity/);
  expect(()=>compile(base,[{id:"stale-dest",kind:"insert",at:boundary(stale,1),text:"X\n"}])).toThrow(/identity/);
  expect(()=>compileLivingScriptStructure(make(base.text,[{startLine:4,endLine:5}]),request(base,[del]))).toThrow(/locks|stale/);
});

test("nonterminal fragments reject line merging rather than inventing or changing newline bytes",()=>{
  const base=make("A\nLast");
  expect(()=>compile(base,[{id:"last-first",kind:"move",block:block(base,2,3),to:boundary(base,1)}])).toThrow(/unterminated/);
  expect(()=>compile(base,[{id:"insert-fragment",kind:"insert",at:boundary(base,2),text:"X"}])).toThrow(/unterminated/);
  expect(()=>compile(base,[{id:"append",kind:"insert",at:boundary(base,3),text:"X\n"}])).toThrow(/unterminated/);
  const closed=make("A\nB\n"),patch=compile(closed,[{id:"terminal",kind:"replace",block:block(closed,2,3),text:"Last"}]);expect(patch.after.text).toBe("A\nLast");expect(restoreLivingScriptStructure(patch,patch.after)).toEqual(closed);
});

test("composed ancestry validates each complete revision and resolves moved lines without assuming version array positions",()=>{
  const base=make("A\nB\nC\n",[],107),first=compile(base,[{id:"move",kind:"move",block:block(base,3,4),to:boundary(base,1)}]);
  const second=compile(first.after,[{id:"prefix",kind:"insert",at:boundary(first.after,1),text:"NEW\n"}]);
  expect(second.after.version).toBe(109);expect(resolveLivingScriptStructureLine([first,second],identity(base,3))).toMatchObject({line:2,text:"C\n",scriptRevision:second.after.scriptRevision});
  const fork=compile(base,[{id:"fork",kind:"delete",block:block(base,1,2)}]);expect(()=>resolveLivingScriptStructureLine([first,fork],identity(base,3))).toThrow(/ancestry|branch/);
  expect(()=>resolveLivingScriptStructureLine([first],{...identity(base,3),projectId:"foreign"})).toThrow(/branch/);
  expect(()=>resolveLivingScriptStructureLine([second],identity(base,3))).toThrow(/branch/);
  expect(()=>resolveLivingScriptStructureLine([first],{...identity(base,3),lineId:"a".repeat(64)})).toThrow(/branch/);
  const removed=compile(first.after,[{id:"delete",kind:"delete",block:block(first.after,1,2)}]);expect(()=>resolveLivingScriptStructureLine([first,removed],identity(base,3))).toThrow(/deleted/);
  expect(()=>restoreLivingScriptStructure(first,second.after)).toThrow(/exact|changed/);
  const alteredLocks=make(first.after.text,[{startLine:1,endLine:2}],first.after.version);expect(()=>restoreLivingScriptStructure(first,alteredLocks)).toThrow(/exact|changed/);
});

test("resealing altered ancestry, after bytes, locks or inverse ranges never legitimizes tampering",()=>{
  const base=make("A\nB\nC\n"),patch=compile(base,[{id:"replace",kind:"replace",block:block(base,2,3),text:"NEW\n"}]);
  const changes:((value:LivingScriptStructurePatch)=>void)[]=[
    value=>{value.correspondence[0]!.afterLine=2;},
    value=>{value.correspondence[1]!.afterLineId=value.introduced[0]!.lineId;value.correspondence[1]!.afterLine=2;value.correspondence[1]!.treatment="preserved";},
    value=>{value.after=make("FORGED\n",[],2);},
    value=>{value.after=make(value.after.text,[{startLine:1,endLine:2}],2);},
    value=>{value.introduced[0]!.operationId="foreign";},
    value=>{const piece=value.inverse.pieces.find(piece=>piece.kind==="retained")!;if(piece.kind==="retained")piece.endLine=200;},
    value=>{const piece=value.inverse.pieces.find(piece=>piece.kind==="restore")!;if(piece.kind==="restore")piece.text="FORGED\n";},
    value=>{value.inverse.afterRevision="a".repeat(64);},
  ];
  for(const change of changes){const forged=structuredClone(patch);change(forged);const sealed=reseal(forged);expect(()=>validateLivingScriptStructure(sealed)).toThrow();expect(()=>restoreLivingScriptStructure(sealed,patch.after)).toThrow();expect(()=>resolveLivingScriptStructureLine([sealed],identity(base,1))).toThrow();}
});

test("strict portable inputs reject accessors without invoking them, custom prototypes, sparse arrays and hidden metadata",()=>{
  const base=make("A\nB\n"),valid=request(base,[{id:"del",kind:"delete",block:block(base,1,2)}]);let invoked=0;
  const accessor=Object.defineProperty({...valid},"operations",{enumerable:true,get(){invoked++;return valid.operations;}});
  expect(()=>compileLivingScriptStructure(base,accessor)).toThrow(/enumerable|plain/);expect(invoked).toBe(0);
  const symbol={...valid,[Symbol("hidden")]:1};expect(()=>compileLivingScriptStructure(base,symbol)).toThrow();
  const hidden=Object.defineProperty({...valid},"hidden",{value:1});expect(()=>compileLivingScriptStructure(base,hidden)).toThrow();
  const custom=Object.assign(Object.create({}),valid);expect(()=>compileLivingScriptStructure(base,custom)).toThrow();
  const sparseOperations:LivingScriptStructureOperation[]=[];sparseOperations.length=1;
  const sparse={...valid,operations:sparseOperations};expect(()=>compileLivingScriptStructure(base,sparse)).toThrow(/dense/);
  const extra=structuredClone(valid);Object.assign(extra.operations,{extra:true});expect(()=>compileLivingScriptStructure(base,extra)).toThrow();
  const cycle={...valid};Object.assign(cycle,{cycle});expect(()=>compileLivingScriptStructure(base,cycle)).toThrow();
  for(const value of [undefined,NaN,Infinity,-0,()=>1,new Date()])expect(()=>compileLivingScriptStructure(base,{...valid,unexpected:value} as LivingScriptStructureRequest)).toThrow();
  const unexpected=structuredClone(valid);Object.assign(unexpected.operations[0]!,{unexpected:true});expect(()=>compileLivingScriptStructure(base,unexpected)).toThrow(/exact/);
});

test("bounds reject invalid physical ranges, overflowing versions, too many operations and metadata without truncation",()=>{
  for(const locks of [[{startLine:0,endLine:2}],[{startLine:1,endLine:1}],[{startLine:1,endLine:4}],[{startLine:1,endLine:3},{startLine:2,endLine:3}],[{startLine:1.5,endLine:3}]])expect(()=>make("A\nB\n",locks)).toThrow();
  expect(()=>make("A\n",[],Number.MAX_SAFE_INTEGER+1)).toThrow();
  const max=make("A\n",[],Number.MAX_SAFE_INTEGER);expect(()=>compile(max,[{id:"del",kind:"delete",block:block(max,1,2)}])).toThrow(/version/);
  for(const text of ["x".repeat(LIMITS.characters+1),"\n".repeat(LIMITS.lines+1),"A\rB","A\u0000B","\ud800"])expect(()=>make(text)).toThrow();
  expect(()=>make("A\n".repeat(2050),Array.from({length:LIMITS.locks+1},(_,i)=>({startLine:i+1,endLine:i+2})))).toThrow(/protected/);
  const base=make("A\n"),op:LivingScriptStructureOperation={id:"new",kind:"insert",at:boundary(base,1),text:"X\n"};
  expect(()=>compile(base,Array.from({length:LIMITS.operations+1},(_,i)=>({...op,id:"insert-"+i})))).toThrow(/256/);
  expect(()=>livingScriptStructureBlock(base,1,3)).toThrow();expect(()=>livingScriptStructureBoundary(base,0)).toThrow();
  expect(()=>compile(base,[{...op,text:"x".repeat(LIMITS.characters)}])).toThrow();
  expect(()=>compileLivingScriptStructure(base,{...request(base,[op]),extra:"x".repeat(LIMITS.metadataBytes+1)} as LivingScriptStructureRequest)).toThrow(/capacity/);
  const patch=compile(base,[{id:"del",kind:"delete",block:block(base,1,2)}]);expect(()=>resolveLivingScriptStructureLine(Array.from({length:LIMITS.ancestry+1},()=>patch),identity(base,1))).toThrow(/32/);
});
