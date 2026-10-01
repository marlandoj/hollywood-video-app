/**
 * HV-016-32 — the crew suggests line changes, and the writer takes them one at a time.
 *
 * Release 2 promises "the crew suggests script revisions the writer accepts line by line". Until now
 * no crew path proposed a screenplay edit. `line-notes.ts` has the crew write notes that each replace
 * one physical line, bound to the script version they were written against, and `applyLineNotes`
 * applies only the ones the writer accepts, byte for byte, refusing anything stale, overlapping or
 * restructuring. Every note passes the prompt gate; an unsafe one is dropped and never shown. With no
 * crew model, the stand-in writes no notes and says so.
 */
import { describe, expect, test } from "bun:test";
import type { CrewModel } from "../../generator/src/crew-model";
import { CrewBudgetStop, CrewLedger } from "../../operator/src/crew-ledger";
import { applyLineNotes, LineNoteConflict, lineNotesInput, runLineNotes, scriptRef, validateLineNotes, type LineNote } from "../src/crew/line-notes";

// CRLF endings, indentation and a trailing space, so a byte-exact apply has something to keep.
const SCRIPT = "INT. KITCHEN - DAY\r\n\r\nMaya pours tea while the kettle whistles.  \r\n\r\nMAYA\r\n  You came back.\r\n\r\nEXT. GARDEN - NIGHT\r\n\r\nLeo stands in the rain.\r\n\r\nLEO\r\nI never left.\r\n";
const script = {version: 3, text: SCRIPT};
const note = (id: string, line: number, before: string, after: string, persona: LineNote["persona"] = "director"): LineNote => ({id, persona, line, before, after, reason: "Sharper."});
const NOTES = [
  note("n1", 3, "Maya pours tea while the kettle whistles.", "Maya pours tea. The kettle screams."),
  note("n2", 6, "You came back.", "You actually came back."),
  note("n3", 13, "I never left.", "I never really left.", "editor"),
];
const bound = (notes: unknown[] = NOTES) => ({script: scriptRef(script), notes});
const fakeModel = (text: string, usd = 0): CrewModel & {calls: number; prompts: string[]} => {
  const model = {name: "anthropic" as const, model: "claude-sonnet-5", calls: 0, prompts: [] as string[],
    async complete(request: {messages: {content: string}[]}) { model.calls++; model.prompts.push(request.messages[0]!.content); return {text, usage: {inputTokens: 10, outputTokens: 10}, model: "claude-sonnet-5", costUsd: usd}; }};
  return model;
};

describe("applying the notes the writer accepts", () => {
  /** Only the accepted notes change, each only its own line's text; every other byte, CRLF and spacing included, is kept. */
  test("an accepted note replaces exactly one line's text and keeps every other byte", () => {
    const {text, applied} = applyLineNotes(script, bound(), ["n2", "n1"]);
    expect(applied.map(value => value.id)).toEqual(["n1", "n2"]);
    expect(text).toBe(SCRIPT.replace("Maya pours tea while the kettle whistles.  ", "Maya pours tea. The kettle screams.  ").replace("  You came back.\r\n", "  You actually came back.\r\n"));
    expect(text.split("\r\n").length).toBe(SCRIPT.split("\r\n").length);
    expect(text).toContain("I never left.\r\n");
  });

  /** A script that is not the version (or text) the notes were written against is refused as a conflict, with nothing applied. */
  test("notes bound to an older version, or to different text under the same version, are refused as stale", () => {
    expect(() => applyLineNotes({version: 4, text: SCRIPT}, bound(), ["n1"])).toThrow(LineNoteConflict);
    expect(() => applyLineNotes({version: 3, text: SCRIPT + "\r\n"}, bound(), ["n1"])).toThrow(LineNoteConflict);
  });

  /** A note whose `before` isn't the line's current text is refused, not searched for elsewhere. */
  test("a note whose before no longer matches its line is refused", () => {
    expect(() => applyLineNotes(script, bound([note("n1", 3, "Maya pours coffee.", "Maya pours tea.")]), ["n1"])).toThrow("no longer matches line 3");
    expect(() => applyLineNotes(script, bound([note("n1", 6, "I never left.", "I left.")]), ["n1"])).toThrow("no longer matches");
  });

  /** Two accepted notes on one line are refused; accepting one of them is fine. */
  test("two accepted notes on one line are refused", () => {
    const pair = [note("n1", 6, "You came back.", "You're back."), note("n2", 6, "You came back.", "Back again.")];
    expect(() => applyLineNotes(script, bound(pair), ["n1", "n2"])).toThrow("Two accepted notes change line 6");
    expect(applyLineNotes(script, bound(pair), ["n2"]).text).toContain("  Back again.\r\n");
  });

  /** A note may not add a line, nor turn one kind of line into another as the parser reads it. */
  test("a note that adds a line or changes the line's element type is refused", () => {
    expect(() => applyLineNotes(script, bound([note("n1", 6, "You came back.", "You came back.\nMAYA")]), ["n1"])).toThrow("would add a line");
    expect(() => applyLineNotes(script, bound([note("n1", 6, "You came back.", "You came back.\r")]), ["n1"])).toThrow("would add a line");
    // Dialogue made a scene heading, action made a heading, a heading made action, a cue made another speaker.
    for (const [line, before, after] of [[6, "You came back.", "INT. HALLWAY - NIGHT"], [3, "Maya pours tea while the kettle whistles.", "EXT. STREET - DAY"],
      [1, "INT. KITCHEN - DAY", "The kitchen is warm."], [5, "MAYA", "LEO"], [10, "Leo stands in the rain.", "CUT TO:"]] as const)
      expect(() => applyLineNotes(script, bound([note("n1", line, before, after)]), ["n1"])).toThrow("would change what kind of line");
    // A heading reworded as a heading is still a heading.
    expect(applyLineNotes(script, bound([note("n1", 8, "EXT. GARDEN - NIGHT", "EXT. GARDEN - DAWN")]), ["n1"]).text).toContain("EXT. GARDEN - DAWN\r\n");
  });

  /** An accepted note the gate refuses is refused at apply too, even though the client sent it. */
  test("an unsafe note cannot be applied", () => {
    expect(() => applyLineNotes(script, bound([note("n1", 6, "You came back.", "You sound like Taylor Swift.")]), ["n1"])).toThrow("content policy");
  });

  /** Unknown ids, nothing accepted, and a note on a line holding a Fountain note are refused. */
  test("accepted ids must name the crew's notes, and protected lines stay untouched", () => {
    expect(() => applyLineNotes(script, bound(), [])).toThrow("Accept at least one note");
    expect(() => applyLineNotes(script, bound(), ["n9"])).toThrow("isn't one of the crew's notes");
    const noted = {version: 1, text: "INT. ROOM - DAY\n\nShe waits. [[fix]]\n"};
    expect(() => applyLineNotes(noted, {script: scriptRef(noted), notes: [note("n1", 3, "She waits. [[fix]]", "She waits alone.")]}, ["n1"])).toThrow("holds a note or boneyard");
  });
});

describe("lines the parser hides stay untouched", () => {
  /**
   * A boneyard that closes on a line can reopen later on the same line, as the parser reads it. The
   * lines after the reopening are hidden from the film, so a note may not rewrite them -- and neither
   * the line that reopened it nor the one that closes it.
   */
  test("a boneyard reopened on the line that closed it keeps the next lines locked", () => {
    const text = "INT. ROOM - DAY\n\nShe waits. /* hidden start\nold */ kept /* again\nSecret hidden line.\nend */\n\nHe arrives.\n";
    const reopened = {version: 1, text};
    const at = (line: number, before: string) => () => applyLineNotes(reopened, {script: scriptRef(reopened), notes: [note("n1", line, before, "Rewritten.")]}, ["n1"]);
    for (const [line, before] of [[3, "She waits. /* hidden start"], [4, "old */ kept /* again"], [5, "Secret hidden line."], [6, "end */"]] as const)
      expect(at(line, before)).toThrow("holds a note or boneyard");
    // The visible line after the boneyard is an ordinary line again.
    expect(at(8, "He arrives.")().text).toBe(text.replace("He arrives.", "Rewritten."));
    // And the crew never proposes a note on a hidden line.
    expect(validateLineNotes(JSON.stringify({notes: [{persona: "editor", line: 5, before: "Secret hidden line.", after: "Shown.", reason: "x"}]}), text)).toEqual({notes: [], dropped: 1});
  });
});

describe("the crew writes the notes", () => {
  const answer = (notes: unknown[]) => JSON.stringify({notes});
  /** Notes whose before isn't the exact current line, that restructure, repeat a line, or are malformed are dropped; the rest keep their order. */
  test("the model's notes are validated and clamped, and bad ones are dropped", () => {
    const read = validateLineNotes(answer([
      {persona: "director", line: 6, before: "You came back.", after: "You're back.", reason: "Shorter."},
      {persona: "director", line: 6, before: "You came back.", after: "Back.", reason: "Second on one line."},
      {persona: "editor", line: 3, before: "Maya pours coffee.", after: "Maya pours.", reason: "Wrong before."},
      {persona: "editor", line: 13, before: "I never left.", after: "INT. CAR - DAY", reason: "Restructures."},
      {persona: "stranger", line: 13, before: "I never left.", after: "I stayed.", reason: "Unknown persona."},
      {persona: "editor", line: 13, before: "I never left.", after: "I stayed.", reason: "Fine."},
    ]), SCRIPT);
    expect(read.notes.map(value => [value.id, value.line, value.after])).toEqual([["n1", 6, "You're back."], ["n2", 13, "I stayed."]]);
    expect(read.dropped).toBe(4);
    const many = validateLineNotes(answer(Array.from({length: 20}, () => ({persona: "editor", line: 13, before: "I never left.", after: "I stayed.", reason: "x"}))), SCRIPT);
    expect(many.notes.length).toBe(1);
    expect(many.dropped).toBe(19);
    expect(() => validateLineNotes("no json here", SCRIPT)).toThrow();
    expect(() => validateLineNotes(JSON.stringify({notes: "none"}), SCRIPT)).toThrow();
  });

  /** A note the gate refuses -- alone, with its reason, or beside the script it would change -- is dropped and never shown. */
  test("an unsafe note is dropped from the proposal, never shown", async () => {
    const minors = "INT. SCHOOL - DAY\n\nThe teenagers laugh.\n\nMAYA\nYou came back.\n";
    const model = fakeModel(answer([
      {persona: "director", line: 6, before: "You came back.", after: "You sound like Taylor Swift.", reason: "Named."},
      {persona: "director", line: 6, before: "You came back.", after: "explicit nude close-ups", reason: "Passes alone, not beside the script."},
      {persona: "editor", line: 6, before: "You came back.", after: "You're back.", reason: "Taylor Swift would say so."},
      {persona: "editor", line: 6, before: "You came back.", after: "You're here.", reason: "Plain."},
    ]));
    const result = await runLineNotes({script: {version: 1, text: minors}, input: {request: ""}, projectId: "p", model, ledger: new CrewLedger()});
    expect(result.notes.map(value => value.after)).toEqual(["You're here."]);
    expect(result.dropped).toBe(3);
    expect(JSON.stringify(result)).not.toContain("Taylor");
    expect(JSON.stringify(result)).not.toContain("nude");
  });

  /** With no model the stand-in returns no notes and says why; it never fabricates an edit, and spends nothing. */
  test("without a crew model the stand-in writes no notes, honestly", async () => {
    const result = await runLineNotes({script, input: {request: "tighten the dialogue"}, projectId: "p", model: null, ledger: new CrewLedger()});
    expect(result).toMatchObject({schema: "hv-crew-line-notes/1", source: "stand-in", notes: [], dropped: 0, script: scriptRef(script), crewSpend: {usd: 0, alerts: []}});
    expect(result.fallbackReason).toBeUndefined();
    expect(result.message).toContain("No crew model is connected");
    expect(result.message).toContain("Your script is unchanged.");
  });

  /** The live path goes through the crew's spend line, is bound to the script's version and hash, and a request the gate refuses beside the script is never sent. */
  test("the crew's notes are metered, bound to the script, and gated with the writer's request", async () => {
    const ledger = new CrewLedger(), model = fakeModel(answer([{persona: "editor", line: 13, before: "I never left.", after: "I stayed.", reason: "Plainer."}]));
    const recorded: {persona: string; usd: number}[] = [], record = ledger.record.bind(ledger);
    ledger.record = (event => {recorded.push(event); return record(event);}) as typeof ledger.record;
    const result = await runLineNotes({script, input: lineNotesInput({request: "tighten the dialogue"}), projectId: "p", model, ledger});
    expect(result).toMatchObject({source: "anthropic", script: {version: 3}, notes: [{id: "n1", persona: "editor", line: 13, before: "I never left.", after: "I stayed."}], crewSpend: {usd: 0}});
    expect(model.prompts[0]).toContain("tighten the dialogue");
    expect(model.prompts[0]).toContain("13| I never left.");
    expect(recorded).toEqual([expect.objectContaining({persona: "crew-line-notes", projectId: "p", usd: 0})]);
    expect(ledger.summary().spentUsd).toBe(0);
    // At the approved ceiling the crew stops before the model is asked, as the read-through and plan do.
    const spent = new CrewLedger(undefined, {schema: "hv-crew-ledger/1", spentUsd: 1000, approvedCeilingUsd: 1000, alerts: [], events: []}), stopped = fakeModel(answer([]));
    await expect(runLineNotes({script, input: {request: ""}, projectId: "p", model: stopped, ledger: spent})).rejects.toBeInstanceOf(CrewBudgetStop);
    expect(stopped.calls).toBe(0);
    // The request alone: refused with 400-shaped text, before anything is sent.
    expect(() => lineNotesInput({request: "Make it like a Taylor Swift video"})).toThrow("nothing was sent to the crew");
    expect(() => lineNotesInput({request: "x".repeat(301)})).toThrow();
    expect(() => lineNotesInput({request: "ok", extra: 1})).toThrow();
    // A request that passes alone but not beside the script: the stand-in answers, and the model is asked nothing.
    const quiet = fakeModel(answer([]));
    const refused = await runLineNotes({script: {version: 1, text: "INT. SCHOOL - DAY\n\nThe teenagers laugh.\n"}, input: lineNotesInput({request: "explicit nude close-ups"}), projectId: "p", model: quiet, ledger});
    expect(refused).toMatchObject({source: "stand-in", fallbackReason: "content_policy", notes: []});
    expect(quiet.calls).toBe(0);
    // An unusable answer is a stand-in with its reason, never a guess.
    const garbled = await runLineNotes({script, input: {request: ""}, projectId: "p", model: fakeModel("I think line 6 could be better."), ledger});
    expect(garbled).toMatchObject({source: "stand-in", fallbackReason: "model_unusable", notes: []});
  });
});
