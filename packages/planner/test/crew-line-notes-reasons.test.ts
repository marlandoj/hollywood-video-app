/**
 * HV-016-35 — the crew's line notes quote the script's own lines, and a note that can't be applied is
 * counted, not lost.
 *
 * The Release 2 exit run asked the live crew (OpenRouter) to "Tighten the dialogue in the last scene"
 * of film A and got `notes: 0, dropped: 0` for a paid answer, with nothing saying why. The crew now
 * sees which lines it may change, each with its number and the scenes marked, and answers with a line
 * number and the replacement; the studio takes `before` from the script itself. Each note it can't use
 * is counted under a fixed reason, an answer it can't read says why, and when nothing is usable the
 * message says so with the commonest reason. The crew model is a fake that spends $0.
 */
import { describe, expect, test } from "bun:test";
import { CrewAnswerUnusable, CrewModelUnusable, type CrewModel } from "../../generator/src/crew-model";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { applyLineNotes, LINE_NOTE_DROP_REASONS, lineNotesPrompt, readLineNotesAnswer, runLineNotes, scriptRef, validateLineNotes } from "../src/crew/line-notes";

// Indentation, a trailing space and CRLF, so a byte-exact apply has something to keep; a parenthetical,
// a transition and a boneyard, so there are lines the crew must not change.
const SCRIPT = [
  "INT. KITCHEN - DAY", "", "Maya pours tea while the kettle whistles.  ", "", "MAYA", "(quietly)", "  You came back.", "", "CUT TO:", "",
  "EXT. GARDEN - NIGHT", "", "Leo stands in the rain. /* cut this */", "", "LEO", "I never left.", "",
].join("\r\n");
const script = {version: 2, text: SCRIPT};
// Lines: 1 heading, 3 action, 5 cue, 6 parenthetical, 7 dialogue, 9 transition, 11 heading, 13 boneyard, 15 cue, 16 dialogue.

// Film A from the Release 2 exit run (docs/evidence/release-2/scripts/film-a.fountain, branch loop/HV-030-23).
const FILM_A = `Title: The Lock-Keeper's Lantern
Author: Rough Cut release run

EXT. CANAL TOWPATH - NIGHT

Fog lies on black water. NELL, a young barge-hand in a green oilskin coat, walks the towpath with a storm lantern.

NELL
Someone left the gate open.

INT. LOCK-KEEPER'S HUT - DAY - CONTINUOUS

Nell steps in out of the fog. AUGUST, an old lock-keeper with a white beard, mends a rope beside the stove.

AUGUST
It's been open since the boats stopped.

NELL
One is coming tonight.

EXT. LOCK GATES - NIGHT

A narrowboat glides out of the fog. Its pilot, PIP, a wiry ferryman's apprentice in a borrowed cap, raises a hand.

PIP
Is this the way to the sea?

AUGUST
Every way is, in the end.

EXT. LOCK GATES - LATER

Nell and August lean on the beam. The water rises, and the boat lifts into the lantern light.

NELL
Go on, then.
`;

const fakeModel = (text: string | (() => never)): CrewModel & {calls: number; prompts: string[]} => {
  const model = {name: "openrouter" as const, model: "openrouter:anthropic/claude-sonnet-5.5", calls: 0, prompts: [] as string[],
    async complete(request: {messages: {content: string}[]}) {
      model.calls++; model.prompts.push(request.messages[0]!.content);
      if (typeof text === "function") text();
      return {text: text as string, usage: {inputTokens: 10, outputTokens: 10}, model: "openrouter:anthropic/claude-sonnet-5.5", costUsd: 0};
    }};
  return model;
};
const answer = (notes: unknown[]) => JSON.stringify({notes});

describe("the crew answers with line numbers, and the studio quotes the line", () => {
  /**
   * The exit run's likeliest loss: a note whose quoted line wasn't byte-exact. The model now names the
   * line by number; `before` comes from the script, so a smart-quoted, cue-prefixed, re-spaced or
   * missing quote no longer loses the note, and the accepted note applies byte for byte.
   */
  test("a note quoted with smart quotes, its cue, other spacing or no quote at all is kept, and applies byte-exactly", () => {
    const read = validateLineNotes(answer([
      {persona: "director", line: 7, before: "MAYA: “You came back.”", after: "You’re back.", reason: "Shorter."},
      {persona: "Editor", line: "16", after: "I stayed.", reason: "Plainer."},
      {persona: "cinematographer", line: 3, before: "maya   pours tea while the kettle whistles", after: "3| Maya pours tea. The kettle screams.", reason: "Sharper."},
    ]), SCRIPT);
    expect(read.dropped).toBe(0);
    expect(read.notes.map(note => [note.id, note.persona, note.line, note.before, note.after])).toEqual([
      ["n1", "director", 7, "You came back.", "You’re back."],
      ["n2", "editor", 16, "I never left.", "I stayed."],
      ["n3", "cinematographer", 3, "Maya pours tea while the kettle whistles.", "Maya pours tea. The kettle screams."],
    ]);
    const {text} = applyLineNotes(script, {script: scriptRef(script), notes: read.notes}, ["n1", "n2", "n3"]);
    expect(text).toBe(SCRIPT.replace("  You came back.\r\n", "  You’re back.\r\n").replace("I never left.\r\n", "I stayed.\r\n")
      .replace("Maya pours tea while the kettle whistles.  \r\n", "Maya pours tea. The kettle screams.  \r\n"));
  });

  /** The prompt lists the lines a note may change by number and marks the rest, and says which scene is the last. */
  test("the crew is shown only the lines it may change, numbered, with the scenes marked", () => {
    const {system, user} = lineNotesPrompt(SCRIPT, {request: "tighten the last scene"});
    expect(system).toContain('"line": number, "after": string, "reason": string');
    expect(system).not.toContain('"before"');
    expect(user).toContain("tighten the last scene");
    for (const [number, raw] of [[3, "Maya pours tea while the kettle whistles.  "], [7, "  You came back."], [16, "I never left."]] as const)
      expect(user).toContain("\n" + number + "| " + raw + "\n");
    for (const raw of ["INT. KITCHEN - DAY", "MAYA", "(quietly)", "CUT TO:", "Leo stands in the rain. /* cut this */", "LEO"])
      expect(user).toContain("\n-| " + raw + "\n");
    expect(user).toContain("== Scene 1 of 2 ==\n-| INT. KITCHEN - DAY");
    expect(user).toContain("== Scene 2 of 2, the last scene ==\n-| EXT. GARDEN - NIGHT");
  });
});

describe("a note that can't be used is counted under its reason", () => {
  /** One note for each reason, and thirteen more past the limit: each is counted once, under its own code, and none of their text is kept. */
  test("every dropped note is counted under a fixed reason code", () => {
    const good = (line: number, after: string) => ({persona: "editor", line, after, reason: "Better."});
    const read = validateLineNotes(answer([
      good(99, "Nowhere."), good(2, "A blank line."), {...good(7, "Back."), before: "I never left."},
      good(5, "LEO"), good(1, "INT. HALL - DAY"), good(6, "(loudly)"), good(9, "SMASH CUT TO:"), good(13, "Leo stands alone."),
      good(16, "I never left."),
      good(3, "x".repeat(1001)), {...good(3, "Fine."), reason: "y".repeat(301)},
      good(16, "INT. CAR - DAY"),
    ]), SCRIPT);
    expect(read.notes).toEqual([]);
    expect(read.droppedReasons).toEqual({unknown_line: 3, locked_line: 5, unchanged: 1, too_long: 2, element_change: 1});
    expect(read.dropped).toBe(12);
    const more = validateLineNotes(answer([
      good(7, "You sound like Taylor Swift."), {...good(3, "Maya pours tea."), reason: "As Taylor Swift would."},
      good(16, "I stayed."), good(16, "I waited."), good(7, "Back.\nLEO"),
      {persona: "stranger", line: 3, after: "Tea.", reason: "x"}, "line 3: Tea.", {line: 3, after: "Tea."}, good(3, "Tea. [[fix]]"),
      good(7, "Back."), good(3, "Tea is poured."), good(3, "Again."), good(7, "Again."), good(16, "Again."), good(3, "Again."),
    ]), SCRIPT);
    expect(more.notes.map(note => [note.line, note.after])).toEqual([[16, "I stayed."], [7, "Back."], [3, "Tea is poured."]]);
    expect(more.droppedReasons).toEqual({gate_refused: 2, duplicate: 2, element_change: 1, malformed: 4, too_many: 3});
    expect(more.dropped).toBe(12);
    expect(JSON.stringify(more)).not.toContain("Taylor");
    expect(Object.keys(more.droppedReasons).every(code => (LINE_NOTE_DROP_REASONS as readonly string[]).includes(code))).toBe(true);
  });

  /** A note on a cue, heading, parenthetical, transition or boneyard line is refused as locked, and so is one in the script's hidden lines. */
  test("locked lines are refused, never changed", () => {
    for (const line of [1, 5, 6, 9, 11, 13, 15])
      expect(validateLineNotes(answer([{persona: "editor", line, after: "Changed.", reason: "x"}]), SCRIPT)).toEqual({notes: [], dropped: 1, droppedReasons: {locked_line: 1}});
  });

  /**
   * When the crew offered notes and none survived, the writer is told so with the commonest reason
   * in the studio's words, never the model's; an empty list is told as the crew suggesting none.
   */
  test("a live answer with no usable notes says so plainly, with the commonest reason", async () => {
    const run = async (text: string) => runLineNotes({script, input: {request: "tighten"}, projectId: "p", model: fakeModel(text), ledger: new CrewLedger()});
    const locked = await run(answer([{persona: "editor", line: 5, after: "LEO", reason: "Swap."}, {persona: "editor", line: 1, after: "INT. HALL - DAY", reason: "Move."},
      {persona: "editor", line: 16, after: "You sound like Taylor Swift.", reason: "Star."}]));
    expect(locked).toMatchObject({source: "openrouter", notes: [], dropped: 3, droppedReasons: {locked_line: 2, gate_refused: 1}});
    expect(locked.message).toBe("The crew suggested 3 line notes, but none could be used. The most common reason, for 2 of them: it named a line the crew doesn't change "
      + "(a heading, a character cue, a parenthetical, a transition, or a line holding a note or boneyard). Your script is unchanged.");
    expect(JSON.stringify(locked)).not.toContain("Taylor");
    const one = await run(answer([{persona: "editor", line: 16, after: "I never left.", reason: "Same."}]));
    expect(one.message).toBe("The crew suggested 1 line note, but it couldn't be used: it left the line as it is. Your script is unchanged.");
    const none = await run(answer([]));
    expect(none).toMatchObject({source: "openrouter", notes: [], dropped: 0, droppedReasons: {}});
    expect(none.message).toBe("The crew read the script and has no line changes to suggest. Your script is unchanged.");
    expect(none.unusableReason).toBeUndefined();
    const some = await run(answer([{persona: "editor", line: 16, after: "I stayed.", reason: "Plainer."}, {persona: "editor", line: 5, after: "LEO", reason: "Swap."}]));
    expect(some).toMatchObject({notes: [{line: 16}], dropped: 1, droppedReasons: {locked_line: 1}});
    expect(some.message).toBe("The crew has 1 line note. Take the ones you want; nothing changes until you apply them.");
  });
});

describe("the answer is read in any of the shapes a model gives it", () => {
  const notes = [{persona: "editor", line: 16, after: "I stayed.", reason: "Plainer."}, {persona: "director", line: 7, after: "Back.", reason: "Shorter."}];
  /** A bare array, a `{notes}` object, either in a code fence, or with prose around it, all give the same notes. */
  test("a bare array, an object, a code fence or prose around them are all read", () => {
    const one = [{persona: "editor", line: 16, after: "I stayed.", reason: "Plainer."}];
    for (const text of [JSON.stringify(notes), answer(notes), "```json\n" + answer(notes) + "\n```", "```\n" + JSON.stringify(notes) + "\n```",
      "Here are the notes:\n" + JSON.stringify(notes) + "\nHope these help.", "Sure {see below}.\n```json\n" + answer(notes) + "\n```\nDone."])
      expect(validateLineNotes(text, SCRIPT).notes.map(note => note.line)).toEqual([16, 7]);
    // A single note in a bare array, with prose before it, is still a list.
    expect(readLineNotesAnswer("Notes: " + JSON.stringify(one))).toEqual(one);
  });

  /** An answer with no JSON, or JSON that holds no list of notes, is reported as unusable with its reason, never as "no notes". */
  test("an unreadable answer is reported as unusable with its reason, and still metered", async () => {
    const reasonOf = (text: string) => { try { readLineNotesAnswer(text); return null; } catch (error) { return error instanceof CrewAnswerUnusable ? error.reason : "other"; } };
    expect(reasonOf("I think line 7 could be better.")).toBe("no_json");
    expect(reasonOf("{\"notes\": [")).toBe("no_json");
    expect(reasonOf(JSON.stringify({notes: "none"}))).toBe("bad_shape");
    expect(reasonOf("null")).toBe("bad_shape");
    const ledger = new CrewLedger(), run = (model: CrewModel) => runLineNotes({script, input: {request: ""}, projectId: "p", model, ledger});
    const prose = await run(fakeModel("I think line 7 could be better."));
    expect(prose).toMatchObject({source: "stand-in", fallbackReason: "model_unusable", unusableReason: "no_json", notes: [], dropped: 0, droppedReasons: {}});
    expect(prose.message).toBe("The crew's answer couldn't be used: it wasn't the list of notes the studio asked for, so there are no line notes. Your script is unchanged.");
    expect(prose.message).not.toContain("line 7");
    const object = await run(fakeModel(JSON.stringify({comment: "The script is fine."})));
    expect(object).toMatchObject({fallbackReason: "model_unusable", unusableReason: "bad_shape"});
    expect(object.message).not.toContain("fine");
    // The adapter's own "billed but unusable" keeps the vendor's code from HV-030-25's vocabulary, and its spend is kept.
    const cut = await run(fakeModel(() => { throw new CrewModelUnusable("cut off", {text: "", usage: {inputTokens: 5, outputTokens: 4000}, model: "openrouter:anthropic/claude-sonnet-5.5", costUsd: 0.04}, "cut_off"); }));
    expect(cut).toMatchObject({source: "stand-in", fallbackReason: "model_unusable", unusableReason: "cut_off", crewSpend: {usd: 0.04}});
    expect(cut.message).toBe("The crew's answer couldn't be used: the crew model's reply was cut off at its length limit, so there are no line notes. Your script is unchanged.");
    expect(ledger.summary().spentUsd).toBe(0.04);
  });
});

describe("film A's last scene, as the exit run asked", () => {
  /**
   * The exit run's request on its own script, answered the way a live model plausibly answers: in a
   * fence, quoting the line with its cue and curly quotes, and with one note on the cue itself. The
   * dialogue note survives and applies; the cue note is counted as locked.
   */
  test("a plausible answer to 'Tighten the dialogue in the last scene' gives a note the writer can apply", async () => {
    const film = {version: 1, text: FILM_A};
    const model = fakeModel("Here are my notes on the last scene.\n```json\n" + answer([
      {persona: "director", line: 36, before: "NELL: “Go on, then.”", after: "Go on.", reason: "Fewer words; the image carries the farewell."},
      {persona: "editor", line: 33, after: "Nell and August lean on the beam. The water lifts the boat into the lantern light.", reason: "One beat, not two."},
      {persona: "casting", line: 35, after: "AUGUST", reason: "Give August the last word."},
    ]) + "\n```");
    const result = await runLineNotes({script: film, input: {request: "Tighten the dialogue in the last scene"}, projectId: "p", model, ledger: new CrewLedger()});
    expect(model.prompts[0]).toContain("== Scene 4 of 4, the last scene ==\n-| EXT. LOCK GATES - LATER");
    expect(model.prompts[0]).toContain("\n36| Go on, then.");
    expect(model.prompts[0]).toContain("\n-| NELL\n36|");
    expect(result).toMatchObject({source: "openrouter", dropped: 1, droppedReasons: {locked_line: 1}});
    expect(result.notes.length).toBeGreaterThanOrEqual(1);
    expect(result.notes[0]).toMatchObject({id: "n1", line: 36, before: "Go on, then.", after: "Go on."});
    const {text} = applyLineNotes(film, {script: result.script, notes: result.notes}, ["n1"]);
    expect(text).toBe(FILM_A.replace("NELL\nGo on, then.\n", "NELL\nGo on.\n"));
  });
});
