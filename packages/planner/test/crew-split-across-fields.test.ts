/**
 * HV-031-14 — a brand split across two of the creator's fields reached the crew model.
 *
 * The crew routes gate a request's fields together, joined with "\n": the plan step's tone and
 * answers (HV-030-21), a style card's fields (HV-030-19), and the read-through's tone beside a card.
 * Several of the gate's rules spell the gap between two words as a space (`harry potter`, `(a|an|the)
 * famous (actor|…)`), and a space never matched the "\n" the join put there. So a proposal ending on
 * "Harry" and a reply starting on "Potter" each passed alone, passed together, and were sent to the
 * model side by side. The gate now reads every whitespace run as one space (packages/safety), so
 * these joins are left as they are and the split is refused.
 */
import {expect, test} from "bun:test";
import {checkPrompt} from "../../safety/src/index";
import {planInput} from "../src/crew/production-plan";
import {readThroughInput} from "../src/crew/read-through";
import {STYLE_CARD_SCHEMA, styleCardInput} from "../src/crew/style-card";

const HALF = "Score it like the theme from Harry", OTHER_HALF = "Potter, swelling strings over the titles.";
const card = (fields: {tone?: string; look?: string}) => ({schema: STYLE_CARD_SCHEMA, format: "reel", tone: fields.tone ?? "", look: fields.look ?? "", choices: []});

test("the halves of the split each pass the gate alone", () => {
  expect(checkPrompt(HALF).allowed).toBe(true);
  expect(checkPrompt(OTHER_HALF).allowed).toBe(true);
  expect(checkPrompt(HALF + " " + OTHER_HALF)).toMatchObject({allowed: false, category: "trademark_brand"});
});

test("the plan step refuses a brand split between a proposal and its reply, with nothing sent", () => {
  const answer = (proposal: string, reply: string) => ({id: "q1", persona: "sound", question: "Music?", proposal, accepted: false, reply});
  expect(() => planInput({format: "reel", tone: "Warm.", answers: [answer(HALF, "Keep it quiet.")]})).not.toThrow();
  expect(() => planInput({format: "reel", tone: "Warm.", answers: [answer("A light score.", OTHER_HALF)]})).not.toThrow();
  expect(() => planInput({format: "reel", tone: "Warm.", answers: [answer(HALF, OTHER_HALF)]})).toThrow("nothing was sent to the crew");
  // And a real person split between the tone and the first question.
  expect(() => planInput({format: "reel", tone: "Cast a famous", answers: [{id: "q1", persona: "director", question: "actor in the lead?", proposal: "No.", accepted: true}]}))
    .toThrow("nothing was sent to the crew");
});

test("a style card refuses a brand split between its tone and its look", () => {
  expect(() => styleCardInput(card({tone: HALF}))).not.toThrow();
  expect(() => styleCardInput(card({look: OTHER_HALF}))).not.toThrow();
  expect(() => styleCardInput(card({tone: HALF, look: OTHER_HALF}))).toThrow("Nothing was sent to the crew");
});

test("the read-through refuses a brand split between the tone and the attached card, with nothing sent", () => {
  expect(readThroughInput({format: "reel", tone: HALF}).tone).toBe(HALF);
  expect(readThroughInput({format: "reel", tone: "Quiet.", styleCard: card({tone: OTHER_HALF})}).styleCard?.tone).toBe(OTHER_HALF);
  expect(() => readThroughInput({format: "reel", tone: HALF, styleCard: card({tone: OTHER_HALF})})).toThrow("nothing was sent to the crew");
});
