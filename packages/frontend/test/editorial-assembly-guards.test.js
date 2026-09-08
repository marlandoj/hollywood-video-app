import {expect,test} from 'bun:test';
import {initEditorial} from '../src/editorial.js';
import {assemblyFixture,hash,memoryStorage} from './edit-assemblies-fixture.js';

// Exercise the actual editor and assembly modules with a small DOM; no production modules are mocked.
class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.listeners=new Map();this.className='';this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.open=false;this.ownText='';this.width=2;this.height=2;this.min='';this.max='';this.step='';this.classList={add:name=>{this.className=[...new Set([...this.className.split(' ').filter(Boolean),name])].join(' ');},remove:name=>{this.className=this.className.split(' ').filter(value=>value!==name).join(' ');}};this.context={canvas:this,clears:0,fillRect(){this.clears++;},drawImage(){}};}
  set textContent(value){this.ownText=String(value);this.replaceChildren();}
  get textContent(){return this.ownText+this.children.map(child=>child.textContent).join('');}
  get isConnected(){return Boolean(this.root||this.parentElement?.isConnected);}
  append(...values){for(const value of values){value.remove();value.parentElement=this;this.children.push(value);}}
  replaceChildren(...values){for(const child of this.children)child.parentElement=null;this.children=[];this.append(...values);if(this.tagName==='select')this.value=values[0]?.value??'';}
  before(value){value.remove();const parent=this.parentElement;if(parent){value.parentElement=parent;parent.children.splice(parent.children.indexOf(this),0,value);}}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(value=>value!==this);this.parentElement=null;}
  setAttribute(key,value){this.attributes[key]=String(value);if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_a,b)=>b.toUpperCase())]=String(value);}
  getAttribute(key){return this.attributes[key]??null;}
  removeAttribute(key){delete this.attributes[key];}
  addEventListener(type,callback){this.listeners.set(type,callback);}
  emit(type){return this.listeners.get(type)?.();}
  contains(value){return this===value||this.children.some(child=>child.contains(value));}
  matches(selector){return selector.split(',').some(part=>{part=part.trim();if(part.startsWith('.'))return this.className.split(' ').includes(part.slice(1));if(part.startsWith('[')){const match=part.match(/^\[([^=\]]+)(?:=['"]?([^'"\]]+)['"]?)?\]$/);return match&&this.getAttribute(match[1])!==null&&(match[2]===undefined||this.getAttribute(match[1])===match[2]);}return this.tagName===part;});}
  querySelectorAll(selector){const all=this.children.flatMap(child=>[child,...child.querySelectorAll('*')]);if(selector==='*')return all;const parts=selector.trim().split(/\s+/);return all.filter(value=>{if(!value.matches(parts.at(-1)))return false;let parent=value.parentElement;for(let i=parts.length-2;i>=0;i--){while(parent&&!parent.matches(parts[i]))parent=parent.parentElement;if(!parent)return false;parent=parent.parentElement;}return true;});}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  getContext(){return this.context;}
  scrollIntoView(){}
  pause(){this.paused=true;}
  load(){}
}
function harness({intercept}={}){
  const names=['window','document','Option','localStorage','requestAnimationFrame','cancelAnimationFrame'],previous=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)])),root=new Element('main');root.root=true;const document=new EventTarget();Object.assign(document,{activeElement:null,hidden:false,createElement:tag=>new Element(tag),createElementNS:(namespace,tag)=>{const value=new Element(tag);value.namespaceURI=namespace;return value;},querySelectorAll:selector=>root.querySelectorAll(selector)});Object.assign(globalThis,{window:new EventTarget(),document,Option:class extends Element{constructor(label,value){super('option');this.textContent=label;this.value=value;}},requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{}});Object.defineProperty(globalThis,'localStorage',{value:memoryStorage(),configurable:true});
  const f=assemblyFixture({intercept}),source={id:'source',revision:hash(2),label:'Retained original',frames:90,width:640,height:360,audio:['mix'],captions:[],voices:[],unmeasuredAudio:true},timeline={schema:'hv-edit-timeline/1',revision:hash(3),frames:90,width:640,height:360,clips:[],sources:[source],markers:[]},saved={libraryVersion:1,head:0,parent:null,children:[],timeline,sequence:{id:'cut',label:'Parent cut',history:{id:'cut',revision:hash(1),root:timeline,events:[]}}},calls=[];let projectId='project',allowed=true;
  const request=async(path,options={})=>{calls.push({path,options});if(path==='')return {libraryVersion:1,libraryRevision:hash(8),sequences:[{id:'cut',label:'Parent cut',frames:90}],sources:[],jobs:[]};if(path==='/sequences/cut')return structuredClone(saved);const result=await f.request(path,options);if(result.item)Object.assign(result.item.parent,{width:640,height:360,timelineRevision:timeline.revision});return result;};
  const ui=initEditorial({parent:root,request,jobRequest:async()=>{throw new Error('No retained job selected.');},projectState:async()=>({dialogueSelections:{version:0,entries:[]}}),projectId:()=>projectId,assetUrl:value=>value,canEdit:()=>allowed,adopt:async()=>{throw new Error('No export selected.');},previewClient:()=>({request:async()=>{throw new Error('No playback requested.');},mediaRequest:async()=>{throw new Error('No media requested.');}})}),all=()=>[root,...root.querySelectorAll('*')],find=(tag,text)=>all().find(value=>value.tagName===tag&&value.textContent===text),field=label=>{const caption=find('label',label);return all().find(value=>value.id===caption?.htmlFor);},assemblyPanel=()=>all().find(value=>value.className==='edit-assemblies'),assemblyPreview=()=>find('h3','Preview saved assembly')?.parentElement;
  return {ui,root,f,calls,all,find,field,assemblyPanel,assemblyPreview,setProject:value=>{projectId=value;},setAllowed:value=>{allowed=value;},async start(){await ui.open();await find('button','Load assemblies').onclick();await find('button','Start from complete saved cut').onclick();},async saved(){await this.start();await find('button','Save proposal and review').onclick();expect(assemblyPreview().hidden).toBe(false);},close(){window.dispatchEvent(new Event('pagehide'));for(const [name,value]of previous)if(value)Object.defineProperty(globalThis,name,value);else delete globalThis[name];}};
}

test('reopening the same project preserves the assembly raw draft, DOM and parent locks without refreshing the index',async()=>{
  const h=harness();try{await h.start();const raw=h.all().find(value=>value.dataset.field==='toFrame'),creation=h.field('New sequence name');raw.value='';await raw.oninput();expect(creation.disabled).toBe(true);const calls=h.calls.length;await h.ui.open();expect(h.calls).toHaveLength(calls);expect(h.all().find(value=>value.dataset.field==='toFrame')).toBe(raw);expect(raw.value).toBe('');expect(h.field('New sequence name')).toBe(creation);expect(creation.disabled).toBe(true);expect(h.root.textContent).toContain('assembly draft or saved request is still open');expect(h.ui.unsaved).toBe(true);
  }finally{h.close();}
});
test('reopening with an uncertain assembly save preserves its exact request and retry control',async()=>{
  const h=harness({intercept:(call,run)=>{if(call.method==='POST')throw new Error('Response unavailable.');return run();}});try{await h.start();await h.find('button','Save proposal and review').onclick();const stored=localStorage.getItem('hv-assembly-pending:project'),calls=h.calls.length;expect(stored).not.toBeNull();await h.ui.open();expect(h.calls).toHaveLength(calls);expect(localStorage.getItem('hv-assembly-pending:project')).toBe(stored);expect(h.find('button','Retry the same saved request')).toBeDefined();expect(h.field('New sequence name').disabled).toBe(true);
  }finally{h.close();}
});
test('every creation-draft field immediately clears assembly preview and restores it when returned to the saved defaults',async()=>{
  const h=harness();try{await h.saved();for(const [label,value,original,event]of [['New sequence name','New project cut','New assembly','oninput'],['Export dimensions','custom','1280x720','onchange'],['Export width','640','1280','oninput'],['Export height','360','720','oninput']]){const field=h.field(label);field.value=value;field[event]();expect(h.assemblyPreview().hidden).toBe(true);expect(h.all().find(value=>value.dataset.field==='label').disabled).toBe(true);expect(h.ui.unsaved).toBe(true);field.value=original;field[event]();expect(h.assemblyPreview().hidden).toBe(false);expect(h.all().find(value=>value.dataset.field==='label').disabled).toBe(false);}expect(h.ui.unsaved).toBe(false);
  }finally{h.close();}
});
test('a project change clears both saved previews before an external-edit guard can return early',async()=>{
  const h=harness();try{await h.saved();const preview=h.assemblyPreview(),canvas=preview.querySelector('canvas'),clears=canvas.context.clears;h.setProject('other-project');h.setAllowed(false);const calls=h.calls.length;await h.ui.open();expect(h.calls).toHaveLength(calls);expect(preview.hidden).toBe(true);expect(canvas.context.clears).toBeGreaterThan(clears);expect(h.assemblyPanel().hidden).toBe(true);expect(h.root.textContent).toContain('other open edit');
  }finally{h.close();}
});
