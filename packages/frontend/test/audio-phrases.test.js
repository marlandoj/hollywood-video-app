/**
 * HV-024-04 — one keystroke discarded every phrase direction on the line, and said nothing.
 *
 * `audio-studio.js` called `phraseEditor.set(text, [])` from three handlers: the narration text's
 * `oninput`, the translation's `oninput`, and the language `onchange`. The second argument is the
 * line's phrase directions — up to sixteen per line, each a speed, a volume, an emphasis and two
 * requested pauses the creator set by hand — and `[]` is all of them, gone, on every keystroke. The
 * only thing said was `editChanged()`'s "Review this line's settings", which is what it says when
 * anything at all changes.
 *
 * A phrase is a character range plus the exact words inside it, so whether an edit invalidated one
 * is a question with an answer — and it is the same question `describePhrase` and the Edit button
 * already ask. Typing at the end of a line leaves every earlier phrase exactly where it was.
 *
 * The same call also rebuilt one `<option>` per word into two live `<select>` elements. The
 * narration box holds 20,000 characters, which is about 3,200 words: 6,400 option constructions per
 * keystroke, measured below.
 */
import {expect, test} from 'bun:test';
import {createPhraseEditor, retainedPhrases} from '../src/audio-phrases.js';

class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.listeners=new Map();this.className='';this.value='';this.disabled=false;this.hidden=false;this.open=false;this.ownText='';}
  set textContent(value){this.ownText=String(value);this.children=[];}
  get textContent(){return this.ownText+this.children.map(child=>child.textContent).join('');}
  append(...children){for(const child of children){child.parentElement=this;this.children.push(child);}}
  replaceChildren(...children){this.ownText='';this.children=[];this.append(...children);}
  setAttribute(name,value){this.attributes[name]=String(value);}
  addEventListener(type,listener){this.listeners.set(type,listener);}
  querySelector(){return new Element('p');}
}
/** Counts every `<option>` the editor builds, which is the cost this file measures. */
function mounted(){
  const built={count:0};
  const originalOption=Object.getOwnPropertyDescriptor(globalThis,'Option');
  globalThis.Option=class extends Element{constructor(label,value){super('option');built.count++;this.textContent=label;this.value=value;}};
  const node=(tag,text)=>{const element=new Element(tag);if(text!==undefined)element.textContent=text;return element;};
  const parent=new Element('section');
  const editor=createPhraseEditor({parent,node,details:label=>node('details',label),
    field:(into,label,kind)=>{const element=node(kind==='number'?'input':kind==='textarea'?'textarea':'select');element.parentElement=node('label',label);into.append(element);return element;},
    button:(label,onClick)=>{const element=node('button',label);element.onClick=onClick;return element;},
    changed:()=>{}});
  return {editor,built,restore(){if(originalOption)Object.defineProperty(globalThis,'Option',originalOption);else delete globalThis.Option;}};
}

const TEXT = 'Hello there, friend of mine, and welcome back to the garden.';
/** Two directions the creator set by hand: words 1-2, and words 7-8. */
const PHRASES = [
  {start: TEXT.indexOf('Hello'), end: TEXT.indexOf('there,') + 'there,'.length, text: 'Hello there,', speed: 0.8},
  {start: TEXT.indexOf('welcome'), end: TEXT.indexOf('back') + 'back'.length, text: 'welcome back', volume: 1.4},
];

test('a phrase the edit left exactly where it was is kept, and one it moved is not', () => {
  // The whole table, with the reason each row is what it is.
  const cases = [
    ['nothing changed', TEXT, ['Hello there,', 'welcome back']],
    ['a word appended at the end', TEXT + ' Again.', ['Hello there,', 'welcome back']],
    ['the last word edited', TEXT.replace('garden.', 'greenhouse.'), ['Hello there,', 'welcome back']],
    ['a later phrase edited', TEXT.replace('welcome back', 'welcome home'), ['Hello there,']],
    ['an earlier word edited, which moves everything after it', TEXT.replace('Hello', 'Hi'), []],
    ['a word inserted before both', 'Well, ' + TEXT, []],
    ['the text replaced', 'A different line entirely.', []],
    ['the text emptied', '', []],
  ];
  for (const [name, text, expected] of cases)
    expect({name, kept: retainedPhrases(text, PHRASES).map(phrase => phrase.text)}).toEqual({name, kept: expected});
  // A space inserted inside the first phrase moves the second one too, so neither survives: the
  // offsets are into the whole line, and everything after an insertion has moved.
  expect(retainedPhrases(TEXT.replace('Hello there,', 'Hello  there,'), PHRASES).map(phrase => phrase.text)).toEqual([]);
  // A space inserted *after* both leaves both, which is the same rule read the other way.
  expect(retainedPhrases(TEXT.replace('the garden.', 'the  garden.'), PHRASES).map(phrase => phrase.text)).toEqual(['Hello there,', 'welcome back']);
  // And a phrase whose range no longer starts and ends on words is refused even if the text matches.
  expect(retainedPhrases('xHello there, friend', [{start: 1, end: 13, text: 'Hello there,'}])).toEqual([]);
});

test('and the editor keeps them across an edit, and says how many it could not', () => {
  const {editor, restore} = mounted();
  try {
    editor.set(TEXT, PHRASES);
    expect(editor.values().map(phrase => phrase.text)).toEqual(['Hello there,', 'welcome back']);
    // Typing at the end: nothing is lost, and nothing is reported.
    expect(editor.retext(TEXT + ' Again.')).toBe(0);
    expect(editor.values().map(phrase => phrase.text)).toEqual(['Hello there,', 'welcome back']);
    // Editing a word inside the second phrase costs that one, and only that one, and says so.
    expect(editor.retext(TEXT.replace('welcome back', 'welcome home'))).toBe(1);
    expect(editor.values().map(phrase => phrase.text)).toEqual(['Hello there,']);
    // Before this increment every one of these calls left `values()` empty.
    expect(editor.retext('A different line entirely.')).toBe(1);
    expect(editor.values()).toEqual([]);
    expect(editor.retext('Another line again.')).toBe(0);
  } finally { restore(); }
});

test('and it does not rebuild the word lists when the words did not change', () => {
  // Two `<select>` elements, one `<option>` per word, on every keystroke of a box that holds 20,000
  // characters. Measured here at 400 words: 800 options for the first set, and 800 more for every
  // call after it -- including the calls where nothing about the words moved.
  const {editor, built, restore} = mounted();
  try {
    const long = Array.from({length: 400}, (_, index) => 'word' + index).join(' ');
    const before = built.count;   // the emphasis select's own fixed options, built once at mount
    editor.set(long, []);
    const first = built.count - before;
    expect(first).toBe(800);
    // The same words again: no options are built.
    editor.set(long, []);
    editor.retext(long);
    expect(built.count - before).toBe(first);
    // A word changes, so the lists do: this is the work that is worth doing.
    editor.retext(long.replace('word399', 'word399x'));
    expect(built.count - before).toBe(first + 800);
  } finally { restore(); }
});
