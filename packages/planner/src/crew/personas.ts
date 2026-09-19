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
export const QUESTIONS_PER_PERSONA = 3;

export function persona(id: string): Persona {
  const found = PERSONAS.find(value => value.id === id);
  if (!found) throw new Error("Unknown crew member " + JSON.stringify(id) + ".");
  return found;
}
