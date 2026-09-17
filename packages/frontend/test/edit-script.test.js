import {expect,test} from 'bun:test';
import {createEditScriptNavigation} from '../src/edit-script.js';
import {scriptFixture} from './edit-script-fixture.js';

// A minimal DOM adapter exercises mounted control state. Real layout/interaction is a separate browser gate.
class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.listeners=new Map();this.className='';this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.open=false;this.ownText='';}
  set textContent(value){this.ownText=String(value);this.children=[];}
  get textContent(){return this.ownText+this.children.map(child=>child.textContent).join('');}
  append(...children){for(const child of children){child.parentElement=this;this.children.push(child);}}
  replaceChildren(...children){this.ownText='';this.children=[];this.append(...children);if(this.tagName==='select')this.value=children[0]?.value??'';}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return Object.hasOwn(this.attributes,name)?this.attributes[name]:null;}
  removeAttribute(name){delete this.attributes[name];}
  addEventListener(type,listener){this.listeners.set(type,listener);}
  contains(target){return this===target||this.children.some(child=>child.contains(target));}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);}
  emit(type){return this.listeners.get(type)?.();}
}
function mounted({reply,onSelect}={}){
  const f=scriptFixture(),originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),originalOption=Object.getOwnPropertyDescriptor(globalThis,'Option'),root=new Element('section'),requests=[],highlights=[],selected=[],seeks=[];let current=f.saved;
  globalThis.document={activeElement:null,createElement:tag=>new Element(tag)};globalThis.Option=class extends Element{constructor(label,value){super('option');this.textContent=label;this.value=value;}};
  const ui=createEditScriptNavigation({parent:root,current:()=>current,request:async(path,options)=>{requests.push({path,options});return reply?await reply(f):f.data;},onHighlight:value=>highlights.push(value),onSelectClip:async id=>{selected.push(id);if(onSelect)await onSelect(id);ui.bind(structuredClone(f.saved));},onSeek:value=>seeks.push(value)});
  const all=(at=root)=>[at,...at.children.flatMap(child=>all(child))],find=(tag,text)=>all().find(element=>element.tagName===tag&&element.textContent===text),classed=name=>all().filter(element=>element.className.split(' ').includes(name));
  return {f,ui,root,requests,highlights,selected,seeks,all,find,classed,setCurrent:value=>{current=value;},async open(){ui.bind(f.saved);ui.panel.open=true;ui.panel.emit('toggle');await Bun.sleep(0);},restore(){ui.dispose();if(originalDocument)Object.defineProperty(globalThis,'document',originalDocument);else delete globalThis.document;if(originalOption)Object.defineProperty(globalThis,'Option',originalOption);else delete globalThis.Option;}};
}

test('mounted screenplay navigation lazily loads, exposes performed text, and keeps selection across clip redraws',async()=>{
  const h=mounted();try{h.ui.bind(h.f.saved);expect(h.requests).toHaveLength(0);await h.open();expect(h.requests).toHaveLength(1);expect(h.root.textContent).toContain('screenplay '+h.f.source.scriptRevision.slice(0,12));
    await h.find('button','Dialogue · Kevin: Hello.').onclick();expect(h.classed('edit-script-detail')[0].textContent).toContain('Retained performed / localized text (es)Hola.');expect(h.highlights.at(-1).map(item=>item.id)).toEqual(['speech']);
    const seek=h.all().find(element=>element.tagName==='button'&&element.textContent.startsWith('Select clip 2 and seek'));await seek.onclick();expect(h.selected).toEqual(['dialogue']);expect(h.seeks).toEqual([0]);expect(h.classed('edit-script-detail')[0].textContent).toContain('Hola.');expect(h.requests).toHaveLength(1);
    const count=h.highlights.length;h.ui.bind(structuredClone(h.f.saved));expect(h.highlights).toHaveLength(count);expect(h.classed('edit-script-entry').find(row=>row.dataset.selected==='true').textContent).toContain('Hello.');
  }finally{h.restore();}
});

test('a rejected clip selection leaves navigation visible and never seeks past an unsaved edit guard',async()=>{
  const h=mounted({onSelect:()=>{throw new Error('Apply or discard the unsaved fields first.');}});try{await h.open();await h.find('button','Dialogue · Kevin: Hello.').onclick();await h.all().find(element=>element.tagName==='button'&&element.textContent.startsWith('Select clip 2 and seek')).onclick();expect(h.seeks).toEqual([]);expect(h.classed('edit-script-status')[0].textContent).toContain('unsaved fields');expect(h.classed('edit-script-detail')[0].textContent).toContain('Hola.');}finally{h.restore();}
});

test('searching performed text preserves the selected entry, while a nonmatching filter clears all highlights',async()=>{
  const h=mounted();try{await h.open();await h.find('button','Dialogue · Kevin: Hello.').onclick();const search=h.all().find(element=>element.tagName==='input'&&element.type==='search');search.value='hola';search.oninput();await Bun.sleep(170);expect(h.classed('edit-script-entry')).toHaveLength(1);expect(h.highlights.at(-1).map(item=>item.id)).toEqual(['speech']);search.value='missing';search.oninput();await Bun.sleep(170);expect(h.highlights.at(-1)).toEqual([]);expect(h.root.textContent).toContain('No entries match this search');expect(h.classed('edit-script-detail')[0].children).toHaveLength(0);}finally{h.restore();}
});

test('playback following does not steal focused controls and unchanged active sets do not redraw selection',async()=>{
  const h=mounted();try{await h.open();const follow=h.all().find(element=>element.tagName==='input'&&element.type==='checkbox'),lane=h.all().find(element=>element.tagName==='select'&&element.children.some(option=>option.value==='dialogue'));lane.value='dialogue';follow.checked=true;globalThis.document.activeElement=follow;await follow.onchange();expect(h.classed('edit-script-detail')[0].textContent).toContain('Hello.');const count=h.highlights.length,detail=h.classed('edit-script-detail')[0].children[0];h.ui.onFrame(1);expect(h.highlights).toHaveLength(count);expect(h.classed('edit-script-detail')[0].children[0]).toBe(detail);
    const search=h.all().find(element=>element.tagName==='input'&&element.type==='search');globalThis.document.activeElement=search;h.ui.onFrame(40);expect(globalThis.document.activeElement).toBe(search);expect(h.classed('edit-script-follow-status')[0].textContent).toContain('No matching retained');expect(h.classed('edit-script-detail')[0].textContent).toContain('Hello.');
  }finally{h.restore();}
});

test('follow advances between measured lines even while both lines and action coverage remain active throughout a shot',async()=>{
  const h=mounted({reply:f=>{
    const second={...f.entry,id:'line-2',text:'Goodbye.',performedText:'Adiós.',startLine:6,endLine:6},action={...f.entry,id:'action',kind:'action',text:'They enter the shop.',performedText:undefined,character:undefined};f.source.entries.splice(1,0,action);f.source.entries.push(second);
    const coverage=(entryId)=>({...f.occurrence,id:'coverage-'+entryId,entryId,startSample:0,endSample:144000,startFrame:0,endFrame:90,sourceStartSample:0,sourceEndSample:144000,evidence:'shot-coverage'});
    f.data.occurrences=[coverage('scene'),coverage('action'),coverage('line-1'),coverage('line-2'),{...f.occurrence,id:'measured-1',endSample:16000,endFrame:10,sourceEndSample:16000},{...f.occurrence,id:'measured-2',entryId:'line-2',startSample:16000,endSample:32000,startFrame:10,endFrame:20,sourceStartSample:16000,sourceEndSample:32000}];return f.data;
  }});try{await h.open();await h.find('button','Action: They enter the shop.').onclick();const follow=h.all().find(element=>element.tagName==='input'&&element.type==='checkbox'),lane=h.all().find(element=>element.tagName==='select'&&element.children.some(option=>option.value==='dialogue'));lane.value='dialogue';follow.checked=true;globalThis.document.activeElement=follow;await follow.onchange();expect(h.classed('edit-script-detail')[0].textContent).toContain('Hello.');expect(h.highlights.at(-1).map(item=>item.id).sort()).toEqual(['coverage-line-1','measured-1']);
    h.ui.onFrame(10);expect(h.classed('edit-script-detail')[0].textContent).toContain('Goodbye.');expect(h.highlights.at(-1).map(item=>item.id).sort()).toEqual(['coverage-line-2','measured-2']);expect(h.classed('edit-script-entry').filter(row=>row.dataset.active==='true')).toHaveLength(4);
    const first=h.classed('edit-script-occurrence')[0];expect(first.textContent).toContain('Measured speech timing');expect(first.textContent).toContain('seek to 0:00:10');await first.children.find(element=>element.tagName==='button').onclick();expect(h.seeks.at(-1)).toBe(10);
    const count=h.highlights.length;h.ui.onFrame(11);expect(h.highlights).toHaveLength(count);h.ui.onFrame(20);expect(h.classed('edit-script-detail')[0].textContent).toContain('Goodbye.');expect(globalThis.document.activeElement).toBe(follow);
  }finally{h.restore();}
});

test('unbound originals and unavailable entries have explicit states; text is inserted literally',async()=>{
  const h=mounted({reply:f=>{f.source.scriptRevision=null;f.source.scriptText=null;f.source.entries=[];f.data.occurrences=[];return f.data;}});try{await h.open();expect(h.root.textContent).toContain('no screenplay binding');expect(h.classed('edit-script-status')[0].textContent).toContain('no retained screenplay entries');}finally{h.restore();}
  const text=mounted({reply:f=>{f.entry.text='<img src=x onerror=alert(1)>';f.entry.unavailableReason='No measured timing was retained.';f.data.occurrences=f.data.occurrences.filter(item=>item.entryId!==f.entry.id);return f.data;}});try{await text.open();await text.find('button','Dialogue · Kevin: <img src=x onerror=alert(1)>').onclick();expect(text.classed('edit-script-detail')[0].textContent).toContain('<img src=x onerror=alert(1)>');expect(text.classed('edit-script-detail')[0].textContent).toContain('No measured timing');expect(text.all().some(element=>element.tagName==='img')).toBe(false);expect(text.highlights.at(-1)).toEqual([]);}finally{text.restore();}
});

test('rebind and source-load failure clear selected overlays; closing an in-flight load cancels its request',async()=>{
  let fail=false;const h=mounted({reply:f=>{if(fail)throw new Error('The retained source was withdrawn.');return f.data;}});try{await h.open();await h.find('button','Dialogue · Kevin: Hello.').onclick();fail=true;await h.find('button','Refresh screenplay links').onclick();expect(h.highlights.at(-1)).toEqual([]);expect(h.classed('edit-script-status')[0].textContent).toContain('withdrawn');h.ui.bind(null);expect(h.ui.panel.hidden).toBe(true);}finally{h.restore();}
  let finish;const pending=mounted({reply:()=>new Promise(resolve=>{finish=resolve;})});try{await pending.open();pending.ui.panel.open=false;pending.ui.panel.emit('toggle');expect(pending.requests[0].options.signal.aborted).toBe(true);finish(pending.f.data);await Bun.sleep(0);expect(pending.root.textContent).not.toContain('Retained screenplay revision');expect(pending.highlights.at(-1)).toEqual([]);}finally{pending.restore();}
});
