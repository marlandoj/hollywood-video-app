/**
 * HV-025-03: the Editor titles the film. Pure helpers, so the studio's choices are testable
 * without a browser: the film's title, the credit rows, the two motion-graphic plans (an
 * opening title over the first seconds, closing credits after the last frame) and the one
 * timeline operation that lays them into a picture edit of the finished cut. The creator
 * fills in nothing; everything here comes from the script, the read-through and what the
 * crew actually did.
 */
// HV-021-09: the Continuity Supervisor speaks in the plan's notes, under its own title. It is credited
// only for a film it actually checked (`creditRows`' `continuity`), never as one of the crew by default.
export const PERSONA_TITLES = {producer: "Producer", director: "Director", casting: "Casting", cinematographer: "Cinematographer", sound: "Composer and Sound", editor: "Editor", continuity: "Continuity Supervisor"};
const PERSONA_ROLES = {producer: "Produced by", director: "Directed by", casting: "Casting by", cinematographer: "Cinematography by", sound: "Sound by", editor: "Edited by"};
const CREDITED_ALWAYS = Object.keys(PERSONA_ROLES);

/**
 * HV-021-09: the Supervisor checked this film when the plan answered with its notes from the
 * continuity report and that report could make at least one comparison. "Nothing to compare yet"
 * earns no credit, and a film whose plan was not retained (a resumed one) has nothing to show it.
 */
export function continuityChecked(plan) {
  return Boolean(plan && Number(plan.continuityComparisons) > 0
    && Array.isArray(plan.notes) && plan.notes.some(note => note?.persona === "continuity" && note.source === "continuity-report"));
}

export const TITLE_FRAMES = 120, CREDITS_FRAMES = 180, TITLE_MAX = 80, NAME_MAX = 60;
export const TITLE_GRAPHIC_ID = "crew-title", CREDITS_GRAPHIC_ID = "crew-credits";
export const TITLE_CLIP_ID = "crew-title", CREDITS_CLIP_ID = "crew-credits", CREDITS_MUSIC_CLIP_ID = "crew-credits-music";

// Hidden and control characters are refused by the graphic renderer; Fountain emphasis marks are not text.
const clean = value => String(value ?? "").replace(/[\p{Cc}\p{Cs}\p{Cf}]/gu, " ").replace(/[*_]+/g, "").replace(/\s+/g, " ").trim();
/** Shortens at a word boundary when one is near, and marks the cut. */
export function shorten(text, max) {
  const value = clean(text);
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1), space = cut.lastIndexOf(" ");
  return (space >= max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "") + "…";
}

/** The Fountain title page: the leading `Key: value` block, with indented continuation lines. */
export function titlePage(script) {
  const lines = String(script ?? "").replace(/^\uFEFF/, "").split(/\r?\n/), fields = {};
  if (!/^[A-Za-z][A-Za-z ]*:/.test(lines[0] ?? "")) return fields;
  let key = null;
  for (const line of lines) {
    if (!line.trim()) break;
    const field = /^([A-Za-z][A-Za-z ]*):\s*(.*)$/.exec(line);
    if (field && !/^\s/.test(line)) { key = field[1].trim().toLowerCase(); fields[key] = clean(field[2]); }
    else if (key && /^(\s{3,}|\t)/.test(line)) fields[key] = clean(`${fields[key]} ${line}`);
    else break;
  }
  return fields;
}

export function filmTitle(script, logline) {
  const page = titlePage(script);
  if (page.title) return shorten(page.title, TITLE_MAX);
  if (clean(logline)) return shorten(logline, TITLE_MAX);
  return "Untitled";
}

export function creditRows({script, voiced = false, scored = false, continuity = false} = {}) {
  const page = titlePage(script), writer = page.author || page.authors || page.credit;
  return [{role: "Written by", name: writer ? shorten(writer, NAME_MAX) : "The creator"},
    ...CREDITED_ALWAYS.map(persona => ({role: PERSONA_ROLES[persona], name: `${PERSONA_TITLES[persona]} (AI crew)`})),
    ...(continuity ? [{role: "Continuity by", name: `${PERSONA_TITLES.continuity} (AI crew)`}] : []),
    ...(voiced ? [{role: "Voices", name: "synthetic (Azure neural voices)"}] : []),
    ...(scored ? [{role: "Original score", name: "Composer (AI crew)"}] : [])];
}

/** A picture size both the graphics and the editorial timeline accept: even, within 1920x1080, at least 64. */
export function frameSize({width, height}) {
  const scale = Math.min(1, 1920 / width, 1080 / height), even = value => Math.max(64, 2 * Math.floor(value * scale / 2));
  return {width: even(width), height: even(height)};
}

function fades(frames) {
  const enterFrames = Math.min(12, Math.floor((frames - 1) / 2));
  return {enterFrames, exitFrames: Math.min(12, frames - 1 - enterFrames)};
}

/**
 * The opening title (about 4 s, transparent, over the picture) and the closing credits (about 6 s,
 * on a dark card, scrolling). Type is sized from the short side so a vertical reel fits too; the
 * title is at most 80 characters and each name at most 60, which fit at these sizes. A film shorter
 * than the title holds the title for the film's length.
 */
export function titlePlans({width, height, title, credits, filmFrames = Infinity}) {
  const short = Math.min(width, height), margin = Math.round(short * 0.08);
  const base = {schema: "hv-motion-graphic/1", width, height, secondary: "", color: "#ffffff", accent: "#d7b46a", align: "center", margin};
  const titleFrames = Math.max(2, Math.min(TITLE_FRAMES, filmFrames));
  return {
    title: {...base, kind: "title", frames: titleFrames, ...fades(titleFrames), text: shorten(title, TITLE_MAX) || "Untitled", credits: [],
      fontSize: Math.max(8, Math.min(Math.floor(height / 3), Math.round(short * 0.07))), background: null},
    credits: {...base, kind: "credits", frames: CREDITS_FRAMES, ...fades(CREDITS_FRAMES), text: shorten(title, TITLE_MAX), background: "#111318",
      credits: credits.slice(0, 20).map(row => ({role: shorten(row.role, 40), name: shorten(row.name, NAME_MAX) || "The creator"})),
      fontSize: Math.max(8, Math.min(Math.floor(height / 3), Math.round(short * 0.05)))},
  };
}

/** Plans compare field by field; the saved spec adds a revision the studio does not compute. */
export function samePlan(saved, plan) {
  return Object.keys(plan).every(key => JSON.stringify(saved?.[key]) === JSON.stringify(plan[key]));
}

const clip = (id, sourceId, lane, layer, at, from, frames, fadeIn = 0, fadeOut = 0) =>
  ({id, sourceId, lane, layer, link: null, at, from, frames, gainDb: 0, opacity: 1, crop: null, envelope: {from, frames, fadeIn, fadeOut}});

/**
 * One timeline insert: the title on the layer above the film from frame 0, and the credits after
 * the film's last frame, rippling the sequence longer by their length. When the cut carries the
 * Composer's music stem (a scored sound mix), a stretch of it plays under the credits, taken after
 * the score's opening fade and before its closing one when the film is long enough, and faded out.
 * Otherwise the credits are silent.
 */
export function titleOperation({film, title, credits}) {
  const clips = [clip(TITLE_CLIP_ID, title.id, "picture", 1, 0, 0, Math.min(title.frames, film.frames)),
    clip(CREDITS_CLIP_ID, credits.id, "picture", 0, film.frames, 0, credits.frames)];
  if (film.audio?.includes("music")) {
    const frames = Math.min(credits.frames, film.frames), from = film.frames >= 60 + frames + 90 ? 60 : 0;
    clips.push(clip(CREDITS_MUSIC_CLIP_ID, film.id, "music", 0, film.frames, from, frames, Math.min(15, Math.floor(frames / 4)), Math.min(45, Math.floor(frames / 2))));
  }
  return {kind: "insert", clips, rippleAt: film.frames, rippleFrames: credits.frames};
}
