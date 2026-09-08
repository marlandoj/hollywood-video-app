import {previewRequests} from '../../planner/src/edit-preview-render';
import {editCompositeNeeded} from '../../planner/src/edit-composite';
import {composePreviewFrame} from './preview-composition.js';
import {fetchPreviewPacket} from './preview-fetch.js';

export const previewStopped=()=>new Error('Preview stopped.');
export async function previewWaiting(promise,signal){signal.throwIfAborted();let abort=()=>{};try{return await Promise.race([promise,new Promise((_,reject)=>{abort=()=>reject(signal.reason??previewStopped());signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener('abort',abort);}}
const delay=(ms,signal)=>{let timer;return previewWaiting(new Promise(resolve=>{timer=setTimeout(resolve,ms);}),signal).finally(()=>clearTimeout(timer));};
const pageAt=frame=>Math.floor(frame/60)*60,windowAt=frame=>Math.floor(frame/300)*300;
export function previewIdentity(current,client){if(!current)return null;const version=Boolean(current.jobId),targetId=version?current.jobId:current.sequence.id,historyRevision=current.sequence.history.revision,outputRevision=version?current.outputRevision:undefined;return {key:JSON.stringify([version,targetId,historyRevision,outputRevision]),targetId,historyRevision,outputRevision,client,base:'/'+(version?'versions':'sequences')+'/'+encodeURIComponent(targetId)+'/preview'};}
const query=identity=>'historyRevision='+encodeURIComponent(identity.historyRevision)+(identity.outputRevision?'&outputRevision='+encodeURIComponent(identity.outputRevision):'');

/** One source track: two leases and bounded media, driven by an external transport. */
export class PreviewMedia {
  #options;#timeline=null;#identity=null;#windows=new Map();#admission=Promise.resolve();#encoded=new Map();#bytes=0;#images=new Map();#frames=new Map();#composition;#release=Promise.resolve();#renewing=false;
  constructor(options){this.#options=options;this.#composition=document.createElement('canvas');}
  get stats(){return {windows:this.#windows.size,packets:this.#encoded.size,encodedBytes:this.#bytes,images:this.#images.size,composedFrames:this.#frames.size};}
  bind(timeline,identity){this.clear();this.#timeline=timeline;this.#identity=identity;}
  #valid(run){this.#options.check(run);}
  #frame(frame){return Math.min(this.#timeline.frames-1,frame);}
  #current(run){return this.#frame(Math.floor(run.at/1600));}
  resetFrames(){for(const bitmap of this.#frames.values())bitmap.close();this.#frames.clear();}
  frame(frame){return this.#frames.get(this.#frame(frame));}
  async #json(path,init={},signal,client=this.#identity.client){const active=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(30000)]);return previewWaiting(client.request(path,{...init,signal:active}),active);}
  #discardWindow(window){if(this.#windows.get(window.from)===window)this.#windows.delete(window.from);window.controller.abort(previewStopped());if(!window.started)return;
    this.#release=this.#release.catch(()=>{}).then(()=>this.#json(window.path+'?'+query(window.identity),{method:'DELETE'},undefined,window.identity.client)).catch(()=>{});
  }
  async #window(run,frame,ready=true){this.#valid(run);const from=windowAt(frame);let window=this.#windows.get(from);
    if(!window){const previous=this.#admission;let unlock;this.#admission=new Promise(resolve=>{unlock=resolve;});await previous;try{this.#valid(run);window=this.#windows.get(from);if(window)return ready?previewWaiting(window.promise,run.controller.signal):window;
      if(this.#windows.size>=2){const old=[...this.#windows.values()].find(w=>w.from!==windowAt(this.#current(run)));this.#discardWindow(old??this.#windows.values().next().value);}await this.#release;this.#valid(run);
      const identity={...this.#identity},timeline=this.#timeline,id=crypto.randomUUID(),controller=new AbortController();window={id,identity,from,frames:Math.min(300,timeline.frames-from),path:identity.base+'/'+id,controller,started:true,status:null,requests:null,promise:null};this.#windows.set(from,window);const own=window;
      own.promise=(async()=>{let status=await this.#json(identity.base,{method:'POST',body:{id,historyRevision:identity.historyRevision,...(identity.outputRevision?{outputRevision:identity.outputRevision}:{}),from,frames:own.frames}},controller.signal,identity.client);
        while(status.state!=='ready'){if(status.state==='failed')throw new Error(status.error||'A preview original could not be prepared.');if(this.#options.active()===run&&windowAt(this.#current(run))===from)this.#options.preparing(status.completedSources,status.totalSources);await delay(1500,controller.signal);status=await this.#json(own.path+'?'+query(identity),{},controller.signal,identity.client);}
        if(status.historyRevision!==identity.historyRevision||status.outputRevision!==identity.outputRevision||status.timelineRevision!==timeline.revision||status.from!==from||status.frames!==own.frames||!status.audio||editCompositeNeeded(timeline)&&(!status.picture||status.picture.picturePurpose!=='timeline-composite'||status.picture.pictureEncoding!=='png-rgba'))throw new Error('The saved preview identity changed. Reopen the cut.');own.status=status;own.requests=previewRequests(timeline,from,own.frames);return own;
      })();void own.promise.catch(()=>{});
    }finally{unlock();}}
    return ready?previewWaiting(window.promise,run.controller.signal):window;
  }
  async renew(run){if(this.#renewing)return;this.#renewing=true;try{for(const window of this.#windows.values()){if(!window.status)continue;try{const status=await this.#json(window.path+'?'+query(window.identity),{},window.controller.signal,window.identity.client);this.#valid(run);if(status.state!=='ready'||status.historyRevision!==window.identity.historyRevision||status.outputRevision!==window.identity.outputRevision||status.timelineRevision!==this.#timeline.revision||status.audio?.sourceKey!==window.status.audio.sourceKey||status.picture?.sourceKey!==window.status.picture?.sourceKey)throw new Error(status.error||'The saved cut or original permission changed. Reopen its preview.');}catch(error){if(window.controller.signal.aborted&&this.#windows.get(window.from)!==window)continue;throw error;}}}finally{this.#renewing=false;}}
  async #packet(run,window,kind,from,sourceId,exactFrame){this.#valid(run);const status=window.status,composite=sourceId==='timeline-picture'&&editCompositeNeeded(this.#timeline),source=composite?status.picture:sourceId?status.sources.find(s=>s.sourceId===sourceId):null,facts=composite?this.#timeline:sourceId?this.#timeline.sources.find(s=>s.id===sourceId):null,selection=composite?{pictureFrames:[exactFrame]}:sourceId?window.requests.find(r=>r.sourceId===sourceId&&r.from===from&&r.includePicture):null;
    if(sourceId&&(!source||!facts||!selection))throw new Error('The requested picture is outside the prepared saved window.');const key=source?.sourceKey??status.audio.sourceKey,expected={sourceKey:key,sourceId:sourceId??'timeline-audio',sourceRevision:facts?.revision??this.#timeline.revision,engineVersion:status.engineVersion,sourceFrames:facts?.frames??this.#timeline.frames,from,frames:Math.min(60,(facts?.frames??this.#timeline.frames)-from),width:source?.width??2,height:source?.height??2,includePicture:kind==='picture',audioLanes:kind==='picture'?[]:['mix'],...(kind==='picture'&&(composite||facts?.media==='graphic-rgba')?{pictureEncoding:'png-rgba'}:{}),...(composite?{picturePurpose:'timeline-composite'}:{}),...(selection?{pictureFrames:selection.pictureFrames}:{})},cacheKey=JSON.stringify(expected);let entry=this.#encoded.get(cacheKey);
    if(entry){this.#encoded.delete(cacheKey);this.#encoded.set(cacheKey,entry);return entry.page;}const path=window.path+'/'+(sourceId?'picture/'+encodeURIComponent(sourceId)+'/':'audio/')+from+'?'+query(window.identity)+'&sourceKey='+key+(composite?'&frame='+exactFrame:''),active=AbortSignal.any([run.controller.signal,window.controller.signal,AbortSignal.timeout(60000)]);
    entry=await fetchPreviewPacket(path,expected,(url,init)=>window.identity.client.mediaRequest(url,init),active);this.#valid(run);while(this.#encoded.size>=12||this.#bytes+entry.bytes>32*1024**2){const oldest=this.#encoded.keys().next().value;if(oldest===undefined)throw new Error('Preview media exceeds the browser cache limit.');this.#bytes-=this.#encoded.get(oldest).bytes;this.#encoded.delete(oldest);}this.#encoded.set(cacheKey,entry);this.#bytes+=entry.bytes;return entry.page;
  }
  #image(id,from,at){const entry=this.#images.get(id+':'+from);if(entry)entry.used=Math.max(entry.used,at);return entry?.bitmap;}
  async #sourcePicture(run,frame,sourceId,sourceFrame){const cached=this.#image(sourceId,sourceFrame,frame);if(cached)return cached;const window=await this.#window(run,frame),page=await this.#packet(run,window,'picture',pageAt(sourceFrame),sourceId,sourceFrame),index=page.header.picture.findIndex(p=>p.frame===sourceFrame);if(index<0)throw new Error('The preview lost an exact source frame.');const bitmap=await createImageBitmap(new Blob([page.picture[index]],{type:page.header.pictureEncoding==='png-rgba'?'image/png':'image/jpeg'}));try{this.#valid(run);}catch(error){bitmap.close();throw error;}
    while(this.#images.size>=96){const [key,old]=[...this.#images.entries()].sort((a,b)=>a[1].used-b[1].used)[0];old.bitmap.close();this.#images.delete(key);}this.#images.set(sourceId+':'+sourceFrame,{bitmap,used:frame});return bitmap;
  }
  async picture(run,frame){frame=this.#frame(frame);if(this.#frames.has(frame))return true;const current=this.#frame(this.#options.position());for(const [at,bitmap]of this.#frames)if(at<current-2){bitmap.close();this.#frames.delete(at);}if(this.#frames.size>=24)return false;
    const surface=this.#options.surface,canvas=this.#composition;if(canvas.width!==surface.width)canvas.width=surface.width;if(canvas.height!==surface.height)canvas.height=surface.height;
    await composePreviewFrame(this.#timeline,frame,canvas.getContext('2d',{alpha:false}),surface,async(id,from)=>{this.#valid(run);return this.#sourcePicture(run,frame,id,from);});this.#valid(run);const bitmap=await createImageBitmap(canvas);try{this.#valid(run);}catch(error){bitmap.close();throw error;}this.#frames.set(frame,bitmap);return true;
  }
  async audio(run,from,totalFrames,prefetch=false){this.#valid(run);const frames=Math.min(60,totalFrames-from);if(from>=this.#timeline.frames)return new Uint8Array(frames*1600*6);const window=await this.#window(run,from,!prefetch);if(!window.status)return null;const page=await this.#packet(run,window,'audio',from),pcm=new Uint8Array(frames*1600*6);pcm.set(page.audio.mix);return pcm;}
  prune(run){const keep=this.#frame(Math.min(this.#options.position(),this.#current(run)))-2;for(const [key,entry]of this.#images)if(entry.used<keep){entry.bitmap.close();this.#images.delete(key);}}
  clear(){for(const window of this.#windows.values())this.#discardWindow(window);for(const image of this.#images.values())image.bitmap.close();this.#images.clear();this.resetFrames();this.#encoded.clear();this.#bytes=0;return this.#release;}
}
