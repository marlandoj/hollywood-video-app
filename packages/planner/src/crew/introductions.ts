import type { ParseResult } from "../../../parser/src/index";

/**
 * How the script itself introduces each character (HV-017-05), for the stand-in crew's casting.
 *
 * Deterministic and conservative: it quotes the sentence that introduces a name, and reads sex and
 * age only from a fixed table of words right beside the name (an appositive after it, up to three
 * words before it), from a pronoun after it in that sentence, or from a kinship word another
 * character calls them by ("Grandma!"). Conflicting cues leave the attribute unknown. It never
 * invents a look the script does not state.
 */
export type IntroSex = "female" | "male";
export type IntroAge = "child" | "teen" | "young adult" | "older adult";
export interface ScriptIntroduction { name: string; sentence: string | null; sex: IntroSex | null; age: IntroAge | null; addressedAs: string | null; addressedBy: string | null }

const SEX: Record<string, IntroSex> = Object.fromEntries([
  ...["woman", "girl", "grandmother", "grandma", "granny", "nana", "mother", "mom", "mum", "daughter", "granddaughter", "sister", "aunt", "niece", "wife", "widow", "lady", "she", "her", "hers", "herself"].map(word => [word, "female" as const]),
  ...["man", "boy", "grandfather", "grandpa", "father", "dad", "son", "grandson", "brother", "uncle", "nephew", "husband", "widower", "he", "him", "his", "himself"].map(word => [word, "male" as const]),
]);
const AGE: Record<string, IntroAge> = Object.fromEntries([
  ...["old", "older", "elderly", "aged", "grandmother", "grandfather", "grandma", "grandpa", "granny", "nana"].map(word => [word, "older adult" as const]),
  ...["boy", "girl", "child", "kid", "little"].map(word => [word, "child" as const]),
  ...["teen", "teenage", "teenager"].map(word => [word, "teen" as const]),
  ...["young"].map(word => [word, "young adult" as const]),
]);
const PRONOUNS = new Set(["she", "her", "hers", "herself", "he", "him", "his", "himself"]);
const VOCATIVES = ["grandma", "granny", "nana", "grandmother", "grandpa", "grandfather", "mom", "mum", "mother", "dad", "father"];
const MAX_SENTENCE = 300;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// "middle-aged" names no age this table knows; it must not read as "aged" (HV-017-08).
const words = (text: string) => text.toLowerCase().replace(/\bmiddle[- ]aged\b/g, " ").match(/[a-z]+/g) ?? [];
const sentences = (text: string) => text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[^a-z])/);

/**
 * The name as a whole word: in the script's capitals ("NORA") first, then capitalised ("Nora"); never lowercase.
 * Never the second half of another name: ANN is not the end of MARY-ANN or O'ANN (HV-021-12).
 */
function nameMatchers(name: string): RegExp[] {
  const capitalised = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  return [...new Set([name, capitalised])].map(form => new RegExp("(?<![A-Za-z'\u2019-])" + escape(form) + "(?![A-Za-z])"));
}

function merge<T>(values: (T | null)[]): T | null {
  const known = [...new Set(values.filter((value): value is T => value !== null))];
  return known.length === 1 ? known[0]! : null;
}

function cues(sentence: string, match: RegExpExecArray, others: RegExp[]): {sex: (IntroSex | null)[]; age: (IntroAge | null)[]; pronoun: IntroSex | null} {
  // "The girl's father, ALEX": a possessive belongs to someone else.
  const before = words(sentence.slice(0, match.index).replace(/[A-Za-z]+['\u2019]s\b/g, " ")).slice(-3);
  const after = sentence.slice(match.index + match[0].length);
  const appositive = /^\s*,\s*((?:a|an|the)\s[^,.;!?]{1,60}),/i.exec(after)?.[1] ?? "";
  const near = [...before, ...words(appositive)].filter(word => !PRONOUNS.has(word));
  // "Her grandson TEO": a pronoun before the name belongs to someone else, so only nouns count there.
  let pronoun: IntroSex | null = null;
  if (!others.some(other => other.test(sentence))) pronoun = merge(words(after).filter(word => PRONOUNS.has(word)).map(word => SEX[word]!));
  return {sex: near.map(word => SEX[word] ?? null), age: near.map(word => AGE[word] ?? null), pronoun};
}

export function scriptIntroductions(parsed: ParseResult, names: string[]): ScriptIntroduction[] {
  const matchers = new Map(names.map(name => [name, nameMatchers(name)]));
  return names.map(name => {
    const others = names.filter(other => other !== name).flatMap(other => matchers.get(other)!);
    let found = false, sentence: string | null = null, sex: (IntroSex | null)[] = [], age: (IntroAge | null)[] = [], pronoun: IntroSex | null = null;
    for (const matcher of matchers.get(name)!) for (const scene of parsed.scenes) {
      if (found) break;
      for (const paragraph of scene.action) {
        for (const candidate of sentences(paragraph)) {
          const match = matcher.exec(candidate);
          if (!match) continue;
          if (candidate.length <= MAX_SENTENCE) sentence = candidate;
          ({sex, age, pronoun} = cues(candidate, match, others));
          found = true; break;
        }
        if (found) break;
      }
      if (found) break;
    }
    // A kinship word that another character opens a line with, in a scene where only the two of them speak.
    let addressedAs: string | null = null, addressedBy: string | null = null;
    for (const scene of parsed.scenes) {
      const speakers = [...new Set(scene.dialogue.map(block => block.character.toUpperCase()))];
      if (speakers.length !== 2 || !speakers.includes(name.toUpperCase())) continue;
      for (const block of scene.dialogue) {
        if (block.character.toUpperCase() === name.toUpperCase()) continue;
        const opening = /^\s*([A-Za-z]+)\s*[!,.?]/.exec(block.lines.join(" "))?.[1]?.toLowerCase();
        if (opening && VOCATIVES.includes(opening)) { addressedAs = opening.charAt(0).toUpperCase() + opening.slice(1); addressedBy = block.character.toUpperCase(); break; }
      }
      if (addressedAs) break;
    }
    const vocative = addressedAs?.toLowerCase() ?? null;
    const nounSex = merge([...sex, vocative ? SEX[vocative] ?? null : null]);
    return {name, sentence, addressedAs, addressedBy,
      sex: nounSex ?? (sex.some(value => value) ? null : pronoun),
      age: merge([...age, vocative ? AGE[vocative] ?? null : null])};
  });
}

/** An age the script does not give is left to it, not guessed as "adult". */
export const UNSTATED_AGE = "not stated in the script";

const LEADS: Record<string, string> = {
  "female|older adult": "An older woman.", "male|older adult": "An older man.", "|older adult": "An older person.",
  "female|child": "A girl.", "male|child": "A boy.", "|child": "A child.",
  "female|teen": "A teenage girl.", "male|teen": "A teenage boy.", "|teen": "A teenager.",
  "female|young adult": "A young woman.", "male|young adult": "A young man.", "|young adult": "A young adult.",
  "female|": "A female character.", "male|": "A male character.", "|": "",
};

/** The stand-in's casting text for one introduction: a plain lead, then the script's own words. */
export function introductionAppearance(intro: ScriptIntroduction): {lead: string; full: string; ageRange: string} {
  const lead = LEADS[(intro.sex ?? "") + "|" + (intro.age ?? "")] ?? "";
  const object = intro.sex === "female" ? "her" : intro.sex === "male" ? "him" : "them";
  const quoted = intro.sentence ? " As the script introduces " + object + ": “" + intro.sentence + "”" : "";
  const called = intro.addressedAs && intro.addressedBy ? " " + intro.addressedBy + " calls " + object + " " + intro.addressedAs + "." : "";
  return {lead, full: (lead + quoted + called).trim(), ageRange: intro.age ?? UNSTATED_AGE};
}

/**
 * HV-021-12: the costume the script itself puts on a character, for the stand-in crew's wardrobe.
 *
 * The stand-in used to give every character "Everyday clothes that suit the scene.", which tells each shot to
 * choose its own clothes. "The Tide Clock" was reviewed with a character's trousers changing colour and a cap
 * coming and going between scenes, while its script dressed WREN in a mustard scarf and a leather apron and
 * MARISOL in a yellow oilskin and a captain's cap. This reads that, and invents nothing. The answer becomes the
 * character's wardrobe in every shot, so a wrong one is worse than none: when in doubt it reads nothing, the
 * wardrobe stays unstated and the continuity report asks the creator to state it.
 *
 * Only the sentence that introduces the name counts, and only when the name is its subject (in its first few
 * words, not "Nora's brother"). In it, walking the comma-set parts after the name:
 * - "in ...", "wearing ..." or "dressed in ..." ("NORA, in a red coat, ..."; "..., wearing a blue cardigan");
 * - the character's own description with a costume ("WREN, an apprentice clockmaker in a mustard scarf ...");
 * - "wears ..." right after the name or its description ("NORA, a cook, wears a red coat").
 * The walk stops at the first part that names another character or person ("watches TOM", "helps a child",
 * "who wears"), so their clothes are never read as this character's. The next sentence of that paragraph counts
 * only when it starts with the name, or with the pronoun the introduction gives them (none when their sex is
 * unknown), goes straight to "wears", and the two sentences name nobody else: "She wears a yellow oilskin ...".
 *
 * A costume is a list of items ("a coat, a hat and boots"), each one ending in a garment from {@link GARMENTS}
 * ("a blue knitted cap", but not "a hat shop", "the pockets of her coat" or "the kitchen in a white apron"); it
 * ends at the first item that isn't one ("a red coat and stirs the pot" is "a red coat").
 */
export const GARMENTS = new Set(["apron", "anorak", "bathrobe", "beanie", "beret", "blazer", "blouse", "bonnet", "boots", "boot", "cap", "cape",
  "cardigan", "cassock", "cloak", "coat", "coveralls", "dress", "dungarees", "gloves", "gown", "headscarf", "heels", "helmet", "hijab", "hood",
  "hoodie", "jacket", "jeans", "jersey", "jumper", "kilt", "kimono", "leggings", "mac", "oilskin", "oilskins", "overalls", "overcoat", "pants",
  "parka", "poncho", "pullover", "pyjamas", "pajamas", "raincoat", "robe", "robes", "sandals", "sari", "scarf", "scrubs", "shawl", "shirt",
  "shoes", "shorts", "skirt", "slacks", "slicker", "smock", "sneakers", "socks", "suit", "sweater", "sweatshirt", "tie", "tights", "tracksuit",
  "trainers", "trousers", "tunic", "turban", "uniform", "vest", "waistcoat", "wellingtons", "wellies", "hat"]);
/** Words for a person who isn't the character: a part that names one stops the walk. */
const PEOPLE = new Set([...Object.keys(SEX).filter(word => !PRONOUNS.has(word)), "child", "kid", "baby", "people", "person", "someone",
  "somebody", "stranger", "strangers", "crowd", "porter", "guard", "officer", "friend", "friends", "neighbour", "neighbor", "customer",
  "passenger", "passengers", "men", "women", "children", "boys", "girls", "they", "them", "who", "whom", "whose", "that", "which"]);
const MAX_COSTUME = 300;
const ARTICLE = /^(?:a|an|the)\s/i;
const OPENER = /^(?:a|an|the|his|her|their)\s/i;
const COSTUME_LEAD = /^(?:in|wearing|dressed in)\s+(.+)$/i;
const WEARS_LEAD = /^(?:wears|is wearing|is dressed in)\s+(.+)$/i;
const costume = (phrase: string) => { const text = phrase.replace(/\s+/g, " ").trim(); return text.charAt(0).toUpperCase() + text.slice(1) + "."; };

/** One item of a costume: it starts with an article, a possessive or a garment, and its head is a garment. */
function costumeItem(text: string, openers: RegExp): boolean {
  const head = text.trim().split(/\s+with\s+/i)[0]!, list = words(head);
  if (!list.length || /\s(?:of|in|on|at|from|for|to)\s/i.test(" " + head + " ")) return false;
  return (openers.test(head.trim()) || GARMENTS.has(list[0]!)) && GARMENTS.has(list[list.length - 1]!);
}

/** The costume items at the start of a phrase, and whether every part of it was one (so a list may go on). */
function costumeItems(phrase: string, openers: RegExp): {items: string[]; whole: boolean} {
  const text = phrase.split(/\s(?:--|\u2014|\u2013)\s?|\u2014|[:(;]/)[0]!;
  const items: string[] = [];
  for (const [index, part] of text.split(/\s+and\s+/i).entries()) {
    if (!costumeItem(part, index ? OPENER : openers)) return {items, whole: false};
    items.push(part.trim());
  }
  return {items, whole: text.length === phrase.length && items.length > 0};
}

export function introductionWardrobe(parsed: ParseResult, intro: ScriptIntroduction, names: string[]): string | null {
  const matchers = nameMatchers(intro.name);
  const others = names.filter(other => other !== intro.name).flatMap(other => nameMatchers(other));
  const pronoun = intro.sex === "female" ? "she" : intro.sex === "male" ? "he" : null;
  // "her late husband's coat": a possessive only says whose the thing is, so it names nobody here.
  const namesSomeoneElse = (text: string) => others.some(other => other.test(text))
    || words(text.replace(/[A-Za-z]+['\u2019]s\b/g, " ")).some(word => PEOPLE.has(word));
  for (const matcher of matchers) for (const scene of parsed.scenes) for (const paragraph of scene.action) {
    const list = sentences(paragraph);
    const at = list.findIndex(candidate => matcher.test(candidate));
    if (at < 0) continue;
    const sentence = list[at]!, match = matcher.exec(sentence)!;
    // The character must be the subject: named in the sentence's first few words, and not as "Nora's".
    const lead = sentence.slice(0, match.index);
    let after = sentence.slice(match.index + match[0].length);
    if (/[,;:]/.test(lead) || words(lead).length > 3 || namesSomeoneElse(lead) || /^['\u2019]s\b/.test(after)) return null;
    // "WREN ALDER, ...": the rest of a name in capitals belongs to the name; so does "(60s)".
    after = after.replace(/^(?:\s+[A-Z][A-Z'\u2019-]+)+(?=\s*[,(])/, "").replace(/^\s*\([^)]{0,30}\)/, "");
    const found: string[] = [];
    let clean = true, open = false;
    const take = (phrase: string, openers: RegExp) => { const {items, whole} = costumeItems(phrase, openers); found.push(...items); open = whole; };
    for (const [index, raw] of after.split(",").entries()) {
      const part = raw.replace(/[.!?]+$/, "").trim();
      if (!part) { open = false; continue; }
      if (open) {
        // "a coat, a hat and boots": the list goes on while each part is costume and nothing else.
        const {items, whole} = costumeItems(part, OPENER);
        if (items.length && items.join(" and ").length === part.length) { found.push(...items); open = whole; continue; }
        open = false;
      }
      const costumed = COSTUME_LEAD.exec(part)?.[1];
      if (costumed && index > 0) { take(costumed, OPENER); continue; }
      const worn = WEARS_LEAD.exec(part)?.[1];
      if (worn) { if (namesSomeoneElse(part)) { clean = false; break; } take(worn, OPENER); continue; }
      // Their own description, which may carry the costume: "a ferryman's son in a blue knitted cap".
      if (index > 0 && ARTICLE.test(part) && !others.some(other => other.test(part))) {
        const described = /^(?:a|an|the)\s[^,]*?\s(?:in|wearing|dressed in)\s+(.+)$/i.exec(part)?.[1];
        if (described) take(described, ARTICLE);
        continue;
      }
      // Any other part carries the verb ("runs along the harbour wall"), or is a plain description
      // ("neat and tired"). Once it names someone else, nothing after it is theirs.
      if (namesSomeoneElse(part)) { clean = false; break; }
    }
    // The next sentence, when it is about this character and the two sentences name nobody else.
    const next = list[at + 1]?.replace(/[.!?]+$/, "");
    if (next && clean && !namesSomeoneElse(after.replace(/^\s*,\s*(?:a|an|the)\s[^,]*,/i, ""))) {
      const own = matchers.map(form => form.exec(next)).find(hit => hit?.index === 0);
      const subject = own && !/^['\u2019]s\b/.test(next.slice(own[0].length)) ? own[0] : pronoun && words(next)[0] === pronoun ? next.split(/\s/)[0]! : null;
      const worn = subject ? WEARS_LEAD.exec(next.slice(subject.length).trim())?.[1] : undefined;
      if (worn && !others.some(other => other.test(next))) found.push(...costumeItems(worn, OPENER).items);
    }
    if (!found.length) return null;
    const text = costume(found.join(", ").replace(/, ([^,]*)$/, " and $1"));
    return text.length <= MAX_COSTUME ? text : null;
  }
  return null;
}
