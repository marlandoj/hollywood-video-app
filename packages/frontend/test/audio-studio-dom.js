/**
 * The smallest DOM the voice studio will mount on, and a faithful enough event dispatch.
 *
 * `packages/frontend/src/audio-studio.js` had no test that built it at all, which is how HV-024-05
 * went unseen: the defect is not in any function, it is in the order two handlers for the same
 * gesture write to the same line. Only dispatch can show that, so dispatch is what this provides —
 * the target's `on<type>` property handler first, then every `addEventListener` up the tree, which
 * is the order a browser runs them in for a bubbling event.
 */
export class Element {
  constructor(tag) {
    this.tag = tag; this.attributes = {}; this.children = []; this.dataset = {}; this.style = {};
    this.listeners = new Map(); this.parentElement = null; this.validity = {badInput: false};
    this.value = ""; this.disabled = false; this.hidden = false; this.checked = false;
  }
  setAttribute(name, value) {this.attributes[name] = String(value);}
  getAttribute(name) {return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;}
  removeAttribute(name) {delete this.attributes[name];}
  hasAttribute(name) {return Object.hasOwn(this.attributes, name);}
  addEventListener(type, listener) {this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);}
  removeEventListener(type, listener) {this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));}
  append(...nodes) {for (const child of nodes) {child.parentElement = this; this.children.push(child);}}
  prepend(...nodes) {for (const child of nodes) {child.parentElement = this;} this.children.unshift(...nodes);}
  replaceWith(node) {const siblings = this.parentElement.children; siblings[siblings.indexOf(this)] = node; node.parentElement = this.parentElement; this.parentElement = null;}
  replaceChildren(...nodes) {for (const child of nodes) {child.parentElement = this;} this.children = [...nodes];}
  /** HV-039-23: taken off its parent's children, as a browser does, so `isConnected` turns false. */
  remove() {const siblings = this.parentElement?.children; if (siblings) siblings.splice(siblings.indexOf(this), 1); this.parentElement = null;}
  querySelector(selector) {return descendants(this).find(element => element.tag === selector) ?? null;}
  querySelectorAll(selector) {const tags = selector.split(","); return descendants(this).filter(element => tags.includes(element.tag));}
  get previousElementSibling() {const siblings = this.parentElement?.children ?? []; return siblings[siblings.indexOf(this) - 1] ?? null;}
  get lastChild() {return this.children.at(-1) ?? null;}
  /** HV-039-05: focus is recorded where a browser records it, so a test can ask where it went. */
  focus() {if (globalThis.document) globalThis.document.activeElement = this;}
  /** On the page when its topmost ancestor is the document's body, as in a browser. */
  get isConnected() {let node = this; while (node.parentElement) node = node.parentElement; return node === globalThis.document?.body;}
  get localName() {return this.tag;}
  contains(other) {for (let node = other; node; node = node.parentElement) if (node === this) return true; return false;}
  /** Only what the studio asks: `[hidden]`, or a tag name. */
  closest(selector) {for (let node = this; node; node = node.parentElement) if (selector === "[hidden]" ? node.hidden : node.tag === selector) return node; return null;}
  scrollIntoView() {}
  reportValidity() {return true;}
  setCustomValidity(message) {this.validationMessage = message;}
  set textContent(value) {this.written = value;}
  get textContent() {return this.written ?? "";}
}

export const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
/** Every element under `root`, plus `root`, so a test can find a control by the words on its label. */
export const tree = element => [element, ...descendants(element)];

/**
 * Dispatch `type` at `element`: its own property handler, then the listeners on it and above it.
 *
 * This is the whole point of the harness. `translation` sits inside the `settings` fieldset, and
 * `settings` listens for `input`, so a browser runs `translation.oninput` and then the fieldset's
 * `editChanged` — which is the order that produced the defect.
 */
export function fire(element, type, value) {
  if (value !== undefined) element.value = value;
  const event = {type, target: element, preventDefault() {}, stopPropagation() {}};
  element["on" + type]?.call(element, event);
  for (let node = element; node; node = node.parentElement) for (const listener of node.listeners.get(type) ?? []) listener.call(node, event);
}

/** A document, a window and an `Option`, restored when the test is done with them. */
export function mountDom() {
  const saved = ["document", "window", "Option", "sessionStorage"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const body = new Element("body");
  globalThis.document = {createElement: tag => new Element(tag), createElementNS: (namespace, tag) => new Element(tag), createTextNode: text => {const node = new Element("#text"); node.textContent = text; return node;}, hidden: false, addEventListener() {}, removeEventListener() {}, body, activeElement: body};
  globalThis.window = {addEventListener() {}, removeEventListener() {}};
  globalThis.Option = class extends Element {constructor(label, value) {super("option"); this.textContent = label; this.value = value ?? label;}};
  globalThis.sessionStorage = {getItem: () => null, setItem() {}, removeItem() {}};
  return () => {for (const [name, descriptor] of saved) {if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];}};
}
