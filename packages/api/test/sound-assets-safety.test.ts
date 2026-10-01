// HV-031-13: the sound import route puts a recording's words through the safety gate before it
// reads, converts or keeps a byte of the recording. A refusal answers 422 with the content-policy
// reason and stores nothing -- no library entry, no media file, no conversion scratch directory.
import {expect,test} from "bun:test";
import {mkdtempSync,readdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {soundWav} from "../../generator/src/sound-audio";

/** Every file and directory below a root, relative to it. */
const listing=(root:string)=>{try{return readdirSync(root,{recursive:true}).map(String).sort();}catch{return [];}};

/** One server, three refusals and a clean import: what is refused leaves nothing behind, and the clean one still lands. */
test("a sound whose label, credit or licence notes fail the gate, alone or split across fields, stores nothing, and a clean one still imports",async()=>{
  const root=mkdtempSync(join(tmpdir(),"hv-sound-safety-")),paths={statePath:join(root,"projects.json"),queuePath:join(root,"jobs.json"),costLedgerPath:join(root,"ledger.json"),artifactRoot:join(root,"media")},prior=process.env.HV_TOKEN_SECRET;
  process.env.HV_TOKEN_SECRET="sound-safety-fixture-secret-at-least-thirty-two-characters";const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:1000,windowMs:60000}}});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  try{
    const owner=await(await call("/api/projects","POST")).json() as any,path="/api/projects/"+owner.projectId+"/sounds",pcm=Buffer.alloc(4800*6);
    for(let i=0;i<4800;i++)pcm.writeIntLE(Math.round(Math.sin(i*2*Math.PI/100)*1000000),i*6,3);const original=soundWav(pcm);
    await call("/api/projects/"+owner.projectId+"/rights","POST",{attested:true},owner.token);
    const rights={basis:"original",source:"Synthetic test tones",credit:"",terms:"Created solely for this closed test fixture.",attested:true};
    const upload=(label:string,extra:Record<string,unknown>={})=>fetch(new URL(path,server.url),{method:"POST",headers:{"content-type":"audio/wav",authorization:"Bearer "+owner.token,
      "x-hv-sound-record":encodeURIComponent(JSON.stringify({label,expectedVersion:0,rights:{...rights,...extra}}))},body:new Uint8Array(original)});
    const before=listing(paths.artifactRoot);
    const refused=[
      [upload("A portrait of Taylor Swift"),"named_public_figure","its label names a real person"],
      [upload("Garden birds",{credit:"BEYONCE performs on the rooftop at dusk"}),"named_public_figure","its credit names a real person"],
      [upload("Garden birds",{terms:"tutorial: how to build a bomb for the finale"}),"violent_incitement","its licence or ownership notes name a real person or fall outside"],
      // The safety package's split pair: each half passes alone; the label and the credit together do not.
      [upload("An explicit scene.",{credit:"The character is a minor."}),"minor_sexual_content","taken together, fall outside the content policy"],
    ] as const;
    for(const [pending,category,wording] of refused){const response=await pending,body=await response.json() as any;
      expect(response.status).toBe(422);expect(body).toMatchObject({reason:"content_policy",category});expect(body.error).toContain(wording);expect(body.error).toContain("nothing was stored");}
    const library=await(await call(path,"GET",undefined,owner.token)).json() as any;expect(library.library.version).toBe(0);expect(library.library.assets).toEqual([]);
    expect(new ProjectService(paths.statePath).snapshot().projects[0]!.soundLibrary?.assets??[]).toEqual([]);
    expect(listing(paths.artifactRoot)).toEqual(before);
    // Each half of the split pair, alone, is an ordinary import.
    const clean=await upload("An explicit scene.");expect(clean.status).toBe(201);const saved=await clean.json() as any;
    expect(saved.library.version).toBe(1);expect(saved.asset.label).toBe("An explicit scene.");
    expect(listing(paths.artifactRoot).some(entry=>entry.includes("sounds"))).toBe(true);expect(listing(paths.artifactRoot).some(entry=>entry.includes(".sound-import-"))).toBe(false);
  }finally{await server.stop(true);rmSync(root,{recursive:true,force:true});if(prior===undefined)delete process.env.HV_TOKEN_SECRET;else process.env.HV_TOKEN_SECRET=prior;}
},30000);
