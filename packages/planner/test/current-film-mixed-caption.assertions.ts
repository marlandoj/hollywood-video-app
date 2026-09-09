import {expect} from "bun:test";
import {contentHash as hash} from "../../generator/src/capabilities";
import {compileEditScriptSource} from "../src/edit-script-source";
import {editFactsRevision,type EditSourceReceipt} from "../src/edit-sources";

/** Reuse the complete caption regression on an already-inspected actual /4
 * receipt. Only cloned caption facts are adversarial; the authentic execution,
 * proof, source files and the caller's original receipt remain unchanged.
 * This helper registers no test and performs no media generation or inspection. */
export function assertCurrentFilmMixedCaptionMismatch(source:EditSourceReceipt):void {
  if(source.schema!=="hv-edit-source/4")throw new Error("Inspect an actual mixed-film source before checking caption correspondence.");
  function changedReceipt(mutate:(value:EditSourceReceipt)=>void):EditSourceReceipt{
    const value=structuredClone(source);mutate(value);
    value.facts.revision=editFactsRevision(value.job,value.facts.frames,value.facts.width,value.facts.height,value.facts.captions);
    const {revision:_revision,...body}=value;return {...body,revision:hash(body)};
  }
  expect(source.facts.captions.length).toBeGreaterThan(1);
  for(const mutate of [
    (value:EditSourceReceipt)=>{value.facts.captions.at(-1)!.text="Changed final retained cue";},
    (value:EditSourceReceipt)=>{value.facts.captions.pop();},
    (value:EditSourceReceipt)=>{value.facts.captions.reverse();},
    (value:EditSourceReceipt)=>{const first=value.facts.captions[0]!;first.id="changed-caption-identity";},
  ]){
    const changed=changedReceipt(mutate),index=compileEditScriptSource(changed);
    expect(index.entries.some(entry=>entry.windows.some(window=>window.evidence==="measured-speech"&&!window.lanes.includes("captions")))).toBe(true);
    expect(index.entries.every(entry=>entry.windows.every(window=>!window.lanes.includes("captions")))).toBe(true);
    expect(index.warnings.join(" ")).toContain("caption-lane navigation remains unbound");
  }
}
