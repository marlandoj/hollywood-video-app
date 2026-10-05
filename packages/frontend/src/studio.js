/**
 * The studio front door (HV-030-03, G13). A creator pastes a script, the crew reads it
 * and asks only what matters, and the creator approves three times: the plan and cast,
 * the storyboard and rough cut, and the final film. Everything else is the crew's job.
 * The Director's desk (every detailed panel) stays behind the Advanced switch.
 *
 * `createStudioFlow` is the logic, with the network injected so it can be tested
 * without a browser; `initStudio` draws it. All user and crew text is assigned
 * through DOM properties, never as markup.
 */
import {composeScore, scoreDirection, scoreRecord} from "./score.js";
import {CREDITS_CLIP_ID, CREDITS_GRAPHIC_ID, PERSONA_TITLES, TITLE_GRAPHIC_ID, continuityChecked, creditRows, filmTitle, frameSize, samePlan, titleOperation, titlePlans} from "./titles.js";
export {PERSONA_TITLES};
export const BLOCKING_CONCERNS = ["public_figure", "content_policy", "empty_script"];

/**
 * What the studio is showing, named once (HV-039-04).
 *
 * Every step of the front door rebuilds the whole of the body, so the control the creator pressed
 * stops existing the moment it works. A browser puts focus back at the start of the document when
 * that happens, which is how someone who had just approved the plan found themselves above the page
 * heading, with nothing said and the storyboard several tab stops away.
 *
 * The answer is to move focus onto the new step's heading -- so this table exists to be the heading
 * *and* the thing focus lands on, rather than a second copy of words the renderers wrote inline.
 */
export const STEP_TITLES = {
  pitch: "Bring your script to the studio.",
  questions: "A few questions from the crew",
  look: "Approval 1 of 3: the plan",
  "rough-cut": "Approval 2 of 3: the storyboard and rough cut",
  final: "Approval 3 of 3: your film",
};
/** A pitch the crew refused is still the pitch step, and must not be announced as a fresh start. */
export const BLOCKED_TITLE = "The crew can't make this yet";
/**
 * HV-030-29: a feature the Showrunner split into sequences is approved 1 + 2 x N times (G20): the look
 * once for the whole feature, then each sequence's rough cut and its final, one sequence after
 * another. A reel or a short keeps its three approvals and the titles above, word for word.
 */
export const sequencesOf = state => Array.isArray(state.sequences) && state.sequences.length ? state.sequences : null;
export function stepTitle(state) {
  const sequences = sequencesOf(state);
  if (!sequences || !["look", "rough-cut", "final"].includes(state.step)) return STEP_TITLES[state.step];
  const total = 1 + 2 * sequences.length, number = state.sequence ?? 1, of = `sequence ${number} of ${sequences.length}`;
  if (state.step === "look") return `Approval 1 of ${total}: the plan and the look, once for the whole feature`;
  if (state.step === "rough-cut") return `Approval ${2 * number} of ${total}: ${of}, its storyboard and rough cut`;
  // HV-030-30: the last sequence's film is seen inside the joined feature, so the last approval is the feature's.
  if (state.joined) return `Approval ${total} of ${total}: the whole feature, its ${sequences.length} sequences joined into one film`;
  return `Approval ${2 * number + 1} of ${total}: ${of}, its film`;
}
/**
 * HV-034-02: the short summary of a feature's style bible the front door shows at Approval 1: its look,
 * palette, lighting and lens, and how many characters and locations it holds. Null for a reel or a short.
 */
export function styleBibleSummary(plan) {
  const bible = plan?.styleBible?.bible;
  if (!bible) return null;
  const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return {heading: "The style bible, kept for every sequence",
    lines: [`Look: ${bible.look}`, `Palette: ${bible.palette}`, `Lighting: ${bible.lighting}`, `Lens and framing: ${bible.lens}`,
      `${count(bible.characters.length, "character")} and ${count(bible.locations.length, "location")}, described once for the whole feature.`]};
}
/** The heading of whatever the studio now shows -- which is what the creator has arrived at. */
/**
 * HV-030-30: the join's request key, fixed by the films and graphics it joins (FNV-1a, two seeds), so
 * asking again for the same feature is the same join and never a second one.
 */
export function featureJoinKey(jobIds) {
  const text = jobIds.join(","), hash = seed => {
    let value = seed;
    for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619) >>> 0;
    return value.toString(16).padStart(8, "0");
  };
  return `crew-feature-${hash(2166136261)}${hash(84696351)}`;
}
export const arrivalOf = state => state.step === "pitch" && state.blocked?.length ? BLOCKED_TITLE : stepTitle(state);

/**
 * Ten minutes of waiting for one source check (HV-025-07), on its own clock.
 *
 * Not the render's half-hour: this is the Editor reading a finished film, which is bounded by the
 * film's own length rather than by how long a queue may hold a job. The number was 120 with a
 * comment saying "about ten minutes"; it is ten minutes now, and its interval has a name, so it
 * reads like the three loops below it (HV-022-15).
 */
export const INSPECTION_INTERVAL_MS = 5000;
export const INSPECTION_LIMIT_MS = 10 * 60 * 1000;
const INSPECTION_POLLS = Math.ceil(INSPECTION_LIMIT_MS / INSPECTION_INTERVAL_MS);

/**
 * How long the studio waits on a render that is not getting anywhere.
 *
 * HV-030-08: `pollJob` was `for (;;)` with nothing to end it but a terminal status. A job that
 * never reaches one -- queued with no worker registered, or a saturated queue -- was polled every
 * 1,500 ms for as long as the tab stayed open: 2,400 requests an hour against a bucket of 120 a
 * minute, a promise that never settles, and a step of the studio that never advances. The file
 * already knew: `inspectSource`, one function over, caps at `INSPECTION_POLLS` and says "The Editor is
 * still checking the film." The render loop, which is the one every paid step waits on, had no cap
 * at all.
 *
 * The clock is on time **without progress**, not total time. A film that is checkpointing is alive
 * and may take as long as it takes; what is worth giving up on is a job that has not moved. The
 * bound is the queue's own: `DEFAULT_LEASE_MS` is five minutes and a job survives
 * `MAX_LEASE_RECOVERIES` of them, so a job the server has not yet given up on has moved within
 * 5 x (5 + 1) = thirty minutes. Past that the server has stopped waiting for it, and so does the
 * studio -- saying that the render is still there rather than that it failed, because it is.
 *
 * `packages/frontend/test/poll-ceiling.test.js` reads those two constants from `packages/queue` and
 * asserts this arithmetic, so the two descriptions of the same clock cannot drift apart.
 */
export const POLL_INTERVAL_MS = 1500;
export const STALL_LIMIT_MS = 30 * 60 * 1000;
const STALL_POLLS = Math.ceil(STALL_LIMIT_MS / POLL_INTERVAL_MS);
/**
 * The two other loops in this file that wait on the server, and the same clock (HV-022-15).
 *
 * HV-030-08 gave `pollJob` a ceiling and left these where they were: the cast's takes, polled every
 * three seconds until every one of them is terminal, and the Composer's score upload, retried every
 * two seconds for as long as the studio's single sound-upload slot is busy -- a server-process-global
 * counter, so *any* other upload anywhere on that server keeps it busy.
 *
 * Both run after the final has been rendered and paid for, inside the try/catch that makes a failed
 * finishing pass cost a note rather than the film. A hang never throws, so that catch never runs:
 * the creator was left on "The cast is recording: 1 of 4 lines done." with an approval step that
 * could not be reached. Waiting for ever is the one outcome a note cannot describe.
 *
 * Each interval names itself and each ceiling is `STALL_LIMIT_MS` over it, so the three loops in
 * this file stop waiting at the same half-hour the queue stops keeping a job.
 */
export const TAKE_POLL_INTERVAL_MS = 3000;
export const SOUND_UPLOAD_INTERVAL_MS = 2000;
const TAKE_STALL_POLLS = Math.ceil(STALL_LIMIT_MS / TAKE_POLL_INTERVAL_MS);
const SOUND_UPLOAD_ATTEMPTS = Math.ceil(STALL_LIMIT_MS / SOUND_UPLOAD_INTERVAL_MS);
/**
 * The creator's style card (HV-030-19, HV-030-20): the crew's memory of how they like to work,
 * kept by them rather than by the studio (ADR-0018: no accounts, no cookies, no tracking).
 *
 * The plan step hands the card back with its answer. The studio writes it to this browser's
 * storage only when the creator presses "Keep", offers it as a file to download, and sends it to
 * the crew only when they tick "Read my style card" at a pitch. It never leaves the device
 * otherwise, and the server keeps no copy of it.
 */
export const STYLE_CARD_KEY = "hv-studio-style-card";
/**
 * The formats the studio makes, as the crew's read-through, plan and style card accept them
 * (`packages/planner/src/crew/formats.ts`). HV-030-28 added the feature, up to 20 minutes (Release 3).
 */
export const FILM_FORMATS = Object.freeze(["reel", "short", "feature"]);
export const FORMAT_CHOICES = Object.freeze([["reel", "A reel, up to 90 seconds"], ["short", "A short film, up to 10 minutes"], ["feature", "A feature, up to 20 minutes"]]);
export const STYLE_CARD_SCHEMA = "hv-crew-style-card/1";
export const STYLE_CARD_FILE = "rough-cut-style-card.json";
/** A card from this device or a file, if it is the shape the studio made; the crew's own gate reads the words. */
export function parseStyleCard(text) {
  let card;
  try { card = typeof text === "string" ? JSON.parse(text) : null; } catch { return null; }
  return card && typeof card === "object" && !Array.isArray(card) && card.schema === STYLE_CARD_SCHEMA && FILM_FORMATS.includes(card.format)
    && Array.isArray(card.choices) ? card : null;
}

/** What a resumed final could not bring back (HV-016-09), said once above it. */
const RESUMED_FINAL = "This is the film you made. The crew's read-through was not retained, so the questions and answers from the first pass are not shown.";
/** What a resumed rough cut could not bring back (HV-016-09), said once above it. */
const RESUMED_ROUGH_CUT = "This is the rough cut you already paid for, so approving it does not render it again. The tone and your answers to the crew were not retained, "
  + "so the final will be scored and titled with the Composer's own direction, and sending the crew back needs the read-through, which is not retained either.";

export function createStudioFlow({api, getProject, setProject, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), onProgress = () => {}, storage,
  fetchImage = async url => { const response = await fetch(url); if (!response.ok) throw new Error('A storyboard still could not be read.'); return response.arrayBuffer(); }}) {
  let state = {step: "pitch"};
  // The creator's last answers to the crew, which the Composer reads (HV-024-02).
  let answered = [];
  // The script as pitched, which the Editor reads for the title page (HV-025-03).
  let pitched = "";
  const auth = (extra = {}) => ({authorization: `Bearer ${getProject().token}`, ...extra});
  const json = (method, body) => ({method, headers: auth({"content-type": "application/json"}), body: JSON.stringify(body)});
  const projectPath = path => `/api/projects/${getProject().projectId}${path}`;
  // HV-030-20: this browser's storage, if it will give one. Private windows and blocked site data
  // throw on the accessor itself, and the studio works the same without it.
  const device = () => { try { return storage ?? globalThis.localStorage ?? null; } catch { return null; } };
  const finishedCard = () => {
    if (!state.plan?.styleCard) throw new Error("The crew's plan for this film was not retained here, so there is no style card to keep.");
    return state.plan.styleCard;
  };

  async function pollJob(jobId, path = `/api/jobs/${jobId}`) {
    // What "moved" means: the status, or a shot finished. Either resets the clock (HV-030-08).
    let seen = null, unmoved = 0;
    for (;;) {
      const job = await api(path, {headers: auth()});
      if (job.status === "done") return job;
      if (job.status === "failed" || job.status === "cancelled") throw new Error(job.failureReason || job.cancelReason || "The render stopped.");
      const moved = `${job.status}:${job.checkpointShots ?? 0}`;
      unmoved = moved === seen ? unmoved + 1 : 0;
      seen = moved;
      if (unmoved >= STALL_POLLS) {
        throw new Error(`This render has not moved for ${STALL_LIMIT_MS / 60000} minutes. It is still ${job.status} on the server as job ${jobId}, `
          + "so nothing has been lost. Check back later, or ask for it again \u2014 the studio asks for the same render, so it is not paid for twice.");
      }
      onProgress(job.status === "running" ? `Rendering: ${job.checkpointShots ?? 0} shot(s) done.` : "Waiting for a free render slot.");
      await wait(POLL_INTERVAL_MS);
    }
  }

  // HV-019-04: the film's own spending limit, shown at every approval.
  const spend = () => api(projectPath("/spend"), {headers: auth()});
  /**
   * HV-030-29: which sequence a render is of. A rough cut names the sequence the creator is on; a final
   * names the sequence of the rough cut it follows, so a final can only ever be of the cut approved.
   * A reel or a short names none, and its requests are exactly as before.
   */
  const sequenceOf = () => sequencesOf(state) ? {sequence: state.sequence} : {};
  const finalSequenceOf = animatic => animatic?.sequence ? {sequence: animatic.sequence.number} : {};

  /**
   * Ask for a render, and notice when the studio had already made it (HV-030-10).
   *
   * `POST /jobs` returns the job it already admitted for a repeated key rather than admitting a
   * second one -- that is what HV-030-07 took the studio's random idempotency keys away for, and
   * what HV-016-10 and HV-017-12 stopped a no-op save from defeating. The route now says which of
   * the two happened, and this is the only place that reads it, so the two approvals cannot come to
   * describe the same thing differently.
   */
  let reused = false;
  async function askForRender(path, body) {
    const queued = await api(path, json("POST", body));
    if (queued.admitted === false) reused = true;
    return queued;
  }
  /**
   * HV-030-39: a resumed feature's finishing steps: the cast's takes and voices, the score, the titles
   * and the join. Each is asked for under a key fixed by what it finishes, and the studio answers a
   * repeated key with the job it already has, which is right while that job is done or still running.
   * But a job that ended failed or cancelled -- a voices pass the operator cancelled when it hung, a
   * score that failed -- is answered with that same dead job for ever. So a resumed flow, which has
   * read the project's jobs, asks again under `<key>-retry-<n>` (n counts the dead jobs of that key),
   * and a retry that is done or running is the job asked for after it. `finishLog` says what each step
   * did and why, for the run's record. A flow that hasn't resumed asks with the key as it always did.
   */
  let resumeJobs = null, finishingSequence = null, finishLog = [];
  const keyOf = job => {
    const key = String(job.idempotencyKey ?? ""), prefix = `${getProject().projectId}:`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  };
  async function askFinishing(step, path, base, body, {quiet = false} = {}) {
    if (!resumeJobs) return api(path, json("POST", {...body, idempotencyKey: base}));
    const ours = resumeJobs.filter(job => { const key = keyOf(job); return key === base || key.startsWith(`${base}-retry-`); });
    const live = ours.filter(job => job.status !== "failed" && job.status !== "cancelled").at(-1), dead = ours.at(-1);
    const key = live ? keyOf(live) : ours.length ? `${base}-retry-${ours.length}` : base;
    const how = live ? (live.status === "done" ? "kept" : "waited") : ours.length ? "retried" : "made";
    const queued = await api(path, json("POST", {...body, idempotencyKey: key}));
    if (!quiet || how === "retried") finishLog = [...finishLog, {sequence: finishingSequence, step, how, key, jobId: queued.jobId ?? null,
      ...(how === "retried" ? {retryOf: {jobId: dead.id, status: dead.status, reason: dead.failureReason ?? dead.cancelReason ?? null}} : {})}];
    return queued;
  }
  /** The one line the creator sees about it: a film they already have was not paid for twice. */
  const reusedNote = () => reused
    ? "The crew had already made this, so it was not rendered or paid for again."
    : undefined;

  /**
   * The three finishing passes, and the film they leave behind (HV-016-11).
   *
   * The final is paid for the moment it is done, so it is already in the state before any of this
   * runs and each failure costs a **note** rather than the film. This used to be the tail of
   * `approveRoughCut` and is now shared with a resumed wait, because a final that finished while the
   * tab was closed must be finished the same way a final that finished in front of the creator is --
   * two copies of this would have drifted the first time one of them changed.
   */
  async function finishFinal(final) {
    const notes = [], sequence = final.sequence;
    finishingSequence = sequence?.number ?? null;
    // HV-030-39: the picture these passes finish, which names the generated music cue (see `generatedCue`).
    const picture = final;
    // HV-022-03: the cast's production voices replace the temporary ones in the final. A failed
    // pass keeps the film and says so, which its two siblings below always did and it did not.
    let voiced = null;
    try { voiced = await voiceFinal(final); if (voiced) final = voiced; }
    catch (error) { notes.push(`Casting: the cast's production voices could not be recorded (${error.message}); the film keeps its temporary voices.`); }
    // HV-024-02: the Composer scores it. A failed mix keeps the voiced cut and says so.
    let scored = null;
    const sound = {credit: null, ambience: false};
    try { scored = await scoreFinal(final, state.tone, notes, sound, picture); if (scored) final = scored; }
    catch (error) { notes.push(`Composer: the score could not be mixed (${error.message}); the film is shared without music.`); }
    // HV-025-03: the Editor titles it. A failure keeps the scored cut and says so. A generated cue is
    // credited as what it is, not as the Composer's own score (HV-024-11), and the studio's ambience is
    // credited only when the mix that carried it finished (HV-024-14).
    const finished = {voiced: Boolean(voiced), scored: scored ? sound.credit ?? true : false, ambience: Boolean(scored && sound.ambience)};
    // HV-030-29: a sequence of a feature is not the film. HV-030-30: its title and credits belong to the
    // joined feature, which the Editor makes once the last sequence's film is finished.
    if (sequence) {
      // HV-030-33: what this sequence's finishing couldn't do is kept with it, so the joined feature says so too.
      state = {...state, finals: {...state.finals, [sequence.number]: final}, finishes: {...state.finishes, [sequence.number]: {...finished, notes: [...notes]}}};
      if (sequence.number < sequence.of) notes.push("Editor: a sequence carries no title or credits. They belong to the whole feature, which the Editor joins into one film after the last sequence.");
      // A reopened link doesn't bring back the earlier sequences' films (HV-030-29's resume gap), so there is nothing to join here.
      else if (!sequencesOf(state)) notes.push("Editor: the feature's sequences aren't joined from a reopened link yet; this last sequence is its own film here.");
      else {
        state = {...state, step: "final", final, finishNotes: notes};
        return joinSequences(notes);
      }
    } else {
      try { const titled = await titleFinal(final, finished); if (titled.cut) final = titled.cut; else notes.push(titled.note); }
      catch (error) { notes.push(`Editor: the title and credits could not be added (${error.message}); the film is shared without them.`); }
    }
    state = {...state, step: "final", final, finishNotes: notes, reusedNote: reusedNote(), spend: await spend()};
    return state;
  }

  /**
   * HV-030-30: the last sequence's film is finished, so the Editor joins every sequence's film into the
   * feature. A failure keeps the last sequence's film on screen and says so, and the creator can ask
   * for the join again; the films are made and paid for, and the join's request key is fixed by them.
   */
  async function joinSequences(notes = []) {
    const sequences = sequencesOf(state), last = state.finals?.[sequences.length];
    let joined = null, failure = null;
    try { joined = await joinFeature(); }
    catch (error) { failure = `Editor: the sequences could not be joined into one film (${error.message}); each sequence is still its own film, and you can ask the Editor to join them again.`; }
    // HV-030-33: a sequence joined without its score or its voices is said so on the feature, not only on
    // that sequence's own approval, which the creator has moved past. The last sequence's notes follow.
    const earlier = sequences.slice(0, -1).flatMap((_, index) => (state.finishes?.[index + 1]?.notes ?? []).map(note => `Sequence ${index + 1} of ${sequences.length}: ${note}`));
    const kept = notes.filter(note => !note.startsWith("Editor: the sequences could not be joined") && !earlier.includes(note));
    state = {...state, step: "final", final: joined?.cut ?? last, joined: Boolean(joined?.cut), joinedTitled: Boolean(joined?.titled),
      finishNotes: [...earlier, ...kept, ...(joined?.notes ?? []), ...(failure ? [failure] : [])], reusedNote: reusedNote(), spend: await spend()};
    return state;
  }

  // HV-025-07: checking a long film as an editorial source takes minutes, so the studio asks and
  // waits rather than holding a request open past what a socket allows.
  async function inspectSource(jobId) {
    for (let attempt = 0; attempt < INSPECTION_POLLS; attempt++) {
      const answer = await api(projectPath(`/editorial/sources/${jobId}`), {headers: auth()});
      if (answer.sources) return answer.sources[0];
      onProgress("The Editor is checking the film for the title and credits.");
      await wait(INSPECTION_INTERVAL_MS);
    }
    throw new Error("The Editor is still checking the film.");
  }

  /**
   * HV-025-03: the opening title and the closing credits, saved under fixed ids, reused while their
   * plan is unchanged and rendered with keys fixed by the spec. Shared by a short's titled cut and a
   * feature's joined film (HV-030-30), so both are titled from the same plans the same way.
   */
  async function renderTitles(graphics, plans) {
    let version = graphics.library.version, current = graphics.graphics;
    const rendered = {};
    for (const [id, label, plan] of [[TITLE_GRAPHIC_ID, "Editor: opening title", plans.title], [CREDITS_GRAPHIC_ID, "Editor: closing credits", plans.credits]]) {
      let saved = current.find(graphic => graphic.spec.id === id);
      if (!saved?.available || saved.spec.label !== label || !samePlan(saved.spec.plan, plan)) {
        const result = await api(projectPath("/graphics"), json("PUT", {change: {kind: "save", id, label, plan}, expectedVersion: version}));
        version = result.library.version; current = result.graphics; saved = current.find(graphic => graphic.spec.id === id);
      }
      const queued = await askFinishing("titles", projectPath(`/graphics/${id}/renders`), `${id}-${saved.spec.revision.slice(0, 32)}`, {specRevision: saved.spec.revision, generationApproved: true});
      rendered[id] = await pollJob(queued.jobId, projectPath(`/graphics/jobs/${queued.jobId}`));
    }
    return {title: rendered[TITLE_GRAPHIC_ID], credits: rendered[CREDITS_GRAPHIC_ID]};
  }

  /**
   * HV-030-30: the feature's one film. The studio joins every sequence's finished film, in order, with a
   * short dissolve at each join, the Editor's opening title over the first and end credits after the
   * last (the credits name the Showrunner, which split it), as one render it streams through the
   * assembler. The request names each sequence's film, so the studio refuses a join that misses a
   * sequence or holds a stale one, and records each sequence's final in the film's provenance. Its key
   * is fixed by the films and graphics, so asking again is the same join. Without a graphics renderer
   * the films are still joined, untitled, and the Editor says so.
   */
  async function joinFeature() {
    const sequences = sequencesOf(state), films = sequences.map((_, index) => state.finals?.[index + 1]);
    const missing = films.findIndex(film => !film);
    if (missing >= 0) throw new Error(`sequence ${missing + 1}'s film isn't in this studio`);
    onProgress(`The Editor is joining the ${films.length} sequences into one film.`);
    const quote = await api(projectPath("/feature-film"), {headers: auth()});
    if (!quote.size) throw new Error("the first sequence has no finished final");
    const notes = [], graphics = await api(projectPath("/graphics"), {headers: auth()});
    let titles = null;
    if (!graphics.rendering?.available) notes.push("Editor: titles and credits were skipped because this studio has no graphics renderer installed; the feature is joined untitled.");
    else {
      onProgress("The Editor is adding the title and credits.");
      const finishes = Object.values(state.finishes ?? {}), credit = finishes.find(value => typeof value.scored === "string")?.scored;
      const credits = creditRows({script: pitched, voiced: finishes.some(value => value.voiced), scored: credit ?? finishes.some(value => value.scored), ambience: finishes.some(value => value.ambience),
        continuity: continuityChecked(state.plan), showrunner: true});
      titles = await renderTitles(graphics, titlePlans({...frameSize(quote.size), title: filmTitle(pitched, state.readThrough?.logline), credits, filmFrames: quote.sequences[0]?.final?.frames ?? Infinity}));
    }
    const key = featureJoinKey([...films.map(film => film.id), titles?.title.id ?? "untitled", titles?.credits.id ?? "untitled"]);
    finishingSequence = null;
    const queued = await askFinishing("join", projectPath("/feature-film"), key, {generationApproved: true,
      sequences: films.map((film, index) => ({number: index + 1, jobId: film.id})), title: titles?.title.id ?? null, credits: titles?.credits.id ?? null});
    return {cut: await pollJob(queued.jobId), notes, titled: Boolean(titles)};
  }

  /**
   * Pins each still of this rough cut as its shot's first frame; only shots the crew directed and
   * nobody anchored.
   *
   * HV-017-13: every pin is saved as it is made and there is no undoing it, so this answers how
   * many were pinned *and* what stopped it, rather than throwing. A throw lost the count: the
   * caller told the creator no still had been pinned and "the final begins from the script" while
   * the shots before the failure were already anchored -- and the rough cut was not re-cut from
   * them, so what the creator approved was not what the final would render. That is the mismatch
   * HV-017-06 exists to close.
   */
  async function pinStills(animatic) {
    const view = await api(projectPath("/direction"), {headers: auth()});
    let version = view.direction.version, pinned = 0, failure = null;
    for (const source of view.viewfinderSources.filter(value => value.jobId === animatic.id)) {
      const entry = view.direction.entries.find(value => value.source.id === source.shotId);
      const planned = view.plan.find(value => value.source.id === source.shotId);
      if (!entry || !planned || entry.settings.frameAnchors || entry.sourceHash !== planned.sourceHash) continue;
      try {
        const image = await fetchImage(source.url);
        const {asset} = await api(projectPath(`/direction/${encodeURIComponent(source.shotId)}/anchors?label=Storyboard%20still`), {method: "POST", body: image,
          headers: auth({"content-type": "image/png", "x-hv-reference-attested": "true", "x-hv-direction-version": String(version),
            "x-hv-script-version": String(view.scriptVersion), "x-hv-source-hash": planned.sourceHash})});
        const saved = await api(projectPath(`/direction/${encodeURIComponent(source.shotId)}`), json("PUT", {
          settings: {...entry.settings, frameAnchors: {frames: [{at: 0, asset}], fallback: "stop"}},
          sourceHash: planned.sourceHash, expectedVersion: version, expectedScriptVersion: view.scriptVersion}));
        version = saved.direction.version; pinned++;
      } catch (error) {
        // Stop at the first refusal: a full library, a busy image slot or a moved direction version
        // refuses the next shot for the same reason, and trying each one would say it N times.
        failure = error; break;
      }
    }
    return {pinned, failure};
  }

  /**
   * HV-022-03: one take per line in the character's cast production voice, then those takes laid
   * over the final's temporary dialogue (each line keeps its start). Idempotency keys are fixed by
   * line, character and voice policy, so a retry or a second pass never pays for a line twice.
   * With no authorized catalogue the final keeps its temporary voices.
   */
  async function voiceFinal(final) {
    const takes = await api(projectPath("/audio-takes"), {headers: auth()});
    if (!takes.enabled) return null;
    const characters = new Map(takes.characters.map(character => [character.id, character]));
    const policyFor = voiceId => takes.voices.find(voice => voice.id === voiceId);
    // HV-030-29: a sequence's final records only its own scenes' lines, so nothing is spent on a
    // sequence the creator hasn't approved yet.
    const scenes = final.sequence ? [final.sequence.firstScene, final.sequence.lastScene] : null;
    const wanted = takes.lines.filter(line => {
      if (scenes && (line.sceneIndex + 1 < scenes[0] || line.sceneIndex + 1 > scenes[1])) return false;
      const character = line.characterId && characters.get(line.characterId);
      return !line.unavailable && character?.profile && character.voiceAvailable && policyFor(character.profile.voice.id);
    });
    if (!wanted.length) return null;
    onProgress(`The cast is recording ${wanted.length} line${wanted.length === 1 ? "" : "s"}.`);
    const ids = new Set();
    for (const line of wanted) {
      const voice = policyFor(characters.get(line.characterId).profile.voice.id);
      const key = `crew-voice-${line.sceneIndex}-${line.source.index}-${line.source.hash.slice(0, 16)}-${line.characterId.slice(0, 8)}-${voice.policyRevision.slice(0, 12)}`;
      const queued = await askFinishing("voice-take", projectPath("/audio-takes"), key, {generationApproved: true, sceneIndex: line.sceneIndex, lineIndex: line.source.index,
        sourceHash: line.source.hash, characterId: line.characterId, voiceId: voice.id, policyRevision: voice.policyRevision,
        ...(voice.provider === "azure" ? {nativeCapabilityRevision: takes.nativeCapabilityRevision} : {}), performanceRevision: line.performanceRevision ?? null}, {quiet: true});
      ids.add(queued.jobId);
    }
    // What "moved" means here: a take reaching a new status. `pollJob`'s clock, on this loop's own
    // interval (HV-022-15) -- a take that never becomes terminal used to be polled for as long as
    // the tab stayed open, after the film had already been rendered and paid for.
    let seen = null, unmoved = 0;
    for (;;) {
      const jobs = (await api(projectPath("/audio-takes"), {headers: auth()})).jobs.filter(job => ids.has(job.id));
      if (jobs.length === ids.size && jobs.every(job => ["done", "failed", "cancelled"].includes(job.status))) break;
      const done = jobs.filter(job => job.status === "done").length;
      const moved = jobs.map(job => `${job.id}:${job.status}`).sort().join(",");
      unmoved = moved === seen ? unmoved + 1 : 0;
      seen = moved;
      if (unmoved >= TAKE_STALL_POLLS) {
        throw new Error(`the cast's recording has not moved for ${STALL_LIMIT_MS / 60000} minutes; ${done} of ${ids.size} line(s) are done `
          + "and the rest are still on the server, so nothing has been lost \u2014 ask for the crew's voices again later");
      }
      onProgress(`The cast is recording: ${done} of ${ids.size} lines done.`);
      await wait(TAKE_POLL_INTERVAL_MS);
    }
    const dialogue = await api(projectPath(`/dialogue/${final.id}`), {headers: auth()});
    const edits = dialogue.lines.flatMap(line => {
      const read = line.auditions.find(audition => ids.has(audition.jobId) && !audition.unavailable);
      return read ? [{shotId: line.shotId, index: line.index, sourceHash: line.sourceHash, auditionJobId: read.jobId, auditionRevision: read.revision}] : [];
    });
    if (!edits.length) return null;
    onProgress("Laying the cast's voices into the final.");
    const queued = await askFinishing("voices", projectPath(`/dialogue/${final.id}`), `crew-voices-${final.id}`, {generationApproved: true,
      sourceRevision: dialogue.sourceRevision, sourceFilesRevision: dialogue.sourceFilesRevision, engineVersion: dialogue.engineVersion,
      conversionEngineVersion: dialogue.conversionEngineVersion, edits});
    return pollJob(queued.jobId);
  }

  /**
   * HV-024-02: the Composer's score, mixed under the finished cut: the application's own loop from
   * score.js, uploaded once to the project's sound library and reused, looped for the film's length,
   * faded in and out and ducked under every line. The request key is fixed by the cut, so a retry
   * never renders twice. "No music" from the creator skips it.
   *
   * HV-024-14: the studio's own ambience beds go into the same session, at the levels the ambience
   * route answers. `sound.ambience` says whether they did, so the credits name them only then.
   */
  async function scoreFinal(cut, tone, notes = [], sound = {credit: null, ambience: false}, picture = cut) {
    const direction = scoreDirection({tone, answers: answered});
    if (!direction.enabled) return null;
    const quote = await api(projectPath(`/sound-mixes/${cut.id}`), {headers: auth()});
    const record = scoreRecord(direction, 0), bytes = composeScore(direction);
    let {library, music: vendor} = await api(projectPath("/sounds"), {headers: auth()});
    let asset = null;
    // HV-024-11: when the studio has a music vendor, the Composer asks it for one cue under the
    // music line, keyed by the cut so a retry never pays twice. Anything that stops it -- the line,
    // the safety gate, the vendor -- keeps the Composer's own score and says why.
    if (vendor?.generated) {
      try { ({asset, credit: sound.credit} = await generatedCue(picture, tone, direction, quote)); }
      catch (error) { asset = null; sound.credit = null; notes.push(`Composer: generated music was not used (${error.message}); the film is scored with the Composer's own music.`); }
    }
    asset ??= library.assets.find(value => value.label === record.label && value.original.bytes === bytes.byteLength);
    // The studio admits one sound upload at a time, for the whole server, so this waits on other
    // films as well as on itself. It waits for the same half-hour as everything else and then says
    // so, rather than for ever (HV-022-15).
    for (let attempt = 0; !asset; attempt += 1) {
      if (attempt >= SOUND_UPLOAD_ATTEMPTS) {
        throw new Error(`the studio's sound library has been busy for ${STALL_LIMIT_MS / 60000} minutes, so the score could not be uploaded`);
      }
      try {
        ({asset} = await api(projectPath("/sounds"), {method: "POST", body: bytes,
          headers: auth({"content-type": "audio/wav", "x-hv-sound-record": encodeURIComponent(JSON.stringify({...record, expectedVersion: library.version}))})}));
      } catch (error) {
        if (!/being processed/.test(error.message)) throw error;
        await wait(SOUND_UPLOAD_INTERVAL_MS); ({library} = await api(projectPath("/sounds"), {headers: auth()}));
        asset = library.assets.find(value => value.label === record.label && value.original.bytes === bytes.byteLength);
      }
    }
    const ambience = await ambienceCues(cut, notes);
    onProgress("The Composer is scoring the film.");
    const frames = Math.round(quote.durationSec * 30) * 1600;
    // A session with ambience is a different session, so it has its own key: a film first mixed
    // without it (the route refused, or an older studio) is not answered "this key belongs to a
    // different sound session" when it is mixed again with it. Both keys are fixed by the cut.
    const key = ambience.length ? `crew-score-ambience-${cut.id}` : `crew-score-${cut.id}`;
    const queued = await askFinishing("score", projectPath(`/sound-mixes/${cut.id}`), key, {generationApproved: true,
      sourceRevision: quote.sourceRevision, engineVersion: quote.engineVersion,
      session: {reviewed: true, dialogueGainDb: 0, narrationGainDb: 0, cues: [{id: cut.id, assetId: asset.id, assetRevision: asset.revision, role: "music",
        start: 0, frames, trimIn: 0, trimOut: asset.audio.frames, loop: true, gainDb: direction.gainDb, balance: 0,
        fadeIn: Math.min(96000, Math.floor(frames / 4)), fadeOut: Math.min(144000, Math.floor(frames / 4)), duckDb: direction.duckDb, duckAttack: 12000, duckRelease: 28800},
      ...ambience]}});
    const mixed = await pollJob(queued.jobId);
    sound.ambience = ambience.length > 0;
    return mixed;
  }

  /**
   * HV-024-14: the studio's ambience beds for the cut's scenes (HV-024-12), as the cues the ambience
   * route answers. They are used as they come: the route sets each bed's level, fades and ducking
   * under the voices, and the studio invents none. The route takes no request key; asking again for
   * the same cut answers the same cues and reuses the beds already in the library, so the cut in its
   * URL is what makes it safe to repeat. Anything that stops it -- an expired cut, a busy sound slot,
   * a full library -- keeps the score without ambience and says why.
   */
  async function ambienceCues(cut, notes) {
    onProgress("The studio is laying ambience under the scenes.");
    try {
      const {cues} = await api(projectPath(`/ambience/${cut.id}`), json("POST", {}));
      return Array.isArray(cues) ? cues : [];
    } catch (error) {
      notes.push(`Composer: the studio's ambience was not added (${error.message}); the film is shared with its score and no ambience.`);
      return [];
    }
  }

  /**
   * HV-024-11: one generated cue, as long as the film up to two minutes, waiting its turn for the sound library.
   * HV-030-39: keyed by the picture it scores, not the cut, so a final scored again on its voiced cut (a resumed
   * feature whose voices pass was redone) is answered with the cue already paid for. A voiced cut runs as long as
   * its final, so the request is the same.
   */
  async function generatedCue(picture, tone, direction, quote) {
    const mood = typeof tone === "string" && tone.trim() ? `; the film's tone: ${tone.trim().slice(0, 300)}` : "";
    const request = {idempotencyKey: `crew-music-${picture.id}`, durationSec: Math.min(120, Math.max(10, Math.ceil(quote.durationSec))), seed: 0,
      prompt: `Instrumental film underscore in a ${direction.mode} key at about ${direction.bpm} BPM, unobtrusive under dialogue${mood}.`};
    onProgress("The Composer is asking for music.");
    for (let attempt = 0; ; attempt += 1) {
      try { return await api(projectPath("/music-cues"), json("POST", request)); }
      catch (error) {
        // The same half-hour as the score's own upload, and then the error, which keeps the Composer's score.
        if (!/being processed/.test(error.message) || attempt + 1 >= Math.ceil(STALL_LIMIT_MS / SOUND_UPLOAD_INTERVAL_MS)) throw error;
        await wait(SOUND_UPLOAD_INTERVAL_MS);
      }
    }
  }

  /**
   * HV-025-03: the Editor's opening title and closing credits. Both graphics are saved under fixed
   * ids and reused while their plan is unchanged; renders, the sequence and its export use keys
   * fixed by the spec and the cut, so a retry never renders twice. The result is a picture edit of
   * the finished cut: the title over its first seconds and the credits after its last frame, with
   * the Composer's music under them when the cut carries a music stem. Without the pinned graphics
   * browser on this studio, the film is shared untitled and the Editor says so.
   */
  async function titleFinal(cut, {voiced, scored, ambience = false}) {
    const graphics = await api(projectPath("/graphics"), {headers: auth()});
    if (!graphics.rendering?.available) return {note: "Editor: titles and credits were skipped because this studio has no graphics renderer installed; the film is shared untitled."};
    onProgress("The Editor is adding the title and credits.");
    const film = await inspectSource(cut.id), size = frameSize(film.facts), title = filmTitle(pitched, state.readThrough?.logline);
    const plans = titlePlans({...size, title, credits: creditRows({script: pitched, voiced, scored, ambience, continuity: continuityChecked(state.plan)}), filmFrames: film.facts.frames});
    const rendered = await renderTitles(graphics, plans);
    const titleSource = await inspectSource(rendered.title.id), creditsSource = await inspectSource(rendered.credits.id);
    const sources = [film, titleSource, creditsSource], id = `crew-titles-${cut.id}`, route = projectPath(`/editorial/sequences/${id}`);
    const library = await api(projectPath("/editorial"), {headers: auth()});
    let sequence = library.sequences.some(value => value.id === id) ? await api(route, {headers: auth()})
      : await api(projectPath("/editorial/sequences"), json("POST", {id, label: "Editor: titles and credits", sources: sources.map(source => ({jobId: source.jobId, sourceRevision: source.sourceRevision})),
        firstSourceId: film.facts.id, ...size, expectedVersion: library.libraryVersion}));
    // A sequence left by an interrupted attempt is completed, not duplicated.
    for (const source of sources.filter(value => !sequence.timeline.sources.some(known => known.id === value.facts.id)))
      sequence = await api(`${route}/sources`, json("POST", {jobId: source.jobId, sourceRevision: source.sourceRevision, expectedVersion: sequence.libraryVersion, expectedHistoryRevision: sequence.sequence.history.revision}));
    if (!sequence.timeline.clips.some(value => value.id === CREDITS_CLIP_ID))
      sequence = await api(route, json("PATCH", {expectedVersion: sequence.libraryVersion, expectedHistoryRevision: sequence.sequence.history.revision,
        change: {kind: "edit", label: "Editor: title and credits", operation: titleOperation({film: film.facts, title: titleSource.facts, credits: creditsSource.facts})}}));
    const quote = await api(`${route}/renders`, {headers: auth()});
    if (quote.unavailable) throw new Error(quote.unavailable);
    const queued = await api(`${route}/renders`, json("POST", {idempotencyKey: `crew-titles-${cut.id}`, generationApproved: true, historyRevision: quote.sequence.historyRevision,
      sourceBindingsRevision: quote.sourceBindingsRevision, engineVersion: quote.engineVersion, review: {...quote.review, accepted: true}}));
    return {cut: await pollJob(queued.jobId)};
  }

  /**
   * The storyboard and rough cut: of the whole film, or of the feature's current sequence (HV-030-29).
   * Shared by the look approval and by each next sequence, so a sequence's rough cut is made exactly
   * as a short's is.
   */
  async function roughCut() {
    onProgress(sequencesOf(state) ? `The crew is drawing sequence ${state.sequence}'s storyboard and cutting its rough cut.` : "The crew is drawing the storyboard and cutting the rough cut.");
    // HV-030-07: no request key. The server derives one from what the render is *of* --
    // `${stage}:${scriptVersion}:cast-${castingVersion}:direction-${directionVersion}` (and, for a
    // feature, the sequence) -- so pressing the button twice admits one job.
    const queued = await askForRender(projectPath("/jobs"), sequenceOf());
    let animatic = await pollJob(queued.jobId);
    // The rough cut is paid for the moment it is done, so it goes into the state before anything
    // that can fail is attempted. Everything after this point costs a note, not a film.
    state = {...state, step: "rough-cut", animatic};
    const notes = [];
    // HV-017-06: when the final provider can start a clip from a given frame, the crew pins
    // each storyboard still as its shot's first frame, so the final begins from the picture
    // the creator approves. The rough cut is re-cut from the pinned stills (no new pictures),
    // and the pin moves the direction version, so that re-cut is its own job by the same rule.
    try {
      // HV-030-29: the desk's 24-shot plan doesn't hold a feature's shots yet, so a sequence's stills aren't pinned.
      if (state.plan.finalAnchors && sequencesOf(state)) notes.push("Cinematographer: a feature's storyboard stills aren't pinned as the final's first frames yet; this sequence's final begins from the script.");
      else if (state.plan.finalAnchors) {
        const result = await pinStills(animatic), pinned = result.pinned;
        // What the note says follows what was saved, not whether something threw (HV-017-13).
        if (result.failure && !pinned) notes.push(`Cinematographer: the storyboard stills could not be pinned as the final's first frames (${result.failure.message}); the final begins from the script.`);
        if (result.failure && pinned) notes.push(`Cinematographer: ${pinned} storyboard still${pinned === 1 ? " was" : "s were"} pinned as the final's first frames and the rest could not be (${result.failure.message}); `
          + `those shot${pinned === 1 ? "" : "s"} begin from the still and the others from the script.`);
        if (pinned) {
          onProgress("The crew pinned the storyboard stills as the final's first frames.");
          const again = await askForRender(projectPath("/jobs"), sequenceOf());
          animatic = await pollJob(again.jobId);
          state = {...state, animatic};
        }
      }
    } catch (error) {
      // Only the re-cut can reach here now, and by then the pins are saved: the final will begin
      // from them whatever this rough cut shows, and the creator is about to approve it.
      notes.push(`Cinematographer: the storyboard stills were pinned as the final's first frames, but the rough cut could not be made again from them (${error.message}); `
        + "the final will begin from the pinned stills, which this rough cut does not show.");
    }
    state = {...state, step: "rough-cut", animatic, lookNotes: notes, reusedNote: reusedNote(), spend: await spend()};
    return state;
}

  async function readThrough(format, tone, styleCard) {
    // HV-030-20: the card goes to the crew only when the creator attached it to this pitch.
    const result = await api(projectPath("/crew/read-through"), json("POST", {format, tone, ...(styleCard ? {styleCard} : {})}));
    const blocked = result.facts.concerns.filter(concern => BLOCKING_CONCERNS.includes(concern.kind));
    const attached = styleCard ? {styleCard} : {};
    state = blocked.length ? {step: "pitch", format, tone, blocked, readThrough: result, ...attached} : {step: "questions", format, tone, readThrough: result, ...attached};
    return state;
  }

  return {
    get state() { return state; },
    /** HV-030-39: what each finishing step of a resumed feature did: kept, waited on, made, or retried and why. */
    get finishLog() { return finishLog; },

    /**
     * The studio's own step, rebuilt from the project a reopened link names (HV-016-09).
     *
     * `docs/CREW.md` lists this under "Not yet": *"Resuming inside the studio. A reopened project
     * link opens the Director's desk, because the studio does not yet rebuild its step from the
     * project."* So a creator who closed the tab came back to every detailed panel in the
     * application instead of to the film they had already paid for, and the one path the studio
     * itself offered was to pitch the script again -- which renders, and charges, again.
     *
     * The project holds what was *made*: the script, and every job with its stage and status. It
     * does not hold what the crew *said* -- the read-through is the model's answer and is not
     * stored -- nor what the creator told the crew: the format, the tone, and the replies to the
     * questions. So the furthest step this rebuilds is the furthest one whose evidence is in the
     * project, and each says what it could not bring back rather than inventing it:
     *
     * - a finished **final**: the film, and the share step. Nothing further is generated from the
     *   tone or the answers, so this step resumes whole.
     * - a finished **animatic**: the rough cut, and the approval that turns it into the final. That
     *   final will be scored and titled with the Composer's own direction, because the tone and the
     *   answers were the creator's and are gone; the note says so before they approve.
     * - a saved **script** and nothing rendered: the pitch, with the script in the box. The crew
     *   reads it again, which costs nothing.
     */
    async resume() {
      const project = await api(projectPath(""), {headers: auth()});
      const of = (stage, ...statuses) => (project.jobs ?? []).filter(job => job.stage === stage && statuses.includes(job.status)).at(-1);
      const finished = stage => of(stage, "done");
      const script = typeof project.script === "string" ? project.script : "";
      pitched = script;
      answered = [];
      const final = finished("final"), animatic = finished("animatic");
      // HV-016-11: a render the creator walked away from is still running on the server. It is not a
      // film yet and it is not nothing; the step below it is where they were, and `waitForPending`
      // is how they get the rest.
      const inFlight = of("final", "queued", "running") ?? of("animatic", "queued", "running");
      const pending = inFlight ? {stage: inFlight.stage, jobId: inFlight.id, status: inFlight.status} : null;
      if (final) {
        state = {step: "final", script, final, resumed: "final", spend: await spend(), resumedNote: RESUMED_FINAL};
      } else if (pending?.stage === "final" && animatic) {
        state = {step: "rough-cut", script, animatic, pending, resumed: "rough-cut", spend: await spend(),
          resumedNote: "Your final film is still being made — it is " + pending.status + " on the server, and it is already paid for. Wait for it here, or come back later; "
            + "the tone and your answers to the crew were not retained, so it will be scored and titled with the Composer's own direction."};
      } else if (animatic) {
        state = {step: "rough-cut", script, animatic, resumed: "rough-cut", spend: await spend(), resumedNote: RESUMED_ROUGH_CUT};
      } else if (pending) {
        state = {step: "pitch", script, pending, resumed: "pitch", spend: await spend(),
          resumedNote: "Your rough cut is still being made — it is " + pending.status + " on the server, and it is already paid for. Wait for it here rather than pitching "
            + "again. The crew pinned nothing yet, so the final will begin from the script rather than from the storyboard stills."};
      } else {
        state = {step: "pitch", script, resumed: script ? "pitch" : null,
          ...(script ? {resumedNote: "Your script is here. Nothing was rendered, so the crew will read it again — that costs nothing."} : {})};
      }
      return state;
    },

    /**
     * Wait for the render a resumed project left running, and carry on from it (HV-016-11).
     *
     * HV-016-09 brought a creator back to the step their evidence supported, and HV-030-08 gave the
     * studio a bounded way to wait on a render — thirty minutes without progress, derived from the
     * queue's own lease clock. Between them a project whose film was *still being made* had neither:
     * it resumed to the step below and the only button there rendered something.
     *
     * A finished final goes through the same three finishing passes an approval runs, because a film
     * that finished while the tab was closed must be finished the same way as one that finished in
     * front of the creator. A finished animatic lands on the rough cut **without** the storyboard
     * pinning pass, because that pass needs the crew's plan, which is not retained — the note says
     * so, and what it costs is that the final begins from the script rather than from the stills.
     */
    async waitForPending() {
      const pending = state.pending;
      if (!pending) throw new Error("Nothing is rendering.");
      onProgress(pending.stage === "final" ? "Your final film is still being made." : "Your rough cut is still being made.");
      const job = await pollJob(pending.jobId);
      const {pending: _done, ...rest} = state;
      // HV-016-16: the note above the step said the render was still being made. Once it is done
      // the note is the one a project that had already finished it resumes with.
      if (pending.stage === "final") {
        state = {...rest, step: "final", final: job, resumed: "final", resumedNote: RESUMED_FINAL};
        return finishFinal(job);
      }
      state = {...rest, step: "rough-cut", animatic: job, resumed: "rough-cut", resumedNote: RESUMED_ROUGH_CUT, spend: await spend(),
        lookNotes: ["Cinematographer: the storyboard stills were not pinned as the final's first frames, because the crew's plan was not retained; the final begins from the script."]};
      return state;
    },

    /**
     * HV-030-37: carry on a feature whose run stopped, from the project a kept token names, without paying twice.
     *
     * The project holds what was made: each sequence's rough cuts and finals with their status, the approvals, the
     * Showrunner's split and the cast. What the crew said is not kept (HV-016-09), so the caller hands back the two
     * things the film still reads from it: the tone the Composer scores to, and the plan's facts (whether stills are
     * pinned, and what the Continuity Supervisor compared, which the credits name).
     *
     * Sequences are taken in order. One whose final is finished is finished again, and every finishing pass asks with
     * the key fixed by that film, so the studio answers with what it already made: nothing is rendered or paid twice.
     * The first sequence without a finished final is where the run stopped, and the studio stops there too, on the
     * step the creator would be on:
     * - its rough cut is made: the rough cut, ready to approve. A final still rendering is waited on. A final that
     *   failed is asked for again under a fresh key, fixed by the rough cut and the attempt (the default key answers
     *   with the failed job), and the shots it rendered before it stopped are reused at $0.
     * - no rough cut, sequence 1: the look, with the cast as the studio holds it.
     * - no rough cut, a later sequence: the sequence before it, finished, so `nextSequence` makes this rough cut.
     * After the last sequence the films are joined, as `finishFinal` joins them.
     */
    async resumeFeature({tone = "", plan = {}} = {}) {
      const project = await api(projectPath(""), {headers: auth()});
      // The split and each sequence's newest finished final, as the join reads them (409 for anything but a feature).
      const feature = await api(projectPath("/feature-film"), {headers: auth()});
      const cast = await api(projectPath("/cast"), {headers: auth()});
      pitched = typeof project.script === "string" ? project.script : "";
      answered = [];
      // The project's jobs come in the order they were asked for, so the last of a kind is the newest.
      const jobs = project.jobs ?? [], sequences = feature.sequences.map(({number, firstScene, lastScene}) => ({number, firstScene, lastScene}));
      const approved = id => (project.animaticApprovals ?? []).some(approval => approval.animaticJobId === id && approval.decision === "approved");
      // HV-030-39: a finishing step that ended failed or cancelled is asked for again (`askFinishing`).
      resumeJobs = jobs; finishLog = [];
      state = {step: "look", format: "feature", tone, plan, sequences, sequence: 1, casting: cast.casting, resumed: "feature", resumedSequences: [],
        pendingCast: cast.casting.characters.filter(character => character.kind === "original-fictional" && character.permission.status === "pending")};
      for (const {number, final: made} of feature.sequences) {
        if (made) {
          const final = await api(`/api/jobs/${made.jobId}`, {headers: auth()});
          onProgress(`Sequence ${number} of ${sequences.length} is made; the crew finishes it with what the studio already holds.`);
          state = {...state, sequence: number, step: "final", animatic: jobs.find(job => job.id === final.animaticJobId) ?? null, final};
          await finishFinal(final);
          state = {...state, resumedSequences: [...state.resumedSequences, {number, roughCut: final.animaticJobId ?? null, final: final.id, film: state.finals?.[number]?.id ?? null, spend: state.spend}]};
          continue;
        }
        const animatic = jobs.filter(job => job.stage === "animatic" && job.status === "done" && job.sequence?.number === number && job.sequence?.planRevision === feature.planRevision).at(-1);
        if (!animatic) return state;
        const finals = jobs.filter(job => job.stage === "final" && job.animaticJobId === animatic.id);
        const rendering = finals.find(job => job.status === "queued" || job.status === "running");
        const stopped = finals.filter(job => job.status === "failed" || job.status === "cancelled");
        state = {...state, sequence: number, step: "rough-cut", animatic, lookNotes: [], spend: await spend(),
          finalResume: {approved: approved(animatic.id), ...(rendering ? {jobId: rendering.id}
            : stopped.length ? {request: {idempotencyKey: `crew-final-${animatic.id}-retry-${stopped.length}`, reuseUnchanged: true}, retryOf: stopped.at(-1).id} : {})}};
        return state;
      }
      return state;
    },

    /** The style card kept on this device, if there is one and the browser will say. */
    savedStyleCard() {
      try { return parseStyleCard(device()?.getItem(STYLE_CARD_KEY) ?? null); } catch { return null; }
    },

    /** Keep this film's style card on this device, because the creator asked. Nothing is sent. */
    keepStyleCard() {
      const card = finishedCard();
      try { const store = device(); if (!store) throw new Error("no storage"); store.setItem(STYLE_CARD_KEY, JSON.stringify(card)); }
      catch { throw new Error("This browser won't keep the style card. Download it instead, and load the file at your next pitch."); }
      state = {...state, styleCardKept: true};
      return state;
    },

    /** Forget the card kept on this device. A downloaded file is the creator's own. */
    forgetStyleCard() {
      try { device()?.removeItem(STYLE_CARD_KEY); } catch { /* Nothing was kept, or the browser won't say. */ }
    },

    /** This film's style card as a file for the creator to keep. Nothing is sent. */
    styleCardFile() {
      return {name: STYLE_CARD_FILE, type: "application/json", text: JSON.stringify(finishedCard(), null, 2)};
    },

    /** Pitch: save the script, record the creator's rights attestation, and hand it to the crew. */
    async pitch({script, format, tone, rightsAttested, styleCard}) {
      if (!script.trim()) throw new Error("Paste your script first.");
      if (!rightsAttested) throw new Error("Confirm that you hold the rights to this script.");
      if (!getProject()) setProject(await api("/api/projects", {method: "POST"}));
      await api(projectPath("/script"), json("PUT", {text: script}));
      await api(projectPath("/rights"), json("POST", {attested: true}));
      await readThrough(format, tone, styleCard);
      pitched = script;
      state = {...state, script};
      return state;
    },

    /** Questions answered: the crew turns them into cast and shot direction. */
    async plan(answers) {
      if (state.step !== "questions") throw new Error("Answer the crew's questions first.");
      const {format, tone, readThrough: result, styleCard} = state;
      const byId = new Map(result.questions.map(question => [question.id, question]));
      const sent = answers.map(answer => {
        const question = byId.get(answer.id);
        if (!question) throw new Error("That question is no longer open.");
        return {id: question.id, persona: question.persona, question: question.question, proposal: question.proposal,
          accepted: answer.accepted, reply: answer.accepted ? "" : (answer.reply ?? "")};
      });
      // HV-034-02: a feature's style bible reads the style card the creator attached; a reel's and a short's request is unchanged.
      const plan = await api(projectPath("/crew/plan"), json("POST", {format, tone, answers: sent, expected: result.expected, ...(format === "feature" && styleCard ? {styleCard} : {})}));
      answered = sent;
      const cast = await api(projectPath("/cast"), {headers: auth()});
      // HV-016-15: the characters still waiting for the creator's permission. Not `pending`: that is the
      // render a resumed project left running, and `render` offers to wait for whatever it holds.
      // HV-030-29: a feature comes back split into sequences, made one after another from the first.
      const sequences = Array.isArray(plan.sequences?.sequences) && plan.sequences.sequences.length ? {sequences: plan.sequences.sequences, sequence: 1} : {};
      state = {step: "look", format, tone, readThrough: result, ...(styleCard ? {styleCard} : {}), plan, ...sequences, casting: cast.casting, spend: await spend(),
        pendingCast: cast.casting.characters.filter(character => character.kind === "original-fictional" && character.permission.status === "pending")};
      return state;
    },

    /** Approval 1, the look: permit the crew's cast, then render the storyboard and rough cut. */
    async approveLook(attested) {
      if (state.step !== "look") throw new Error("Review the crew's plan first.");
      if (state.pendingCast.length && !attested) throw new Error("Confirm that the cast are original characters you may use.");
      if (state.pendingCast.length) await api(projectPath("/crew/approve-cast"), json("POST", {attested: true, expectedVersion: state.casting.version}));
      return roughCut();
    },

    /**
     * HV-030-29: a sequence's film approved, so the next sequence's storyboard and rough cut. The look
     * was approved once for the whole feature and is not asked again; each sequence is its own render
     * under the feature's one film limit, admitted when the creator gets to it and not before.
     */
    async nextSequence() {
      const sequences = sequencesOf(state);
      if (state.step !== "final" || !sequences) throw new Error("Only a feature is made one sequence after another.");
      if (state.sequence >= sequences.length) throw new Error("Every sequence of this feature is made.");
      state = {...state, sequence: state.sequence + 1, finals: {...state.finals, [state.sequence]: state.final}};
      return roughCut();
    },
    /**
     * HV-030-30: ask the Editor to join the sequences again, after a join that stopped. The films are
     * already made and paid for, and the join's key is fixed by them, so nothing is made twice.
     */
    async joinAgain() {
      const sequences = sequencesOf(state);
      if (state.step !== "final" || !sequences || state.sequence < sequences.length) throw new Error("A feature is joined once its last sequence's film is made.");
      if (state.joined) throw new Error("The feature is already joined into one film.");
      return joinSequences(state.finishNotes ?? []);
    },
    /** Approval 2, the rough cut: approve it and make the final, or send the crew back. */
    async approveRoughCut() {
      if (state.step !== "rough-cut") throw new Error("Watch the rough cut first.");
      // HV-030-37: a resumed feature says how this final is asked for (`resumeFeature`); any other rough cut has nothing here.
      const resume = state.finalResume ?? {};
      if (!resume.approved && !resume.jobId) await api(projectPath("/animatic/decision"), json("POST", {animaticJobId: state.animatic.id, decision: "approved"}));
      onProgress(state.animatic.sequence ? `Approved. The crew is making sequence ${state.animatic.sequence.number}'s final.` : "Approved. The crew is making the final film.");
      const queued = resume.jobId ? {jobId: resume.jobId}
        : await askForRender(projectPath("/jobs"), {stage: "final", animaticJobId: state.animatic.id, ...finalSequenceOf(state.animatic), ...resume.request});
      if (state.finalResume) {
        const {finalResume: _asked, ...rest} = state;
        state = {...rest, resumedFinal: {number: state.sequence, jobId: queued.jobId, how: resume.jobId ? "waited" : resume.request ? "retried" : "made", retryOf: resume.retryOf ?? null}};
      }
      let final = await pollJob(queued.jobId);
      // The final is paid for the moment it is done. It goes into the state here, before the three
      // finishing steps, so a failure in any of them costs a note rather than the film.
      state = {...state, step: "final", final};
      return finishFinal(final);
    },

    async requestChanges() {
      if (state.step !== "rough-cut") throw new Error("Watch the rough cut first.");
      // HV-016-09: sending the crew back means asking for a fresh read-through, and that needs the
      // format and the tone this film was pitched with. A resumed rough cut does not have them --
      // they were the creator's words and the project does not retain them -- so this refuses by
      // name rather than reading the script back with a format nobody chose.
      if (state.resumed) throw new Error("Sending the crew back needs the read-through from this film's first pass, which was not retained. "
        + "Approve this rough cut, or pitch the script again to start a fresh pass.");
      await api(projectPath("/animatic/decision"), json("POST", {animaticJobId: state.animatic.id, decision: "changes_requested"}));
      return readThrough(state.format, state.tone, state.styleCard);
    },

    /** Approval 3 is the creator's own: share the final with a reviewer. */
    async share(maxViews = 3) {
      if (state.step !== "final") throw new Error("The final film isn't ready yet.");
      const link = await api(projectPath("/reviews"), json("POST", {permission: "approve", jobId: state.final.id, expectedOutputRevision: state.final.outputRevision, maxViews}));
      state = {...state, reviewUrl: link.reviewUrl, maxViews: link.maxViews};
      return state;
    },
  };
}

/**
 * What the creator sees beside each approval (HV-019-04). HV-030-29: for a feature, the running cost
 * of the sequence they are on and of the whole feature against its one film limit. A reel or a short
 * reads exactly as before.
 */
export function spendText(state) {
  const total = `$${(state.spend.spentUsd + state.spend.heldUsd).toFixed(2)} of its $${state.spend.capUsd.toFixed(2)} limit.`;
  const own = sequencesOf(state) && state.spend.sequences?.find(sequence => sequence.number === state.sequence);
  if (!own) return `Spent on this film so far: ${total}`;
  return `Sequence ${state.sequence} of ${state.sequences.length} so far: $${(own.spentUsd + own.heldUsd).toFixed(2)}. The whole feature so far: ${total}`;
}

export function initStudio({root, api, getProject, setProject, attach, assetUrl, storage}) {
  const node = (tag, text, className) => {const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element;};
  const button = (label, action, className) => {const element = node("button", label, className); element.type = "button"; element.onclick = action; return element;};
  const status = node("p", "", "status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const body = node("div");
  const tell = (message, error = false) => {status.textContent = message; status.dataset.state = error ? "error" : "working";};
  const flow = createStudioFlow({api, getProject, setProject, storage, onProgress: message => tell(message),
    fetchImage: async url => { const response = await fetch(assetUrl(url)); if (!response.ok) throw new Error("A storyboard still could not be read."); return response.arrayBuffer(); }});
  let draft = {};
  const pageHeading = node("h1", STEP_TITLES.pitch); pageHeading.tabIndex = -1;
  root.replaceChildren(pageHeading, node("p", "Paste a script, answer a few questions from the crew, and approve three times. The crew handles the rest.", "intro"), status, body);

  /**
   * HV-039-04: where the creator is after the studio rebuilds itself.
   *
   * The pitch is the page's own heading; every other step writes one of its own, and writing it is
   * what makes it the destination. A step that forgot to would land the creator on the page heading,
   * which is the old behaviour rather than a worse one.
   */
  let arrived = pageHeading;
  const heading = text => {const element = node("h2", text); element.tabIndex = -1; arrived = element; return element;};

  const run = async (action, busyMessage) => {
    for (const control of root.querySelectorAll("button,input,textarea,select")) control.disabled = true;
    tell(busyMessage);
    // The step the creator is on is replaced whole, so the control they pressed is gone by the time
    // this returns and the browser drops focus to the top of the document. Focus is put back on the
    // heading of whatever is now shown -- which is also why the live region is emptied on success:
    // the heading says the step's name, and saying it twice is worse than saying it once.
    try {await action(); render(); tell("");}
    catch (error) {tell(error.message || "Something went wrong. Try again.", true); render();}
    arrived.focus();
  };

  function renderPitch(state) {
    const form = node("form"), script = node("textarea"), tone = node("input"), rights = node("input"), format = node("select");
    script.id = "studio-script"; script.rows = 14; script.required = true; script.value = state.script ?? draft.script ?? "";
    const scriptLabel = node("label", "Your script (Fountain or plain screenplay text)"); scriptLabel.htmlFor = script.id;
    format.id = "studio-format"; for (const [value, label] of FORMAT_CHOICES) format.append(new Option(label, value));
    format.value = state.format ?? draft.format ?? "reel";
    const formatLabel = node("label", "What are we making?"); formatLabel.htmlFor = format.id;
    tone.id = "studio-tone"; tone.maxLength = 200; tone.placeholder = "For example: quiet and hopeful"; tone.value = state.tone ?? draft.tone ?? "";
    const toneLabel = node("label", "The tone, in a sentence (optional)"); toneLabel.htmlFor = tone.id;
    rights.type = "checkbox"; rights.id = "studio-rights";
    const rightsLabel = node("label", undefined, "attestation"); rightsLabel.append(rights, node("span", "I hold the rights to this script and it depicts no real person without their consent."));
    const submit = node("button", "Hand it to the crew"); submit.type = "submit";
    // HV-030-20: a style card is read only when the creator ticks it, and it starts unticked.
    const card = draft.styleCard ?? flow.savedStyleCard(), useCard = node("input"), cardFile = node("input");
    useCard.type = "checkbox"; useCard.id = "studio-style-card"; useCard.checked = Boolean(card && draft.useStyleCard);
    useCard.onchange = () => {if (useCard.checked && candidate && !tone.value.trim()) tone.value = candidate.tone ?? "";};
    const useCardLabel = node("label", undefined, "attestation"); useCardLabel.append(useCard, node("span", "Read my style card from an earlier film, so the crew starts from what I chose then."));
    cardFile.type = "file"; cardFile.id = "studio-style-card-file"; cardFile.accept = ".json,application/json";
    const cardFileLabel = node("label", "Or load a style card file"); cardFileLabel.htmlFor = cardFile.id;
    let candidate = card;
    cardFile.onchange = async () => {
      const chosen = cardFile.files?.[0];
      if (!chosen) return;
      const loaded = parseStyleCard(await chosen.text());
      if (!loaded) {tell("That file is not a style card the studio made.", true); return;}
      candidate = loaded; draft = {...draft, styleCard: loaded}; useCard.checked = true; useCard.onchange();
      tell("Loaded your style card. The crew will read it with this pitch.");
    };
    const cardPart = node("fieldset", undefined, "studio-style-card"); cardPart.append(node("legend", "Your style card (optional)"));
    if (card) cardPart.append(useCardLabel);
    cardPart.append(cardFileLabel, cardFile);
    if (!draft.styleCard && card) cardPart.append(button("Forget the style card kept in this browser",
      () => run(async () => {flow.forgetStyleCard(); draft = {...draft, script: script.value, format: format.value, tone: tone.value, useStyleCard: false};}, "Forgetting your style card."), "secondary"));
    form.append(scriptLabel, script, formatLabel, format, toneLabel, tone, rightsLabel, cardPart, submit);
    form.onsubmit = event => {event.preventDefault(); const styleCard = useCard.checked && candidate ? candidate : undefined;
      draft = {...draft, script: script.value, format: format.value, tone: tone.value, useStyleCard: Boolean(styleCard)};
      run(() => flow.pitch({script: script.value, format: format.value, tone: tone.value, rightsAttested: rights.checked, styleCard}), "The Producer is reading your script.");};
    const parts = [form];
    if (state.blocked?.length) {
      const list = node("ul", undefined, "studio-concerns");
      for (const concern of state.blocked) list.append(node("li", concern.detail));
      parts.unshift(heading(BLOCKED_TITLE), list);
    }
    body.replaceChildren(...parts);
  }

  function renderQuestions(state) {
    const {readThrough: result} = state, facts = result.facts;
    const minutes = facts.estimatedRuntimeSec >= 60 ? `${Math.round(facts.estimatedRuntimeSec / 6) / 10} min` : `${facts.estimatedRuntimeSec} s`;
    const summary = node("section", undefined, "studio-read-through");
    summary.append(node("h2", "The Producer's read-through"), node("p", result.logline, "logline"), node("p", result.summary),
      node("p", `${facts.scenes} scene(s), ${facts.shots} shot(s), about ${minutes}.` + (facts.estimate.finalVideoUsd !== null ? ` Final video about $${facts.estimate.finalVideoUsd.toFixed(2)} at today's prices.` : ""), "environment"));
    for (const concern of facts.concerns) summary.append(node("p", concern.detail, "environment"));
    // HV-030-25: questions the studio couldn't use (too long, an unknown crew member, past three each) are left out whole, and the creator is told how many.
    if (result.dropped > 0) summary.append(node("p", `${result.dropped} of the crew's questions couldn't be used and ${result.dropped === 1 ? "was" : "were"} left out.`, "environment"));
    const answers = new Map();
    const list = node("ol", undefined, "studio-questions");
    for (const question of result.questions) {
      answers.set(question.id, {id: question.id, accepted: true});
      const item = node("li"), reply = node("input"), accept = node("input"), other = node("input");
      const group = `studio-${question.id}`;
      accept.type = other.type = "radio"; accept.name = other.name = group; accept.checked = true;
      reply.maxLength = 400; reply.hidden = true; reply.setAttribute("aria-label", `Your answer to the ${PERSONA_TITLES[question.persona]}`);
      const acceptLabel = node("label"); acceptLabel.append(accept, node("span", `Sounds good: ${question.proposal}`));
      const otherLabel = node("label"); otherLabel.append(other, node("span", "Something else"));
      accept.onchange = () => {reply.hidden = true; answers.set(question.id, {id: question.id, accepted: true});};
      other.onchange = () => {reply.hidden = false; reply.focus(); answers.set(question.id, {id: question.id, accepted: false, reply: reply.value});};
      reply.oninput = () => answers.set(question.id, {id: question.id, accepted: false, reply: reply.value});
      item.append(node("strong", PERSONA_TITLES[question.persona]), node("p", question.question), acceptLabel, otherLabel, reply);
      list.append(item);
    }
    body.replaceChildren(summary, heading(STEP_TITLES.questions), list,
      button("Plan the film", () => run(() => flow.plan([...answers.values()]), "The crew is planning the film.")));
  }

  function renderLook(state) {
    const notes = node("ul", undefined, "studio-notes");
    for (const note of state.plan.notes) notes.append(node("li", `${PERSONA_TITLES[note.persona]}: ${note.change}`));
    const cast = node("ul", undefined, "studio-cast");
    for (const character of state.casting.characters) cast.append(node("li", `${character.name}: ${character.appearance || "as the script describes"}`));
    const attest = node("input"); attest.type = "checkbox"; attest.id = "studio-cast-attested";
    const attestLabel = node("label", undefined, "attestation");
    attestLabel.append(attest, node("span", "These are original characters I may use in this film."));
    const bible = styleBibleSummary(state.plan), summary = bible && node("ul", undefined, "studio-style-bible");
    if (bible) for (const line of bible.lines) summary.append(node("li", line));
    const parts = [sequencesOf(state) ? heading(stepTitle(state)) : heading(STEP_TITLES.look), node("p", state.plan.lookNote), notes,
      ...(bible ? [node("h3", bible.heading), summary] : []), node("h3", "The cast"), cast, spendLine(state)].filter(Boolean);
    if (state.pendingCast.length) parts.push(attestLabel);
    parts.push(button("Approve and draw the storyboard", () => run(() => flow.approveLook(attest.checked), "Starting the storyboard.")));
    body.replaceChildren(...parts);
  }

  function renderRoughCut(state) {
    const video = node("video"); video.controls = true; video.setAttribute("playsinline", "");
    const board = node("div", undefined, "storyboard-strip");
    for (const frame of state.animatic.storyboard ?? []) {
      const figure = node("figure"), image = node("img"); image.src = assetUrl(frame.url); image.alt = frame.caption; image.loading = "lazy";
      figure.append(image, node("figcaption", frame.caption.slice(0, 140))); board.append(figure);
    }
    body.replaceChildren(...[sequencesOf(state) ? heading(stepTitle(state)) : heading(STEP_TITLES["rough-cut"]), board, video, spendLine(state),
      // A finishing step that failed cost a note rather than the rough cut (HV-030-07), so say so.
      ...(state.lookNotes ?? []).map(note => node("p", note, "environment")),
      node("div", undefined, "review-actions")].filter(Boolean));
    const number = state.animatic.sequence?.number;
    body.lastChild.append(button(number ? `Approve and make sequence ${number}'s final` : "Approve and make the final film", () => run(() => flow.approveRoughCut(), number ? `Making sequence ${number}'s final.` : "Making the final film.")),
      button("Ask the crew for changes", () => run(() => flow.requestChanges(), "Taking it back to the crew."), "secondary"));
    const output = state.animatic.output; if (output) attach(video, assetUrl(output.hlsUrl), assetUrl(output.mp4Url), assetUrl(output.captionsUrl));
  }

  function renderFinal(state) {
    const video = node("video"); video.controls = true; video.setAttribute("playsinline", "");
    const views = node("input"); views.type = "number"; views.min = "1"; views.max = "25"; views.value = "3"; views.id = "studio-views";
    const viewsLabel = node("label", "Viewers allowed"); viewsLabel.htmlFor = views.id;
    const parts = [sequencesOf(state) ? heading(stepTitle(state)) : heading(STEP_TITLES.final), video, spendLine(state), ...(state.finishNotes ?? []).map(note => node("p", note, "environment"))].filter(Boolean);
    // HV-030-29: a feature's sequence is its own film until the last one is made. HV-030-30: then the
    // Editor joins them, and the joined feature is the one film downloaded and shared.
    const sequences = sequencesOf(state), number = state.sequence, joined = Boolean(sequences && state.joined);
    if (sequences && number < sequences.length) parts.push(button(`Approve sequence ${number} and make sequence ${number + 1}'s rough cut`,
      () => run(() => flow.nextSequence(), `Starting sequence ${number + 1}.`)));
    if (joined) parts.push(node("p", `All ${sequences.length} sequences are joined into one film${state.joinedTitled ? ", with its opening title and end credits" : ", without a title or credits"}.`, "environment"));
    if (sequences && number >= sequences.length && !joined) parts.push(button("Ask the Editor to join the sequences again", () => run(() => flow.joinAgain(), "Joining the sequences.")));
    if (state.final.output?.mp4Url) {const download = node("a", joined ? "Download the feature (MP4)" : sequences ? `Download sequence ${number} (MP4)` : "Download MP4"); download.href = assetUrl(state.final.output.mp4Url); download.download = ""; parts.push(download);}
    parts.push(viewsLabel, views, button(joined ? "Share the feature with a reviewer" : sequences ? `Share sequence ${number} with a reviewer` : "Share with a reviewer", () => run(() => flow.share(Number(views.value)), "Creating the review link.")));
    if (state.reviewUrl) parts.push(node("p", `${state.reviewUrl} — ${state.maxViews} viewer(s) can open it.`, "environment"));
    // HV-030-20: the crew's memory of this film, for the creator to keep. The studio keeps no copy.
    if (state.plan?.styleCard) {
      const file = flow.styleCardFile(), download = node("a", "Download my style card");
      download.href = `data:${file.type};charset=utf-8,${encodeURIComponent(file.text)}`; download.download = file.name;
      parts.push(node("h3", "Your style card"), node("p", "Keep what you chose for this film, and attach it to your next pitch so the crew starts from it. "
        + "It stays in this browser or in the file you download; the studio keeps no copy.", "environment"),
        state.styleCardKept ? node("p", "Kept in this browser.", "environment") : button("Keep my style card in this browser", () => run(async () => flow.keepStyleCard(), "Keeping your style card."), "secondary"),
        download);
    }
    body.replaceChildren(...parts);
    const output = state.final.output; if (output) attach(video, assetUrl(output.hlsUrl), assetUrl(output.mp4Url), assetUrl(output.captionsUrl));
  }

  const spendLine = state => state.spend ? node("p", spendText(state), "environment") : null;
  function render() {
    const state = flow.state;
    arrived = pageHeading;
    ({pitch: renderPitch, questions: renderQuestions, look: renderLook, "rough-cut": renderRoughCut, final: renderFinal})[state.step](state);
    // HV-016-09: what a resumed step could not bring back, said once, above the step itself.
    // HV-030-10: and, when the crew had already made what was asked for, that it was not paid for
    // again -- which is the good news the studio had been keeping to itself.
    if (state.reusedNote) body.prepend(node("p", state.reusedNote, "environment"));
    // HV-016-11: and, when a render is still running on the server, the way to wait for it.
    if (state.pending) body.prepend(button(state.pending.stage === "final" ? "Wait for my final film" : "Wait for my rough cut",
      () => run(() => flow.waitForPending(), state.pending.stage === "final" ? "Your final film is still being made." : "Your rough cut is still being made.")));
    if (state.resumedNote) body.prepend(node("p", state.resumedNote, "environment"));
  }
  render();
  /**
   * Rebuild the step from the project, for a link that was reopened (HV-016-09). The caller has a
   * project already; until this resolves the studio shows the pitch, which is what it showed before.
   */
  const resume = () => run(() => flow.resume(), "Opening your film.");
  return {flow, render, resume};
}
