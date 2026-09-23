import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import {SCENE, pdfFixture} from "../../parser/test/pdf-fixture";

const root=mkdtempSync(join(tmpdir(),"hv-script-import-"));
process.env.HV_TOKEN_SECRET="script-import-api-fixture-secret-with-thirty-two-characters";
const server=createApiServer({port:0,hostname:"127.0.0.1",queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),
  artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json"),rateLimit:{api:{limit:1000,windowMs:60000}}});
afterAll(async()=>{await server.stop(true);rmSync(root,{recursive:true,force:true});});
const LIGHTHOUSE=readFileSync(new URL("../../parser/test/fixtures/lighthouse.fdx",import.meta.url),"utf8");
const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,
  headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});

test("a Final Draft script is converted and shown back to the writer, and nothing is saved until they save it",async()=>{
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId;
  const imported=await call(base+"/script/import","POST",{format:"final-draft",document:LIGHTHOUSE},owner.token);
  expect(imported.status).toBe(200);
  const result=await imported.json() as {text:string;notes:{code:string;message:string}[];scenes:number;warnings:unknown[]};
  expect(result.scenes).toBe(2);
  expect(result.text).toContain("INT. LIGHTHOUSE - NIGHT");
  expect(result.text).toContain("MARGUERITE");
  expect(result.notes.map(note=>note.code)).toContain("parentheticals");

  // The import route commits nothing: the writer's own save is still the project's first version.
  const saved=await call(base+"/script","PUT",{text:result.text},owner.token);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({version:1,scenes:2});
  // Importing again after a save still writes nothing. What proves it is the writer's *next* save:
  // saving the same text again changes nothing and stays at version 1 (HV-016-10 -- a save that
  // changes nothing is not a revision), and saving a changed script is version 2. If the import
  // route had committed, the version would have moved without the writer saving at all.
  expect((await call(base+"/script/import","POST",{format:"final-draft",document:LIGHTHOUSE},owner.token)).status).toBe(200);
  expect(await(await call(base+"/script","PUT",{text:result.text},owner.token)).json()).toMatchObject({version:1});
  const second=await call(base+"/script","PUT",{text:result.text+"\n\nShe leaves."},owner.token);
  expect(await second.json()).toMatchObject({version:2});
});

test("the import route is the owner's, takes a format it supports, and refuses what it cannot carry across",async()=>{
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId;
  const post=(body:unknown,token=owner.token)=>call(base+"/script/import","POST",body,token);
  expect((await call(base+"/script/import","POST",{format:"final-draft",document:LIGHTHOUSE})).status).toBe(401);
  const other=await(await call("/api/projects","POST")).json() as {token:string};
  expect((await post({format:"final-draft",document:LIGHTHOUSE},other.token)).status).toBe(401);
  expect((await post({format:"celtx",document:LIGHTHOUSE})).status).toBe(400);
  const refused=await post({format:"final-draft",document:'<FinalDraft DocumentType="Script"><Content><Paragraph Type="Action"><Text>A room.</Text></Paragraph></Content></FinalDraft>'});
  expect(refused.status).toBe(400);
  expect((await refused.json() as {error:string}).error).toContain("no scene headings");
  const entity=await post({format:"final-draft",document:'<!DOCTYPE FinalDraft SYSTEM "http://example.invalid/x.dtd">\n<FinalDraft DocumentType="Script"><Content></Content></FinalDraft>'});
  expect(entity.status).toBe(400);
  expect((await entity.json() as {error:string}).error).toContain("document type or entity declaration");
});

test("and a PDF screenplay is read the same way: shown back, never saved, and refused by name when it cannot be read",async()=>{
  // HV-016-08. A PDF is bytes, so it arrives base64 in the same JSON body under the same limit.
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId;
  const post=(body:unknown,token=owner.token)=>call(base+"/script/import","POST",body,token);
  const base64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes));
  const imported=await post({format:"pdf",document:base64(pdfFixture({deflate:true,pages:[{lines:SCENE}]}))});
  expect(imported.status).toBe(200);
  const result=await imported.json() as {text:string;notes:{code:string}[];scenes:number};
  expect(result.scenes).toBe(2);
  expect(result.text).toContain("INT. LIGHTHOUSE - NIGHT");
  expect(result.text).toContain("MARGUERITE");
  expect(result.notes.map(note=>note.code)).toContain("parentheticals");
  // Nothing was saved, exactly as for a Final Draft import: the writer's own save is version 1.
  expect(await(await call(base+"/script","PUT",{text:result.text},owner.token)).json()).toMatchObject({version:1,scenes:2});

  // A scan has no text layer, and is told so rather than imported as an empty screenplay.
  const scan=await post({format:"pdf",document:base64(pdfFixture({pages:[{lines:[]}]}))});
  expect(scan.status).toBe(400);
  expect((await scan.json() as {error:string}).error).toContain("no text layer");
  // And what is not a PDF at all, or not base64 at all, is refused before the importer sees it.
  expect((await post({format:"pdf",document:base64(new TextEncoder().encode("not a pdf"))})).status).toBe(400);
  const notBase64=await post({format:"pdf",document:"%PDF-1.4 not base64!!"});
  expect(notBase64.status).toBe(400);
  expect((await notBase64.json() as {error:string}).error).toContain("could not be read");
  expect((await post({format:"pdf",document:""})).status).toBe(400);
  // The route is still the owner's.
  expect((await call(base+"/script/import","POST",{format:"pdf",document:base64(pdfFixture({pages:[{lines:SCENE}]}))})).status).toBe(401);
});
