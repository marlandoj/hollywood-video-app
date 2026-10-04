/**
 * The studio crew (G13-202609192200). A persona is a role with a department it may
 * change and a voice it speaks in; it is not an engine. Its proposals are applied
 * through the same validated APIs a creator's own edit uses (HV-030-02).
 */
export type PersonaId = "producer" | "director" | "casting" | "cinematographer" | "sound" | "editor";

export interface Persona {
  id: PersonaId;
  title: string;
  /** What this persona owns; used in its prompt and, from HV-030-02, to scope its tools. */
  department: string;
  brief: string;
}

export const PERSONAS: readonly Persona[] = Object.freeze([
  {id: "producer", title: "Producer", department: "scope, format, schedule and budget",
    brief: "Reads the whole script first, says back what the film is, and keeps it inside its format and budget."},
  {id: "director", title: "Director", department: "tone, pacing, performance and the ending",
    brief: "Owns the film's intent. Asks about tone and the moments that must land."},
  {id: "casting", title: "Casting", department: "who plays each character and how they look",
    brief: "Proposes a look for every speaking character; real people only with their consent, never public figures."},
  {id: "cinematographer", title: "Cinematographer", department: "the look: framing, camera movement, light and colour",
    brief: "Proposes a visual style and the few shots that deserve special treatment."},
  {id: "sound", title: "Composer and Sound", department: "music, atmosphere and voices",
    brief: "Proposes a musical direction and the sound of each location."},
  {id: "editor", title: "Editor", department: "the cut: rhythm, length and titles",
    brief: "Proposes pacing and what to trim so the film fits its format."},
].map(persona => Object.freeze(persona)) as Persona[]);

export const PERSONA_IDS: readonly PersonaId[] = Object.freeze(PERSONAS.map(persona => persona.id));

/**
 * HV-021-09: the crew roster is the six personas above, who ask the creator questions and whose
 * words a model may write, and the Continuity Supervisor, who asks nothing and is never a model.
 *
 * The Supervisor is kept out of `PERSONAS` on purpose. That list is the crew the read-through tells
 * the model about and the set of personas a question, an answer or a style-card choice may name;
 * adding it there would invite the model to ask continuity questions in its name and let a creator's
 * answer be attributed to it. It speaks only in the plan's notes, from the continuity report the
 * Director's desk already serves (`./continuity-supervisor.ts`), so `speaks` says where its words
 * come from.
 */
export type CrewMemberId = PersonaId | "continuity" | "showrunner";
export interface CrewMember {
  id: CrewMemberId; title: string; department: string; brief: string;
  /**
   * "questions": asks at the read-through, voice written by the crew model or the stand-in.
   * "continuity-report": deterministic notes only. "sequence-plan": proposes a feature's sequence
   * boundaries, which the studio validates (HV-030-29).
   */
  speaks: "questions" | "continuity-report" | "sequence-plan";
}
export const CONTINUITY_SUPERVISOR: CrewMember = Object.freeze({id: "continuity", title: "Continuity Supervisor",
  department: "what each scene holds from shot to shot: its look, its heading's time, wardrobe and reference images",
  brief: "Reads the studio's continuity report once the plan is applied and says what it found, scene by scene. Asks nothing, proposes nothing, calls no model; repairs are made at the Director's desk.",
  speaks: "continuity-report"} as const);
/**
 * HV-030-29 (Release 3 step 2): the Showrunner splits a feature into sequences of at most 24 shots,
 * the per-render limit, and each sequence is produced like a short. Like the Supervisor it asks no
 * questions, so it is not in `PERSONAS`. Its one tool is a list of sequence boundaries, which the
 * studio validates as it validates a stored plan (`../sequences.ts`); an unusable answer falls back to
 * the stand-in's deterministic greedy split (`./showrunner.ts`).
 */
export const SHOWRUNNER: CrewMember = Object.freeze({id: "showrunner", title: "Showrunner",
  department: "a feature's sequences: where each begins and ends, and the order they are made in",
  brief: "Splits a feature into sequences of consecutive scenes, each at most one render's 24 shots, so each can be made and approved like a short. Never changes the script, the cast or a shot.",
  speaks: "sequence-plan"} as const);
export const CREW: readonly CrewMember[] = Object.freeze([
  ...PERSONAS.map(value => Object.freeze({...value, speaks: "questions" as const})), CONTINUITY_SUPERVISOR, SHOWRUNNER]);
export const QUESTIONS_PER_PERSONA = 3;

export function persona(id: string): Persona {
  const found = PERSONAS.find(value => value.id === id);
  if (!found) throw new Error("Unknown crew member " + JSON.stringify(id) + ".");
  return found;
}
