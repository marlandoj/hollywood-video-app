/**
 * HV-039-14 — picture editorial dropped keyboard focus to the page body after every edit.
 *
 * The picture editorial desk is drawn by `drawEditor()`, and the first thing it does is
 * `editor.replaceChildren()`: the "Selected clip" list, every tool section and every button are
 * thrown away and built again. Two paths reached it with the creator's focus inside it:
 *
 * - Changing "Selected clip" redrew the desk from the list's own `change` handler, so the list the
 *   creator was on stopped existing. On Windows the arrow keys on a closed `<select>` fire `change`
 *   on every press, so a keyboard user lost the list at the first arrow and was sent to the start
 *   of the page.
 * - Every saved edit — Split at frame, Apply clip settings, Undo saved edit, Open this branch — goes
 *   through `run()`, which disables the panel's controls while the request is out (so the browser
 *   has already moved focus off the pressed button) and ends in `drawEditor()`. The button was gone
 *   when the request finished, focus was on the page body, and every tool section the creator had
 *   opened was closed again except the default-open "Split, move and trim".
 *
 * The fix records what to come back to before `run()` disables anything, and `drawEditor()` spends
 * it: the sections that were open are opened again, and focus goes to the new copy of the control
 * that was used, or to the sequence heading when that control is gone or disabled. `run()` clears
 * the record in `finally`, so an edit that failed and never redrew cannot pull focus later.
 *
 * These tests mount the real `initEditorial` on a small DOM whose elements record `focus()` in
 * `document.activeElement`, with the saved sequence held by a fake API that applies edits with the
 * planner's own history functions. Nothing in `editorial.js` is mocked.
 */
import {expect,test} from 'bun:test';
import {initEditorial} from '../src/editorial.js';
import {createEditHistory,appendEdit,moveEditCursor,editHistoryState} from '../../planner/src/edit-history';
import {initialEditTimeline} from '../../planner/src/edit-timeline';
import {hash,memoryStorage} from './edit-assemblies-fixture.js';
import {scriptFixture} from './edit-script-fixture.js';

/** The editorial tests' element, plus `focus()`, which is what this increment is about. Its canvas
 * context answers every drawing call, because the mask editor draws into one for a picture clip. */
class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.listeners=new Map();this.className='';this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.open=false;this.ownText='';this.width=2;this.height=2;this.min='';this.max='';this.step='';this.classList={add:name=>{this.className=[...new Set([...this.className.split(' ').filter(Boolean),name])].join(' ');},remove:name=>{this.className=this.className.split(' ').filter(value=>value!==name).join(' ');}};this.context=new Proxy({canvas:this},{get:(context,key)=>key in context?context[key]:()=>{}});}
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
  contains(value){return this===value||this.children.some(child=>child.contains(value));}
  matches(selector){return selector.split(',').some(part=>{part=part.trim();if(part.startsWith('.'))return this.className.split(' ').includes(part.slice(1));if(part.startsWith('[')){const match=part.match(/^\[([^=\]]+)(?:=['"]?([^'"\]]+)['"]?)?\]$/);return match&&this.getAttribute(match[1])!==null&&(match[2]===undefined||this.getAttribute(match[1])===match[2]);}return this.tagName===part;});}
  querySelectorAll(selector){const all=this.children.flatMap(child=>[child,...child.querySelectorAll('*')]);if(selector==='*')return all;const parts=selector.trim().split(/\s+/);return all.filter(value=>{if(!value.matches(parts.at(-1)))return false;let parent=value.parentElement;for(let i=parts.length-2;i>=0;i--){while(parent&&!parent.matches(parts[i]))parent=parent.parentElement;if(!parent)return false;parent=parent.parentElement;}return true;});}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  // A browser's input value is always a string, and the desk's number parsing relies on that.
  set value(value){this.stored=String(value);}
  get value(){return this.stored;}
  checkValidity(){return true;}
  reportValidity(){}
  focus(){globalThis.document.activeElement=this;}
  getContext(){return this.context;}
  scrollIntoView(){}
  pause(){this.paused=true;}
  load(){}
}

/** One retained original, cut into picture, mix and captions clips, behind an API that saves edits. */
function desk({fail=false,script=false}={}){
  const names=['window','document','Option','localStorage','requestAnimationFrame','cancelAnimationFrame'],previous=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)])),root=new Element('main');root.root=true;const document=new EventTarget();Object.assign(document,{activeElement:null,hidden:false,createElement:tag=>new Element(tag),createElementNS:(namespace,tag)=>{const value=new Element(tag);value.namespaceURI=namespace;return value;},querySelectorAll:selector=>root.querySelectorAll(selector)});Object.assign(globalThis,{window:new EventTarget(),document,Option:class extends Element{constructor(label,value){super('option');this.textContent=label;this.value=value;}},requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{}});Object.defineProperty(globalThis,'localStorage',{value:memoryStorage(),configurable:true});
  const source={id:'source',revision:hash(2),label:'Retained original',frames:90,width:640,height:360,audio:['mix'],captions:[],voices:[],unmeasuredAudio:true};let history=createEditHistory('cut',initialEditTimeline([source],source.id,640,360)),libraryVersion=1;
  const saved=()=>structuredClone({libraryVersion,sequence:{id:'cut',label:'Parent cut',history},...editHistoryState(history)}),fixture=scriptFixture(),edits=[];
  const request=async(path,options={})=>{
    if(path==='')return {libraryVersion,libraryRevision:hash(8),sequences:[{id:'cut',label:'Parent cut',frames:90}],sources:[],jobs:[]};
    if(path==='/sequences/cut'&&options.method==='PATCH'){if(fail)throw Object.assign(new Error('The saved sequence changed in another window.'),{status:409});const change=options.body.change;history=change.kind==='edit'?appendEdit(history,change.operation,change.label,history.revision):moveEditCursor(history,change.target,change.reason,change.label,history.revision);libraryVersion++;edits.push(change);return saved();}
    if(path==='/sequences/cut')return saved();
    if(path.startsWith('/sequences/cut/script?')&&script){const timeline=editHistoryState(history).timeline;return {...fixture.data,sequenceId:'cut',historyRevision:history.revision,timelineRevision:timeline.revision,sources:[{...fixture.source,sourceId:source.id,sourceRevision:source.revision}],occurrences:[{...fixture.occurrence,sourceId:source.id,clipId:'initial-1',lane:'mix'}]};}
    throw Object.assign(new Error('Not found: '+path),{status:404});
  };
  const ui=initEditorial({parent:root,request,jobRequest:async()=>{throw new Error('No retained job selected.');},projectState:async()=>({dialogueSelections:{version:0,entries:[]}}),projectId:()=>'project',assetUrl:value=>value,canEdit:()=>true,adopt:async()=>{throw new Error('No export selected.');},previewClient:()=>({request:async()=>{throw new Error('No playback requested.');},mediaRequest:async()=>{throw new Error('No media requested.');}})});
  const all=()=>[root,...root.querySelectorAll('*')],find=(tag,text)=>all().find(value=>value.tagName===tag&&value.textContent===text),field=label=>{const caption=find('label',label);return all().find(value=>value.id===caption?.htmlFor);},section=label=>find('summary',label)?.parentElement;
  return {ui,root,edits,all,find,field,section,get focused(){return document.activeElement;},focus:value=>{document.activeElement=value;},
    close(){window.dispatchEvent(new Event('pagehide'));for(const [name,value]of previous)if(value)Object.defineProperty(globalThis,name,value);else delete globalThis[name];}};
}

test('choosing another clip in "Selected clip" leaves focus on the redrawn list, showing the clip that was chosen',async()=>{
  const h=desk();try{
    await h.ui.open();expect(h.focused).toBeNull();
    const list=h.field('Selected clip');expect(list.value).toBe('initial-0');h.focus(list);
    list.value='initial-1';list.onchange();
    const redrawn=h.field('Selected clip');
    // The desk really was rebuilt: the list the creator was on is no longer in the page.
    expect(redrawn).not.toBe(list);expect(list.isConnected).toBe(false);
    expect(h.focused).toBe(redrawn);expect(redrawn.value).toBe('initial-1');expect(redrawn.isConnected).toBe(true);
    // A second arrow press works on the list the creator is still on.
    redrawn.value='initial-2';redrawn.onchange();expect(h.focused).toBe(h.field('Selected clip'));expect(h.focused.value).toBe('initial-2');
  }finally{h.close();}
});

test('a saved edit returns focus to the redrawn button with the same words and keeps the tool section the creator opened',async()=>{
  const h=desk();try{
    await h.ui.open();
    const settings=h.section('Levels, opacity, crop and fades');expect(settings.open).toBe(false);settings.open=true;h.section('Speed ramps and freeze frames').open=true;
    const apply=h.find('button','Apply clip settings');h.focus(apply);await apply.onclick();
    expect(h.edits.map(e=>e.label)).toEqual(['Update picture settings']);
    const again=h.find('button','Apply clip settings');expect(again).not.toBe(apply);expect(apply.isConnected).toBe(false);
    expect(h.focused).toBe(again);expect(again.disabled).toBe(false);
    expect(h.section('Levels, opacity, crop and fades')).not.toBe(settings);expect(h.section('Levels, opacity, crop and fades').open).toBe(true);
    // A section the creator opened that does not hold the button is open again too.
    expect(h.section('Speed ramps and freeze frames').open).toBe(true);
    // Sections that were closed stay closed; the default-open one stays open.
    expect(h.section('Slip, roll, slide and remove').open).toBe(false);expect(h.section('Split, move and trim').open).toBe(true);
  }finally{h.close();}
});

test('a button that is disabled after its edit sends focus to the sequence heading, not the page body',async()=>{
  const h=desk();try{
    await h.ui.open();
    await h.find('button','Split at frame').onclick();expect(h.edits.map(e=>e.kind)).toEqual(['edit']);
    // Split leaves the button in place, so it gets focus back.
    expect(h.focused).toBe(h.find('button','Split at frame'));
    const history=h.section('Redo and branch history');history.open=true;
    // Undo back to the original sequence: the redrawn "Undo saved edit" is disabled, so it cannot take focus.
    const undo=h.find('button','Undo saved edit');h.focus(undo);await undo.onclick();
    expect(h.edits.map(e=>e.reason)).toEqual([undefined,'undo']);expect(h.find('button','Undo saved edit').disabled).toBe(true);
    const heading=h.find('h3','Parent cut');
    expect(h.focused).toBe(heading);expect(heading.tabIndex).toBe(-1);expect(heading.isConnected).toBe(true);
    expect(h.section('Redo and branch history').open).toBe(true);
  }finally{h.close();}
});

test('an edit that failed without redrawing does not pull focus back to its button on a later redraw from the screenplay links',async()=>{
  const h=desk({fail:true,script:true});try{
    await h.ui.open();
    await h.find('button','Apply clip settings').onclick();expect(h.root.textContent).toContain('The saved sequence changed in another window.');
    // Nothing was redrawn, so the stale "Apply clip settings" target must not survive the failed edit.
    await h.find('button','Load screenplay links').onclick();await h.find('button','Dialogue · Kevin: Hello.').onclick();
    const seek=h.all().find(value=>value.tagName==='button'&&value.textContent.startsWith('Select clip 2 and seek'));expect(seek).toBeDefined();
    h.focus(seek);await seek.onclick();
    expect(h.field('Selected clip').value).toBe('initial-1');
    expect(h.focused).toBe(seek);
  }finally{h.close();}
});
