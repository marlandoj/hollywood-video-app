import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {soundWav,inspectSoundWav,verifySoundWav} from "../../generator/src/sound-audio";
import {soundAssetKey,validateSoundLibrary} from "../../planner/src/sound-assets";
import {audioPcmHash} from "../../generator/src/audio-delivery";
test("owned sound import retains original stereo audio, rights, immutable copies and revocable use",async()=>{
  const root=mkdtempSync(join(tmpdir(),"hv-sound-assets-")),paths={statePath:join(root,"projects.json"),queuePath:join(root,"jobs.json"),costLedgerPath:join(root,"ledger.json"),artifactRoot:join(root,"media")},prior=process.env.HV_TOKEN_SECRET;process.env.HV_TOKEN_SECRET="sound-library-fixture-secret-at-least-thirty-two-characters";const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:1000,windowMs:60000}}});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  try{
    const owner=await(await call("/api/projects","POST")).json() as any,base="/api/projects/"+owner.projectId,path=base+"/sounds",pcm=Buffer.alloc(4800*6);for(let i=0;i<4800;i++){pcm.writeIntLE(Math.round(Math.sin(i*2*Math.PI/100)*1000000),i*6,3);pcm.writeIntLE(-Math.round(Math.sin(i*2*Math.PI/100)*500000),i*6+3,3);}const original=soundWav(pcm);
    const metadata={label:"Garden birds · test recording",expectedVersion:0,rights:{basis:"original",source:"Synthetic test tones",credit:"",terms:"Created solely for this closed test fixture.",attested:true}},upload=(data=original,record=metadata,token:string|undefined=owner.token)=>fetch(new URL(path,server.url),{method:"POST",headers:{"content-type":"audio/wav","x-hv-sound-record":encodeURIComponent(JSON.stringify(record)),...(token?{authorization:"Bearer "+token}:{})},body:new Uint8Array(data)});
    expect((await call(path)).status).toBe(401);expect((await upload(original,metadata,"")).status).toBe(401);expect((await upload()).status).toBe(400);
    await call(base+"/rights","POST",{attested:true},owner.token);expect((await upload(original,{...metadata,rights:{...metadata.rights,attested:false}})).status).toBe(400);expect((await upload(Buffer.from("invalid wav"))).status).toBe(400);
    const response=await upload();expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(201);const {asset,library}=await response.json() as any;
    expect(asset.original.sha256).toBe(audioPcmHash(original));expect(asset.original.channels).toBe(2);expect(asset.audio.frames).toBe(4800);expect(asset.rights.source).toBe("Synthetic test tones");expect(library.version).toBe(1);
    const saved=await(await call(path,"GET",undefined,owner.token)).json() as any;expect(validateSoundLibrary(saved.library,owner.projectId)).toEqual(library);
    const download=async(kind:string)=>call(path+"/"+asset.id+"/"+kind,"GET",undefined,owner.token),raw=await download("original");expect(raw.status).toBe(200);expect(Buffer.from(await raw.arrayBuffer()).equals(original)).toBe(true);
    const canonical=Buffer.from(await(await download("audio")).arrayBuffer());expect(verifySoundWav(canonical,4800,asset.audio.sha256)).toEqual(pcm);expect(inspectSoundWav(canonical).encoding).toBe("pcm_s24le");
    expect((await upload()).status).toBe(409);expect(new ProjectService(paths.statePath).snapshot().projects[0]!.soundLibrary).toEqual(library);
    const other=await(await call("/api/projects","POST")).json() as any;expect((await call(path+"/"+asset.id+"/audio","GET",undefined,other.token)).status).toBe(401);
    const disabled=await call(path+"/"+asset.id,"PUT",{expectedVersion:1,available:false},owner.token);expect(disabled.status).toBe(200);expect((await download("audio")).status).toBe(403);expect((await call(path+"/"+asset.id,"PUT",{expectedVersion:1,available:true},owner.token)).status).toBe(409);
    expect((await call(path+"/"+asset.id,"PUT",{expectedVersion:2,available:true},owner.token)).status).toBe(200);expect((await download("original")).status).toBe(200);
    const local=join(paths.artifactRoot,soundAssetKey(asset,"audio")),bytes=readFileSync(local);bytes[100]^=1;writeFileSync(local,bytes);expect((await download("audio")).status).toBe(400);
    const state=new ProjectService(paths.statePath).snapshot().projects[0]!.soundLibrary!;expect(state.assets).toHaveLength(1);expect(state.events.map(e=>e.available)).toEqual([true,false,true]);expect(state.assets[0]!.revision).toBe(asset.revision);
  }finally{await server.stop(true);rmSync(root,{recursive:true,force:true});if(prior===undefined)delete process.env.HV_TOKEN_SECRET;else process.env.HV_TOKEN_SECRET=prior;}
},30000);
