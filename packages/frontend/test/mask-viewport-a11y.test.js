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
  const source={width:320,height:180};
  const viewport=mountMaskViewport({parent:new Node('div'),source,onGeometry:value=>changes.push(structuredClone(value)),onVertex(){},onError(){},canChange:()=>true});
  const geometry=kind==='polygon'
    ? {points:[{id:'a',xQ16:16384,yQ16:16384},{id:'b',xQ16:49152,yQ16:16384},{id:'c',xQ16:49152,yQ16:49152}]}
    : {xQ16:16384,yQ16:16384,widthQ16:32768,heightQ16:32768};
  viewport.set({geometry,kind,selectedVertex:kind==='polygon'?'a':null,mode:'source',frame:0});
  return {viewport,source,changes,geometry,
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
    // And the live region is outside the application element, or it would be
    // pruned along with everything else inside it.
    expect(canvas.children).toEqual([]);
  }finally{h.restore();}
});

test('the arrow-key step is declared once and the handler obeys that declaration',()=>{
  // Three statements of one rule: the handler, the accessible name, and the
  // mask editor's instructions paragraph. The sentence is derived from the
  // numbers, and this case pins the numbers to the behaviour -- so a label
  // claiming ten pixels cannot drift from a handler moving one.
  expect(MASK_STEP_SENTENCE).toBe('Arrow keys move 1 pixel; Shift moves 10 pixels; Alt moves 0.1 pixels.');
  const editor=readFileSync(join(SRC,'mask-editor.js'),'utf8');
  expect(editor).toContain('MASK_STEP_SENTENCE');
  // No file may spell the rule out again in prose.
  for(const file of readdirSync(SRC).filter(name=>/\.(js|html|css)$/.test(name))){
    const text=readFileSync(join(SRC,file),'utf8');
    expect({file,restated:/Shift moves ten|moves a tenth|move one pixel/.test(text)}).toEqual({file,restated:false});
  }
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
  const jsOffenders=text=>{
    const statics=new Set(),interactive=new Set();
    for(const m of text.matchAll(/([A-Za-z_$][\w$]*)\.setAttribute\(\s*['"]role['"]\s*,\s*['"](?:img|presentation|none)['"]/g))statics.add(m[1]);
    for(const m of text.matchAll(/([A-Za-z_$][\w$]*)\.tabIndex\s*=\s*0\b/g))interactive.add(m[1]);
    for(const m of text.matchAll(/([A-Za-z_$][\w$]*)\.addEventListener\(\s*['"]keydown['"]/g))interactive.add(m[1]);
    return {statics:[...statics],offenders:[...statics].filter(name=>interactive.has(name))};
  };
  const htmlTags=text=>[...text.matchAll(/<[a-zA-Z][^>]*>/g)].map(m=>m[0]).filter(tag=>/role=["'](?:img|presentation|none)["']/.test(tag));
  const offenders=[],statics=[];
  for(const file of readdirSync(SRC).filter(name=>/\.(js|html)$/.test(name))){
    const html=file.endsWith('.html'),text=strip(readFileSync(join(SRC,file),'utf8'),html);
    if(html){
      const tags=htmlTags(text);
      statics.push(...tags.map(()=>file));
      offenders.push(...tags.filter(tag=>/tabindex=["']0["']/i.test(tag)||/onkeydown=/i.test(tag)).map(()=>file));
    }else{
      const found=jsOffenders(text);
      statics.push(...found.statics.map(()=>file));
      offenders.push(...found.offenders.map(()=>file));
    }
  }
  expect(offenders).toEqual([]);
  // The scan has to be finding the static roles, or an empty offender list
  // proves nothing. Two remain, both correct: the saved-timeline SVG in
  // `editorial.js` and the metrics chart in `operator.html`, each labelled,
  // neither focusable nor key-handling.
  expect(statics.sort()).toEqual(['editorial.js','operator.html']);
  // And the predicates bite, per element and not per file.
  expect(jsOffenders(`c.setAttribute('role','img');c.tabIndex=0;`).offenders).toEqual(['c']);
  expect(jsOffenders(`c.setAttribute('role','img');c.addEventListener('keydown',f);`).offenders).toEqual(['c']);
  expect(jsOffenders(`a.setAttribute('role','img');b.tabIndex=0;`).offenders).toEqual([]);
  expect(jsOffenders(`c.setAttribute('role','status');c.tabIndex=0;`).offenders).toEqual([]);
  expect(jsOffenders(`c.setAttribute('role','img');c.tabIndex=-1;`).offenders).toEqual([]);
  expect(htmlTags('<svg role="img" tabindex="0">').filter(tag=>/tabindex=["']0["']/.test(tag))).toHaveLength(1);
  expect(htmlTags('<svg role="img"><div tabindex="0">').filter(tag=>/tabindex=["']0["']/.test(tag))).toHaveLength(0);
  expect(strip('// role="img"',false)).toBe('');
});
