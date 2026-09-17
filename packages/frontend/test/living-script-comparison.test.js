import {expect,test} from 'bun:test';
import {mountLivingScriptComparison} from '../src/preview-comparison.js';
import {previewIdentity} from '../src/preview-media.js';

const hash=value=>String(value).repeat(64),settle=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await Bun.sleep(1);}throw new Error('Comparison fixture did not settle.');};
class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.dataset={};this.width=2;this.height=2;this.value='';this.disabled=false;this.hidden=false;this.ownText='';}
  append(...children){for(const child of children){child.remove();child.parentElement=this;this.children.push(child);}}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}
  replaceChildren(...children){for(const child of this.children)child.parentElement=null;this.children=[];this.append(...children);}
  set textContent(value){this.ownText=String(value);this.replaceChildren();}get textContent(){return this.ownText+this.children.map(child=>child.textContent).join('');}
  setAttribute(key,value){this.attributes[key]=String(value);}getContext(){return {canvas:this,fillRect(){},drawImage(){}};}
  getAttribute(name){return Object.hasOwn(this.attributes,name)?this.attributes[name]:null;}
  removeAttribute(name){delete this.attributes[name];}
  all(){return [this,...this.children.flatMap(child=>child.all())];}
}
function harness(intercept){
  const names=['window','document','requestAnimationFrame','cancelAnimationFrame'],saved=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const root=new Element('main'),document=new EventTarget();Object.assign(document,{hidden:false,activeElement:null,createElement:tag=>new Element(tag),querySelectorAll:()=>[]});Object.assign(globalThis,{window:new EventTarget(),document,requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{}});
  const timeline={schema:'hv-edit-timeline/1',revision:hash(1),frames:60,width:2,height:2,sources:[],clips:[],markers:[]},sequence={id:'parent',label:'Original cut',history:{revision:hash(2)}};
  const recut={revision:hash(3),sequenceId:'child',history:{revision:hash(4)},afterTimeline:{...timeline,revision:hash(5)},parent:{timeline}};
  const review={proposalId:'proposal',proposalRevision:hash(6),recut,request:{reviewRevision:recut.revision,recut,recutInput:{projectId:'project',sequenceId:'parent',historyRevision:hash(2),library:{revision:hash(7),sequences:[sequence]}}}};
  const result={registration:{schema:'hv-living-script-preview/1',id:hash(8),projectId:'project',proposalId:'proposal',proposalRevision:hash(6),reviewRevision:hash(3),sequenceId:'child',historyRevision:hash(4),timelineRevision:hash(5),expiresAt:new Date(Date.now()+60000).toISOString(),accepted:false},sequence:{id:'child',label:'Revised cut',history:recut.history},timeline:recut.afterTimeline};
  let active={projectId:'project',sequenceId:'parent',historyRevision:hash(2),editorialRevision:hash(7),busy:false,canEdit:true},owner='first';const calls=[],statuses=[];
  const mounted=mountLivingScriptComparison({parent:root,current:()=>active,onStatus:value=>statuses.push(value),client:()=>{const captured=owner;return {request:async(path,options)=>{const call={owner:captured,path,...options};calls.push(call);return intercept?intercept(call,()=>structuredClone(result)):structuredClone(result);}};}});
  return {mounted,root,review,result,calls,statuses,setCurrent:value=>{active=value;},setOwner:value=>{owner=value;},retry:()=>root.all().find(item=>item.tagName==='button'&&item.textContent==='Prepare this cut comparison'),async close(){mounted.dispose();await Bun.sleep(5);for(const [name,value]of saved)if(value)Object.defineProperty(globalThis,name,value);else delete globalThis[name];}};
}

test('pending comparison registers the exact reviewed body without accepting and releases using the captured owner',async()=>{
  const f=harness();try{f.mounted.bind(f.review);await settle(()=>f.root.textContent.includes('Proposed cut'));
    expect(f.calls).toHaveLength(1);expect(f.calls[0].path).toBe('/screenplay/proposals/proposal/recut-preview');expect(f.calls[0].body).toEqual({proposalRevision:f.review.proposalRevision,request:f.review.request});expect(f.statuses.every(value=>value.ready===false)).toBe(true);
    f.setOwner('second');f.mounted.bind(null);await settle(()=>f.calls.length===2);expect(f.calls[1]).toMatchObject({owner:'first',method:'DELETE',path:'/screenplay/proposals/proposal/recut-preview/'+hash(8)});
  }finally{await f.close();}
});

test('changed parent and mismatched returned recut cannot mount a ready comparison',async()=>{
  const f=harness((_call,run)=>({...run(),timeline:{revision:hash(9)}}));try{f.mounted.bind(f.review);await settle(()=>f.root.textContent.includes('differs from the reviewed cut'));expect(f.root.textContent).not.toContain('Proposed cut');expect(f.statuses.every(value=>!value.ready)).toBe(true);expect(f.retry().disabled).toBe(false);
    f.setCurrent(null);await f.retry().onclick();expect(f.calls).toHaveLength(1);
  }finally{await f.close();}
});

test('late registration response after project change cannot restore a comparison',async()=>{
  let release;const f=harness(async(call,run)=>{if(call.method==='POST')await new Promise(resolve=>{release=resolve;});return run();});try{f.mounted.bind(f.review);await settle(()=>Boolean(release));f.setCurrent(null);f.setOwner('second');f.mounted.bind(null);release();await settle(()=>f.calls.some(call=>call.method==='DELETE'));expect(f.calls.at(-1)).toMatchObject({owner:'first',method:'DELETE',path:'/screenplay/proposals/proposal/recut-preview/'+hash(8)});expect(f.mounted.panel.hidden).toBe(true);expect(f.root.textContent).not.toContain('Proposed cut');expect(f.statuses.every(value=>!value.ready)).toBe(true);
  }finally{await f.close();}
});

test('pending preview media identity separates proposal, registration, recut and saved history',()=>{
  const cut={sequence:{id:'child',history:{revision:hash(4)}},timeline:{revision:hash(5)},livingScriptPreview:{proposalId:'proposal',reviewId:hash(8),recutRevision:hash(3)}},identity=previewIdentity(cut,{});
  expect(identity.base).toBe('/screenplay/proposals/proposal/recut-preview/'+hash(8)+'/preview');expect(identity.outputRevision).toBeUndefined();expect(identity.historyRevision).toBe(hash(4));
  for(const field of ['proposalId','reviewId','recutRevision'])expect(previewIdentity({...cut,livingScriptPreview:{...cut.livingScriptPreview,[field]:field==='proposalId'?'another':hash(9)}},{}).key).not.toBe(identity.key);
  expect(()=>previewIdentity({...cut,livingScriptPreview:{...cut.livingScriptPreview,reviewId:'../other'}},{})).toThrow('exact reviewed');
});

test('same-review replacement waits for late registration cleanup before registering again',async()=>{
  let release,posts=0;const f=harness(async(call,run)=>{if(call.method==='POST'&&++posts===1)await new Promise(resolve=>{release=resolve;});return run();});try{
    f.mounted.bind(f.review);await settle(()=>Boolean(release));f.mounted.bind(f.review);await Bun.sleep(5);expect(posts).toBe(1);release();await settle(()=>f.root.textContent.includes('Proposed cut'));
    expect(f.calls.map(call=>call.method)).toEqual(['POST','DELETE','POST']);expect(f.statuses.every(value=>!value.ready)).toBe(true);
  }finally{await f.close();}
});
