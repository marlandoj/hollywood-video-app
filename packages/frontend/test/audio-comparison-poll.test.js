/**
 * HV-039-09 — choosing a take to compare stopped it within two seconds while another read rendered.
 *
 * The voice studio's "Compare saved takes" redraws only when its signature changes, and the
 * signature includes which take each slot shows:
 *
 *     const signature=()=>JSON.stringify({jobs:…,comparison});
 *     if(signature()===historySignature)return;historySignature=signature();stopMedia();history.replaceChildren(…);
 *
 * Choosing a take in a slot changed `comparison` and left `historySignature` behind. While any read
 * for the line is queued or rendering, the studio checks every two seconds. The next check saw a
 * signature that no longer matched and redrew: `stopMedia()` paused every take, removed its source,
 * and rebuilt both slots. A creator who picked an earlier take for B and pressed play heard it stop
 * within two seconds, with focus gone from the list they had just used, and it happened again
 * whenever they chose another take.
 */
import {afterEach, expect, test} from "bun:test";
import {initAudioStudio} from "../src/audio-studio.js";
import {Element, fire, mountDom, tree} from "./audio-studio-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
let restore = () => {};
afterEach(() => {restore(); globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;});

const line = {characterId: "c1", sceneIndex: 0, source: {index: 0, character: "MAYA", text: "You came back.", cues: [], hash: "line-hash"}};
const read = (id, status) => ({id, status, idempotencyKey: "p1:" + id,
  audioTake: {characterId: "c1", sceneIndex: 0, source: {index: 0, hash: "line-hash", text: "You came back."}, voiceLabel: "Studio voice", controls: {emotion: "neutral"},
    settings: {controls: {emotion: "neutral", speed: 1, volume: 1}, beforeMs: 0, afterMs: 0}},
  ...(status === "done" ? {output: {audioUrl: "/audio/" + id + ".wav"}} : {})});

async function voiceStudio() {
  restore = mountDom();
  const checks = [], paused = [];
  globalThis.setTimeout = (callback, delay) => {
    if (delay !== 2000) return realSetTimeout(callback, delay);
    const timer = {callback, cleared: false}; checks.push(timer); return timer;
  };
  globalThis.clearTimeout = timer => {if (timer && typeof timer === "object" && "cleared" in timer) timer.cleared = true; else realClearTimeout(timer);};
  // An <audio> that records being paused, which is what `stopMedia` does to a take that is playing.
  const create = document.createElement;
  document.createElement = tag => {const element = create(tag); if (tag === "audio") {element.pause = () => paused.push(element); element.load = () => {};} return element;};
  const jobs = [read("11111111-aaaa-4aaa-8aaa-111111111111", "done"), read("22222222-bbbb-4bbb-8bbb-222222222222", "done"), read("33333333-cccc-4ccc-8ccc-333333333333", "running")];
  const state = {characters: [{id: "c1", name: "MAYA"}], lines: [line], scenes: [], jobs, voices: [], enabled: true};
  const parent = new Element("div");
  const studio = initAudioStudio({parent, prepare: async () => {}, prepareGeneration: async () => {}, request: async () => structuredClone(state),
    saveVoice: async () => ({casting: {version: 1}}), savePerformance: async () => ({}), projectId: () => "p1", assetUrl: url => String(url), canEdit: () => true, changed: () => {}});
  await studio.open(); await settle();
  const all = () => tree(parent);
  const slot = label => {
    const caption = all().find(element => element.tag === "label" && element.textContent === "Take " + label);
    return all().find(element => element.id === caption?.htmlFor);
  };
  /** The next two-second status check, as the browser would run it. */
  const check = async () => {const next = checks.filter(timer => !timer.cleared).at(-1); next.cleared = true; await next.callback(); await settle();};
  return {all, slot, check, paused, jobs};
}

test("a take chosen for comparison keeps playing through the next status check", async () => {
  const s = await voiceStudio();
  const b = s.slot("B");
  fire(b, "change", s.jobs[0].id);
  const audio = s.all().filter(element => element.tag === "audio").find(element => element.src === "/audio/" + s.jobs[0].id + ".wav");
  expect(audio).toBeDefined();
  // Choosing stops only the take the slot showed before; from here on, nothing should be stopped.
  s.paused.length = 0;
  await s.check();
  // Nothing about the reads changed, so nothing is redrawn and nothing is stopped.
  expect(s.paused).toEqual([]);
  expect(s.slot("B")).toBe(b);
  expect(b.value).toBe(s.jobs[0].id);
  expect(s.all().includes(audio)).toBe(true);
});

test("and a read that does change is still redrawn, keeping the take the creator chose", async () => {
  const s = await voiceStudio();
  fire(s.slot("B"), "change", s.jobs[0].id);
  s.jobs[2] = read(s.jobs[2].id, "done");
  await s.check();
  expect(s.slot("B").value).toBe(s.jobs[0].id);
});
