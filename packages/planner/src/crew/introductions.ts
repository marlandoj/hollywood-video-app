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
  ...["old", "elderly", "aged", "grandmother", "grandfather", "grandma", "grandpa", "granny", "nana"].map(word => [word, "older adult" as const]),
  ...["boy", "girl", "child", "kid", "little"].map(word => [word, "child" as const]),
  ...["teen", "teenage", "teenager"].map(word => [word, "teen" as const]),
  ...["young"].map(word => [word, "young adult" as const]),
]);
const PRONOUNS = new Set(["she", "her", "hers", "herself", "he", "him", "his", "himself"]);
const VOCATIVES = ["grandma", "granny", "nana", "grandmother", "grandpa", "grandfather", "mom", "mum", "mother", "dad", "father"];
const MAX_SENTENCE = 300;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (text: string) => text.toLowerCase().match(/[a-z]+/g) ?? [];
const sentences = (text: string) => text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[^a-z])/);

/** The name as a whole word: in the script's capitals ("NORA") first, then capitalised ("Nora"); never lowercase. */
function nameMatchers(name: string): RegExp[] {
  const capitalised = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  return [...new Set([name, capitalised])].map(form => new RegExp("(?<![A-Za-z])" + escape(form) + "(?![A-Za-z])"));
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
