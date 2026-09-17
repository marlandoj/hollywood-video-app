/**
 * HV-039-03 — the mask viewport told assistive technology it was a picture.
 *
 * `mask-viewport.js` created a `<canvas>`, gave it `tabIndex=0`, an
 * `aria-label` inviting arrow-key use and a `keydown` handler implementing it,
 * and then declared `role="img"`. That is a WCAG 4.1.2 (Name, Role, Value)
 * failure on two of its three counts: the role said static image where the
 * element was an interactive widget, and no value or state was exposed at all
 * -- the selected handle and its coordinates lived only in a closure, and the
 * caption that named them was rewritten on every paint with no live region and
 * nothing pointing at it.
 *
 * `role="img"` also prunes the subtree, so the element a screen reader met was
 * an image with a name and nothing else, while the arrow keys it was told to
 * press were being consumed by browse-mode navigation.
 */
import {expect,test} from 'bun:test';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {mountMaskViewport,MASK_STEP_PIXELS,MASK_STEP_SENTENCE,MASK_VIEWPORT_LABEL} from '../src/mask-viewport.js';

const SRC=join(import.meta.dir,'..','src');
const CONTEXT=new Proxy({},{get:(target,key)=>target[key]??(()=>{})});

/** A DOM stub that records what was written, rather than swallowing it. */
class Node {
  constructor(tag){this.tag=tag;this.attributes={};this.writes=[];this.children=[];this.style={};this.events=new Map();}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return Object.hasOwn(this.attributes,name)?this.attributes[name]:null;}
  removeAttribute(name){delete this.attributes[name];}
  append(...nodes){this.children.push(...nodes);}
  addEventListener(type,fn){this.events.set(type,fn);}
  getBoundingClientRect(){return {left:0,top:0,width:640,height:360};}
  getContext(){return CONTEXT;}
  focus(){}
  setPointerCapture(){}
  set textContent(value){this.written=value;this.writes.push(value);}
  get textContent(){return this.written??'';}
}

function harness(kind='rectangle'){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document'),changes=[];
  globalThis.document={createElement:tag=>new Node(tag)};
  const source={width:320,height:180},parent=new Node('div');
  const viewport=mountMaskViewport({parent,source,onGeometry:value=>changes.push(structuredClone(value)),onVertex(){},onError(){},canChange:()=>true});
  const geometry=kind==='polygon'
    ? {points:[{id:'a',xQ16:16384,yQ16:16384},{id:'b',xQ16:49152,yQ16:16384},{id:'c',xQ16:49152,yQ16:49152}]}
    : {xQ16:16384,yQ16:16384,widthQ16:32768,heightQ16:32768};
  viewport.set({geometry,kind,selectedVertex:kind==='polygon'?'a':null,mode:'source',frame:0});
  return {viewport,source,changes,geometry,parent,
    fire:(type,values={})=>viewport.canvas.events.get(type)?.({clientX:0,clientY:0,pointerId:1,preventDefault(){},...values}),
    restore(){viewport.dispose();if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;}};
}

test('the viewport is a widget with a name, a description and a live value, not an image',()=>{
  const h=harness();
  try{
    const {canvas,caption,announcement}=h.viewport;
    // The defect, named exactly: this is the assertion that fails if the role
    // comes back.
    expect(canvas.getAttribute('role')).not.toBe('img');
    expect(canvas.getAttribute('role')).toBe('application');
    expect(canvas.tabIndex).toBe(0);
    // Name.
    expect(canvas.getAttribute('aria-label')).toBe(MASK_VIEWPORT_LABEL);
    expect(MASK_VIEWPORT_LABEL).toContain(MASK_STEP_SENTENCE);
    // Description: the caption is reachable, which it was not before -- it had
    // no id and nothing referred to it.
    expect(caption.id).toBeTruthy();
    expect(canvas.getAttribute('aria-describedby')).toBe(caption.id);
    // Value: a live region that is *not* the caption. The caption is rewritten
    // on every paint, so making it live would announce during a drag.
    expect(announcement).not.toBe(caption);
    expect(announcement.getAttribute('aria-live')).toBe('polite');
    expect(caption.getAttribute('aria-live')).toBeNull();
    expect(caption.getAttribute('role')).toBeNull();
    // And the live region is a sibling of the application element, not a child
    // of it, or it would be pruned along with everything else inside. Asserted
    // positively: `canvas.children` being empty is true of any version of this
    // file and so proves nothing.
    expect(h.parent.children).toEqual([canvas,caption,announcement]);
    expect(h.parent).not.toBe(canvas);
  }finally{h.restore();}
});

test('the arrow-key step is declared once and the handler obeys that declaration',()=>{
  // Three statements of one rule: the handler, the accessible name, and the
  // mask editor's instructions paragraph. The sentence is derived from the
  // numbers, and this case pins the numbers to the behaviour -- so a label
  // claiming ten pixels cannot drift from a handler moving one.
  expect(MASK_STEP_SENTENCE).toBe('Arrow keys move 1 pixel; Shift moves 10 pixels; Alt moves 0.1 pixels.');
  // That literal pins the *value*. It does not pin the *derivation*: freezing
  // the sentence as a string of its own would satisfy it, and moving
  // MASK_STEP_PIXELS would then change the handler while the label kept
  // promising the old numbers. So the derivation is asserted from source.
  const viewportSource=readFileSync(join(SRC,'mask-viewport.js'),'utf8');
  const sentence=viewportSource.slice(viewportSource.indexOf('export const MASK_STEP_SENTENCE'));
  const expression=sentence.slice(0,sentence.indexOf(';\n'));
  for(const key of ['normal','shift','alt'])expect(expression).toContain('MASK_STEP_PIXELS.'+key);
  expect(expression).not.toMatch(/\b(?:10|0\.1|ten|tenth)\b/);
  // The editor's paragraph is built from the same export, not a copy of its
  // text. `toContain('MASK_STEP_SENTENCE')` would be satisfied by the import
  // line alone, so the concatenation is what is asserted.
  const editor=readFileSync(join(SRC,'mask-editor.js'),'utf8');
  expect(editor).toMatch(/'[^']*use these fields\. '\+MASK_STEP_SENTENCE/);
  // And no file may spell the rule out again in prose. The scan is on the
  // numbers in context rather than on the exact phrases this increment
  // deleted, which no future restatement would reproduce.
  const RESTATED=/(?:arrow|shift|alt)[^.\n]{0,48}\b(?:1|10|0\.1|one|ten|a tenth)\b[^.\n]{0,24}pixel/i;
  for(const file of readdirSync(SRC).filter(name=>/\.(js|html|css)$/.test(name)&&name!=='mask-viewport.js')){
    const text=readFileSync(join(SRC,file),'utf8');
    expect({file,restated:RESTATED.test(text)}).toEqual({file,restated:false});
  }
  expect(RESTATED.test('Arrow keys move one pixel; Shift moves ten.')).toBe(true);
  expect(RESTATED.test('Arrow keys move 1 pixel; Shift moves 10 pixels.')).toBe(true);
  expect(RESTATED.test('Drag a corner or vertex in the viewport.')).toBe(false);
  const h=harness();
  try{
    const q16=pixels=>Math.round(pixels/h.source.width*65536);
    h.fire('pointerdown',{clientX:480,clientY:270});           // the south-east corner
    h.fire('keydown',{key:'ArrowRight'});
    expect(h.changes.at(-1).widthQ16-h.geometry.widthQ16).toBe(q16(MASK_STEP_PIXELS.normal));
    h.fire('keydown',{key:'ArrowRight',shiftKey:true});
    expect(h.changes.at(-1).widthQ16-h.changes.at(-2).widthQ16).toBe(q16(MASK_STEP_PIXELS.shift));
    h.fire('keydown',{key:'ArrowRight',altKey:true});
    expect(h.changes.at(-1).widthQ16-h.changes.at(-2).widthQ16).toBe(q16(MASK_STEP_PIXELS.alt));
    // The three steps are genuinely different sizes, or the assertions above
    // would hold for a handler that ignored the modifiers.
    expect(new Set([MASK_STEP_PIXELS.normal,MASK_STEP_PIXELS.shift,MASK_STEP_PIXELS.alt]).size).toBe(3);
  }finally{h.restore();}
});

test('a keyboard move announces the handle and where it now is, in source pixels, and never twice running',()=>{
  const h=harness();
  try{
    const {announcement}=h.viewport;
    // The bottom-right handle of a shape at a quarter/three-quarters of a
    // 320x180 source: 0.75 * 320 = 240, 0.75 * 180 = 135.
    h.fire('pointerdown',{clientX:480,clientY:270});
    expect(announcement.textContent).toBe('Bottom-right corner at source pixel 240, 135.');
    const after=announcement.writes.length;
    // An unchanged repaint says nothing again.
    h.viewport.set({geometry:h.geometry,kind:'rectangle',selectedVertex:null,mode:'source',frame:0});
    expect(announcement.writes.length).toBe(after);
    h.fire('keydown',{key:'ArrowRight',shiftKey:true});
    expect(announcement.textContent).toBe('Bottom-right corner at source pixel 250, 135.');
    expect(announcement.writes.length).toBe(after+1);
    // Selecting elsewhere names the new handle: the top-left sits at a quarter
    // of the source, 80 by 45.
    h.fire('pointerdown',{clientX:160,clientY:90});
    expect(announcement.textContent).toBe('Top-left corner at source pixel 80, 45.');
  }finally{h.restore();}
});

test('a change made through the editor announces too, or the live region goes stale',()=>{
  // `set()` is the editor's only route back into the viewport: the coordinate
  // and vertex number fields, the vertex select, mask switching, a frame
  // change on an animated mask and `finishPolygon` all reach it through
  // `mask-editor.js`'s `paint()`. Nothing else in this suite covers that call,
  // so without this case the announcement could be dropped from `set()` and
  // the live region would keep asserting the previous handle and the previous
  // position after every one of them -- and with `role="application"` carrying
  // no value of its own, the live region is the whole value channel.
  const h=harness();
  try{
    const {announcement}=h.viewport;
    h.fire('pointerdown',{clientX:480,clientY:270});
    const after=announcement.writes.length;
    // The editor moved the shape with the coordinate fields.
    h.viewport.set({geometry:{...h.geometry,xQ16:32768},kind:'rectangle',selectedVertex:null,mode:'source',frame:0});
    expect(announcement.textContent).toBe('Bottom-right corner at source pixel 320, 135.');
    expect(announcement.writes.length).toBe(after+1);
  }finally{h.restore();}
  const p=harness('polygon');
  try{
    const {announcement}=p.viewport;
    expect(announcement.textContent).toBe('Vertex 1 of 3 at source pixel 80, 45.');
    // The editor's vertex select changed the selection and nothing else.
    p.viewport.set({geometry:p.geometry,kind:'polygon',selectedVertex:'c',mode:'source',frame:0});
    expect(announcement.textContent).toBe('Vertex 3 of 3 at source pixel 240, 135.');
  }finally{p.restore();}
});

test('a polygon vertex is announced by position in the ring',()=>{
  const h=harness('polygon');
  try{
    h.fire('keydown',{key:'ArrowRight',shiftKey:true});
    expect(h.viewport.announcement.textContent).toBe('Vertex 1 of 3 at source pixel 90, 45.');
  }finally{h.restore();}
});

test('a drag is silent until it ends, while the caption keeps being rewritten',()=>{
  // This is why the caption cannot be the live region and the live region
  // cannot be written from `changed()`: a pointer drag repaints continuously.
  const h=harness();
  try{
    const {caption,announcement}=h.viewport;
    h.fire('pointerdown',{clientX:480,clientY:270});
    const saidOnSelect=announcement.writes.length,captionWrites=caption.writes.length;
    h.fire('pointermove',{clientX:500,clientY:280});
    h.fire('pointermove',{clientX:520,clientY:290});
    h.fire('pointermove',{clientX:540,clientY:300});
    expect(announcement.writes.length).toBe(saidOnSelect);
    expect(caption.writes.length).toBeGreaterThan(captionWrites);
    h.fire('pointerup');
    expect(announcement.writes.length).toBe(saidOnSelect+1);
    expect(announcement.textContent).toMatch(/^Bottom-right corner at source pixel /);
  }finally{h.restore();}
});

test('no element in the frontend carries a static role together with keyboard interaction',()=>{
  // The family guard: `role="img"` on a focusable, key-handling element is the
  // defect above, and this refuses the shape rather than the one instance.
  //
  // It is per *element*, not per file, because a file-granular version is both
  // too coarse and wrong here: `operator.html` legitimately holds a labelled
  // static-role chart and, separately, seven `tabindex="0"` scroll regions.
  // In JavaScript the element is identified by the receiver the attribute is
  // set on; in HTML, by the tag.
  //
  // Comments are stripped first, and that is not hypothetical tidiness: the
  // comment this increment added to `mask-viewport.js` quotes `role="img"` to
  // explain why it is gone, and the first draft of this case flagged it.
  const strip=(text,html)=>text.replace(html?/<!--[\s\S]*?-->/g:/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,'');
  const STATIC='(?:img|presentation|none)';
  const jsOffenders=text=>{
    const statics=new Set(),interactive=new Set();
    // Both spellings: setAttribute, and the reflected `el.role =` property,
    // which every engine now supports and which an author reaching for the
    // modern form would use.
    for(const m of text.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\.setAttribute\\(\\s*['"]role['"]\\s*,\\s*['"]${STATIC}['"]`,'gi')))statics.add(m[1]);
    for(const m of text.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\.role\\s*=\\s*['"]${STATIC}['"]`,'gi')))statics.add(m[1]);
    for(const m of text.matchAll(/([A-Za-z_$][\w$]*)\.tabIndex\s*=\s*['"]?0\b/g))interactive.add(m[1]);
    for(const m of text.matchAll(/([A-Za-z_$][\w$]*)\.setAttribute\(\s*['"]tabindex['"]\s*,\s*['"]?0['"]?\s*\)/gi))interactive.add(m[1]);
    for(const m of text.matchAll(/([A-Za-z_$][\w$]*)\.addEventListener\(\s*['"]keydown['"]/g))interactive.add(m[1]);
    for(const m of text.matchAll(/([A-Za-z_$][\w$]*)\.onkeydown\s*=/g))interactive.add(m[1]);
    return {statics:[...statics],offenders:[...statics].filter(name=>interactive.has(name))};
  };
  const ROLE_TAG=new RegExp(`role\\s*=\\s*["']?${STATIC}\\b`,'i');
  const KEY_TAG=/tabindex\s*=\s*["']?0\b|onkeydown\s*=/i;
  const htmlTags=text=>[...text.matchAll(/<[a-zA-Z][^>]*>/g)].map(m=>m[0]).filter(tag=>ROLE_TAG.test(tag));
  const offenders=[],statics=[];
  for(const file of readdirSync(SRC).filter(name=>/\.(js|html)$/.test(name))){
    const html=file.endsWith('.html'),text=strip(readFileSync(join(SRC,file),'utf8'),html);
    if(html){
      const tags=htmlTags(text);
      statics.push(...tags.map(()=>file));
      offenders.push(...tags.filter(tag=>KEY_TAG.test(tag)).map(()=>file));
    }else{
      const found=jsOffenders(text);
      statics.push(...found.statics.map(()=>file));
      offenders.push(...found.offenders.map(()=>file));
    }
  }
  expect(offenders).toEqual([]);
  // The scan has to be finding static roles, or an empty offender list proves
  // nothing -- and this lower bound is also the only net under an *aliased*
  // receiver (`const el=canvas;el.setAttribute('role','img')`), which the
  // per-element check cannot follow.
  //
  // It is a bound and an allowlist rather than an exact list on purpose: an
  // exact list fails for the next author who adds a correct
  // `role="presentation"` to a decorative image, in a test they have never
  // read, and the cheapest thing from their seat is to delete the line.
  const REVIEWED=['editorial.js','operator.html'];   // both labelled, neither focusable nor key-handling
  expect(statics.length).toBeGreaterThanOrEqual(REVIEWED.length);
  expect([...new Set(statics)].sort()).toEqual(REVIEWED);
  // And the predicates bite, per element and not per file, in both spellings.
  expect(jsOffenders(`c.setAttribute('role','img');c.tabIndex=0;`).offenders).toEqual(['c']);
  expect(jsOffenders(`c.role='img';c.tabIndex=0;`).offenders).toEqual(['c']);
  expect(jsOffenders(`c.setAttribute('role','img');c.addEventListener('keydown',f);`).offenders).toEqual(['c']);
  expect(jsOffenders(`c.role='presentation';c.onkeydown=f;`).offenders).toEqual(['c']);
  expect(jsOffenders(`c.setAttribute('role','none');c.setAttribute('tabindex','0');`).offenders).toEqual(['c']);
  expect(jsOffenders(`a.setAttribute('role','img');b.tabIndex=0;`).offenders).toEqual([]);
  expect(jsOffenders(`c.setAttribute('role','status');c.tabIndex=0;`).offenders).toEqual([]);
  expect(jsOffenders(`c.setAttribute('role','img');c.tabIndex=-1;`).offenders).toEqual([]);
  for(const tag of ['<svg role="img" tabindex="0">','<svg role=img tabindex=0>','<svg ROLE="IMG" TabIndex="0">','<svg role="img" onkeydown="f()">'])
    expect({tag,flagged:htmlTags(tag).filter(t=>KEY_TAG.test(t)).length}).toEqual({tag,flagged:1});
  expect(htmlTags('<svg role="img"><div tabindex="0">').filter(tag=>KEY_TAG.test(tag))).toHaveLength(0);
  expect(htmlTags('<div role="region" tabindex="0">')).toEqual([]);
  expect(strip('// role="img"',false)).toBe('');
});
