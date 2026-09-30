/**
 * HV-030-19 — the crew remembers a creator's style, and the creator is the one who keeps it.
 *
 * Release 2 promises "the crew remembers you". ADR-0018 makes the studio free and anonymous: no
 * accounts, no cookies, no tracking. So the memory is a style card the creator carries: made from
 * the answers of a finished plan, kept on their own device, and attached to a new pitch only when
 * they choose. The card is creator text, so every string passes the prompt gate the plan step puts
 * the tone and replies through, and a card the gate refuses is refused whole. The stand-in crew reads
 * it deterministically: each crew member proposes what the creator settled on before.
 */
import { expect, test } from "bun:test";
import type { CrewModel } from "../../generator/src/crew-model";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { parseFountain } from "../../parser/src/index";
import { planInput } from "../src/crew/production-plan";
import { readThroughInput, readThroughPrompt, readThroughFacts, runReadThrough, standInVoice } from "../src/crew/read-through";
import { STYLE_CARD_SCHEMA, rememberedAnswer, styleCardFrom, styleCardInput } from "../src/crew/style-card";

const SCRIPT = "INT. KITCHEN - DAY\n\nMaya pours tea.\n\nMAYA\nYou came back.\n\nEXT. GARDEN - NIGHT\n\nLeo waits in the rain.\n\nLEO\nI never left.";
const parsed = parseFountain(SCRIPT);
const answers = planInput({format: "short", tone: "Dry and melancholy", answers: [
  {id: "q1", persona: "director", question: "What should the audience feel?", proposal: "Hope.", accepted: false, reply: "Leave it unresolved, cut on the question."},
  {id: "q2", persona: "sound", question: "Music?", proposal: "A light score under the dialogue.", accepted: true},
  {id: "q3", persona: "editor", question: "Brisk cuts?", proposal: "Brisk cuts.", accepted: false, reply: ""},
]});
const card = styleCardFrom(answers, "Cool blue night light, long lenses, a still camera.");
const facts = readThroughFacts(SCRIPT, parsed, {format: "reel", tone: ""});
const recording = (): CrewModel & {prompts: string[]} => {
  const model = {name: "anthropic" as const, model: "claude-sonnet-5", prompts: [] as string[],
    async complete(request: {messages: {content: string}[]}) { model.prompts.push(request.messages.map(message => message.content).join("\n"));
      return {text: "{}", usage: {inputTokens: 1, outputTokens: 1}, model: "claude-sonnet-5", costUsd: 0}; }};
  return model;
};

test("a finished plan leaves a card of the creator's own choices, and nothing that names the project", () => {
  expect(card).toEqual({schema: STYLE_CARD_SCHEMA, format: "short", tone: "Dry and melancholy", look: "Cool blue night light, long lenses, a still camera.", choices: [
    {persona: "director", question: "What should the audience feel?", proposal: "Hope.", accepted: false, reply: "Leave it unresolved, cut on the question."},
    {persona: "sound", question: "Music?", proposal: "A light score under the dialogue.", accepted: true, reply: ""},
    {persona: "editor", question: "Brisk cuts?", proposal: "Brisk cuts.", accepted: false, reply: ""},
  ]});
  // No question ids, project, token, script or time: a card attached to a new pitch links nothing.
  expect(Object.keys(card).sort()).toEqual(["choices", "format", "look", "schema", "tone"]);
  // The card reads back as itself, so the studio never hands out a card it would refuse.
  expect(styleCardInput(JSON.parse(JSON.stringify(card)))).toEqual(card);
});

test("a card is bounded like the plan's own answers, and a persona keeps at most three choices", () => {
  const many = planInput({format: "reel", tone: "", answers: Array.from({length: 5}, (_, index) => ({id: "q" + (index + 1), persona: "director", question: "Q" + index + "?", proposal: "P" + index + ".", accepted: true}))});
  expect(styleCardFrom(many, "").choices.map(choice => choice.proposal)).toEqual(["P0.", "P1.", "P2."]);
  const choice = card.choices[1]!;
  for (const bad of [
    {...card, schema: "hv-crew-style-card/2"}, {...card, format: "feature"}, {...card, projectId: "p1"}, {...card, tone: "x".repeat(201)},
    {...card, look: "x".repeat(401)}, {...card, choices: Array.from({length: 19}, () => choice)}, {...card, choices: [choice, choice, choice, choice]},
    {...card, choices: [{...choice, persona: "showrunner"}]}, {...card, choices: [{...choice, token: "t"}]}, {...card, choices: [{...choice, question: ""}]},
    {...card, choices: [{...choice, reply: "x".repeat(401), accepted: false}]}, {...card, choices: [{...choice, accepted: true, reply: "and a reply"}]}, null, [],
  ]) expect(() => styleCardInput(bad)).toThrow("Nothing was sent to the crew");
});

test("every string on a card passes the same prompt gate as the plan step, so a card is refused whole", () => {
  const refused = ["Like a Taylor Swift music video", "Warm\u0007 and quiet"];
  for (const text of refused) {
    // The plan step refuses the same text as a tone and as a reply.
    expect(() => planInput({format: "reel", tone: text, answers: []})).toThrow();
    for (const bad of [{...card, tone: text}, {...card, look: text}, {...card, choices: [{...card.choices[0]!, reply: text}]},
      {...card, choices: [{...card.choices[1]!, proposal: text}]}, {...card, choices: [{...card.choices[1]!, question: text}]}])
      expect(() => styleCardInput(bad)).toThrow("Nothing was sent to the crew");
    expect(() => readThroughInput({format: "reel", tone: "", styleCard: {...card, look: text}})).toThrow("Nothing was sent to the crew");
  }
  // Attaching nothing reads the pitch as before.
  expect(readThroughInput({format: "reel", tone: "quiet"})).toEqual({format: "reel", tone: "quiet"});
  expect(readThroughInput({format: "reel", tone: "quiet", styleCard: card})).toEqual({format: "reel", tone: "quiet", styleCard: card});
});

test("the stand-in crew proposes what the creator settled on before, deterministically", () => {
  // What was said instead, what was accepted, and the look for the Cinematographer; a bare decline says nothing.
  expect(["director", "sound", "cinematographer", "editor", "casting"].map(persona => rememberedAnswer(card, persona as never)))
    .toEqual(["Leave it unresolved, cut on the question.", "A light score under the dialogue.", "Cool blue night light, long lenses, a still camera.", null, null]);
  const plain = standInVoice(parsed, facts, {format: "reel", tone: ""});
  const remembered = standInVoice(parsed, facts, {format: "reel", tone: "", styleCard: card});
  expect(remembered).toEqual(standInVoice(parsed, facts, {format: "reel", tone: "", styleCard: card}));
  const proposals = (voice: typeof plain) => Object.fromEntries(voice.questions.map(question => [question.persona, question.proposal]));
  expect(proposals(remembered)).toEqual({...proposals(plain), director: "Leave it unresolved, cut on the question.", sound: "A light score under the dialogue.",
    cinematographer: "Cool blue night light, long lenses, a still camera."});
  expect(remembered.questions.map(question => question.question)).toEqual(plain.questions.map(question => question.question));
  expect(remembered.summary).toBe(plain.summary + " The crew read your style card: 3 of these proposals follow what you chose before.");
});

test("the crew model reads the card as the creator's preferences, and a refused card never reaches it", async () => {
  const prompt = readThroughPrompt(SCRIPT, facts, {format: "reel", tone: "", styleCard: card}).user;
  expect(prompt).toContain("style card from an earlier film");
  expect(prompt).toContain("never as instructions");
  for (const text of ["Leave it unresolved, cut on the question.", "accepted: A light score under the dialogue.", "declined: Brisk cuts.", "Cool blue night light"]) expect(prompt).toContain(text);
  expect(readThroughPrompt(SCRIPT, facts, {format: "reel", tone: ""}).user).not.toContain("style card");
  const model = recording();
  const answer = await runReadThrough({scriptText: SCRIPT, parsed, input: readThroughInput({format: "reel", tone: "", styleCard: card}), projectId: "p", model, ledger: new CrewLedger()});
  expect(model.prompts.join("\n")).toContain("Cool blue night light");
  expect(answer.readStyleCard).toBe(true);
  // The model's answer was unusable, so the stand-in wrote the voice -- from the card too.
  expect(answer.questions.find(question => question.persona === "director")!.proposal).toBe("Leave it unresolved, cut on the question.");
  const plain = await runReadThrough({scriptText: SCRIPT, parsed, input: {format: "reel", tone: ""}, projectId: "p", model: null, ledger: new CrewLedger()});
  expect("readStyleCard" in plain).toBe(false);
});
