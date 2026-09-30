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
import {CREDITS_CLIP_ID, CREDITS_GRAPHIC_ID, PERSONA_TITLES, TITLE_GRAPHIC_ID, creditRows, filmTitle, frameSize, samePlan, titleOperation, titlePlans} from "./titles.js";
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
/** The heading of whatever the studio now shows -- which is what the creator has arrived at. */
export const arrivalOf = state => state.step === "pitch" && state.blocked?.length ? BLOCKED_TITLE : STEP_TITLES[state.step];

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
 * already knew: `inspect`, one function over, caps at `INSPECTION_POLLS` and says "The Editor is
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
export const STYLE_CARD_SCHEMA = "hv-crew-style-card/1";
export const STYLE_CARD_FILE = "rough-cut-style-card.json";
/** A card from this device or a file, if it is the shape the studio made; the crew's own gate reads the words. */
export function parseStyleCard(text) {
  let card;
  try { card = typeof text === "string" ? JSON.parse(text) : null; } catch { return null; }
  return card && typeof card === "object" && !Array.isArray(card) && card.schema === STYLE_CARD_SCHEMA && ["reel", "short"].includes(card.format)
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
    const notes = [];
    // HV-022-03: the cast's production voices replace the temporary ones in the final. A failed
    // pass keeps the film and says so, which its two siblings below always did and it did not.
    let voiced = null;
    try { voiced = await voiceFinal(final); if (voiced) final = voiced; }
    catch (error) { notes.push(`Casting: the cast's production voices could not be recorded (${error.message}); the film keeps its temporary voices.`); }
    // HV-024-02: the Composer scores it. A failed mix keeps the voiced cut and says so.
    let scored = null;
    try { scored = await scoreFinal(final, state.tone); if (scored) final = scored; }
    catch (error) { notes.push(`Composer: the score could not be mixed (${error.message}); the film is shared without music.`); }
    // HV-025-03: the Editor titles it. A failure keeps the scored cut and says so.
    try { const titled = await titleFinal(final, {voiced: Boolean(voiced), scored: Boolean(scored)}); if (titled.cut) final = titled.cut; else notes.push(titled.note); }
    catch (error) { notes.push(`Editor: the title and credits could not be added (${error.message}); the film is shared without them.`); }
    state = {...state, step: "final", final, finishNotes: notes, reusedNote: reusedNote(), spend: await spend()};
    return state;
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
    const wanted = takes.lines.filter(line => {
      const character = line.characterId && characters.get(line.characterId);
      return !line.unavailable && character?.profile && character.voiceAvailable && policyFor(character.profile.voice.id);
    });
    if (!wanted.length) return null;
    onProgress(`The cast is recording ${wanted.length} line${wanted.length === 1 ? "" : "s"}.`);
    const ids = new Set();
    for (const line of wanted) {
      const voice = policyFor(characters.get(line.characterId).profile.voice.id);
      const key = `crew-voice-${line.sceneIndex}-${line.source.index}-${line.source.hash.slice(0, 16)}-${line.characterId.slice(0, 8)}-${voice.policyRevision.slice(0, 12)}`;
      const queued = await api(projectPath("/audio-takes"), json("POST", {idempotencyKey: key, generationApproved: true, sceneIndex: line.sceneIndex, lineIndex: line.source.index,
        sourceHash: line.source.hash, characterId: line.characterId, voiceId: voice.id, policyRevision: voice.policyRevision,
        ...(voice.provider === "azure" ? {nativeCapabilityRevision: takes.nativeCapabilityRevision} : {}), performanceRevision: line.performanceRevision ?? null}));
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
    const queued = await api(projectPath(`/dialogue/${final.id}`), json("POST", {idempotencyKey: `crew-voices-${final.id}`, generationApproved: true,
      sourceRevision: dialogue.sourceRevision, sourceFilesRevision: dialogue.sourceFilesRevision, engineVersion: dialogue.engineVersion,
      conversionEngineVersion: dialogue.conversionEngineVersion, edits}));
    return pollJob(queued.jobId);
  }

  /**
   * HV-024-02: the Composer's score, mixed under the finished cut: the application's own loop from
   * score.js, uploaded once to the project's sound library and reused, looped for the film's length,
   * faded in and out and ducked under every line. The request key is fixed by the cut, so a retry
   * never renders twice. "No music" from the creator skips it.
   */
  async function scoreFinal(cut, tone) {
    const direction = scoreDirection({tone, answers: answered});
    if (!direction.enabled) return null;
    const quote = await api(projectPath(`/sound-mixes/${cut.id}`), {headers: auth()});
    const record = scoreRecord(direction, 0), bytes = composeScore(direction);
    let {library} = await api(projectPath("/sounds"), {headers: auth()});
    let asset = library.assets.find(value => value.label === record.label && value.original.bytes === bytes.byteLength);
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
    onProgress("The Composer is scoring the film.");
    const frames = Math.round(quote.durationSec * 30) * 1600;
    const queued = await api(projectPath(`/sound-mixes/${cut.id}`), json("POST", {idempotencyKey: `crew-score-${cut.id}`, generationApproved: true,
      sourceRevision: quote.sourceRevision, engineVersion: quote.engineVersion,
      session: {reviewed: true, dialogueGainDb: 0, narrationGainDb: 0, cues: [{id: cut.id, assetId: asset.id, assetRevision: asset.revision, role: "music",
        start: 0, frames, trimIn: 0, trimOut: asset.audio.frames, loop: true, gainDb: direction.gainDb, balance: 0,
        fadeIn: Math.min(96000, Math.floor(frames / 4)), fadeOut: Math.min(144000, Math.floor(frames / 4)), duckDb: direction.duckDb, duckAttack: 12000, duckRelease: 28800}]}}));
    return pollJob(queued.jobId);
  }

  /**
   * HV-025-03: the Editor's opening title and closing credits. Both graphics are saved under fixed
   * ids and reused while their plan is unchanged; renders, the sequence and its export use keys
   * fixed by the spec and the cut, so a retry never renders twice. The result is a picture edit of
   * the finished cut: the title over its first seconds and the credits after its last frame, with
   * the Composer's music under them when the cut carries a music stem. Without the pinned graphics
   * browser on this studio, the film is shared untitled and the Editor says so.
   */
  async function titleFinal(cut, {voiced, scored}) {
    const graphics = await api(projectPath("/graphics"), {headers: auth()});
    if (!graphics.rendering?.available) return {note: "Editor: titles and credits were skipped because this studio has no graphics renderer installed; the film is shared untitled."};
    onProgress("The Editor is adding the title and credits.");
    // HV-025-07: checking a long film as an editorial source takes minutes, so the studio asks and
    // waits rather than holding a request open past what a socket allows.
    const inspect = async jobId => {
      for (let attempt = 0; attempt < INSPECTION_POLLS; attempt++) {
        const answer = await api(projectPath(`/editorial/sources/${jobId}`), {headers: auth()});
        if (answer.sources) return answer.sources[0];
        onProgress("The Editor is checking the film for the title and credits.");
        await wait(INSPECTION_INTERVAL_MS);
      }
      throw new Error("The Editor is still checking the film.");
    };
    const film = await inspect(cut.id), size = frameSize(film.facts), title = filmTitle(pitched, state.readThrough?.logline);
    const plans = titlePlans({...size, title, credits: creditRows({script: pitched, voiced, scored}), filmFrames: film.facts.frames});
    let version = graphics.library.version, current = graphics.graphics;
    const rendered = {};
    for (const [id, label, plan] of [[TITLE_GRAPHIC_ID, "Editor: opening title", plans.title], [CREDITS_GRAPHIC_ID, "Editor: closing credits", plans.credits]]) {
      let saved = current.find(graphic => graphic.spec.id === id);
      if (!saved?.available || saved.spec.label !== label || !samePlan(saved.spec.plan, plan)) {
        const result = await api(projectPath("/graphics"), json("PUT", {change: {kind: "save", id, label, plan}, expectedVersion: version}));
        version = result.library.version; current = result.graphics; saved = current.find(graphic => graphic.spec.id === id);
      }
      const queued = await api(projectPath(`/graphics/${id}/renders`), json("POST", {idempotencyKey: `${id}-${saved.spec.revision.slice(0, 32)}`, specRevision: saved.spec.revision, generationApproved: true}));
      rendered[id] = await pollJob(queued.jobId, projectPath(`/graphics/jobs/${queued.jobId}`));
    }
    const titleSource = await inspect(rendered[TITLE_GRAPHIC_ID].id), creditsSource = await inspect(rendered[CREDITS_GRAPHIC_ID].id);
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
      const plan = await api(projectPath("/crew/plan"), json("POST", {format, tone, answers: sent, expected: result.expected}));
      answered = sent;
      const cast = await api(projectPath("/cast"), {headers: auth()});
      // HV-016-15: the characters still waiting for the creator's permission. Not `pending`: that is the
      // render a resumed project left running, and `render` offers to wait for whatever it holds.
      state = {step: "look", format, tone, readThrough: result, ...(styleCard ? {styleCard} : {}), plan, casting: cast.casting, spend: await spend(),
        pendingCast: cast.casting.characters.filter(character => character.kind === "original-fictional" && character.permission.status === "pending")};
      return state;
    },

    /** Approval 1, the look: permit the crew's cast, then render the storyboard and rough cut. */
    async approveLook(attested) {
      if (state.step !== "look") throw new Error("Review the crew's plan first.");
      if (state.pendingCast.length && !attested) throw new Error("Confirm that the cast are original characters you may use.");
      if (state.pendingCast.length) await api(projectPath("/crew/approve-cast"), json("POST", {attested: true, expectedVersion: state.casting.version}));
      onProgress("The crew is drawing the storyboard and cutting the rough cut.");
      // HV-030-07: no request key. The server derives one from what the render is *of* --
      // `${stage}:${scriptVersion}:cast-${castingVersion}:direction-${directionVersion}` -- so
      // pressing the button twice admits one job. A `crypto.randomUUID()` here defeated that.
      const queued = await askForRender(projectPath("/jobs"), {});
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
        if (state.plan.finalAnchors) {
          const result = await pinStills(animatic), pinned = result.pinned;
          // What the note says follows what was saved, not whether something threw (HV-017-13).
          if (result.failure && !pinned) notes.push(`Cinematographer: the storyboard stills could not be pinned as the final's first frames (${result.failure.message}); the final begins from the script.`);
          if (result.failure && pinned) notes.push(`Cinematographer: ${pinned} storyboard still${pinned === 1 ? " was" : "s were"} pinned as the final's first frames and the rest could not be (${result.failure.message}); `
            + `those shot${pinned === 1 ? "" : "s"} begin from the still and the others from the script.`);
          if (pinned) {
            onProgress("The crew pinned the storyboard stills as the final's first frames.");
            const again = await askForRender(projectPath("/jobs"), {});
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
    },

    /** Approval 2, the rough cut: approve it and make the final, or send the crew back. */
    async approveRoughCut() {
      if (state.step !== "rough-cut") throw new Error("Watch the rough cut first.");
      await api(projectPath("/animatic/decision"), json("POST", {animaticJobId: state.animatic.id, decision: "approved"}));
      onProgress("Approved. The crew is making the final film.");
      const queued = await askForRender(projectPath("/jobs"), {stage: "final", animaticJobId: state.animatic.id});
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
    format.id = "studio-format"; for (const [value, label] of [["reel", "A reel, up to 90 seconds"], ["short", "A short film, up to 10 minutes"]]) format.append(new Option(label, value));
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
    const parts = [heading(STEP_TITLES.look), node("p", state.plan.lookNote), notes, node("h3", "The cast"), cast, spendLine(state)].filter(Boolean);
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
    body.replaceChildren(...[heading(STEP_TITLES["rough-cut"]), board, video, spendLine(state),
      // A finishing step that failed cost a note rather than the rough cut (HV-030-07), so say so.
      ...(state.lookNotes ?? []).map(note => node("p", note, "environment")),
      node("div", undefined, "review-actions")].filter(Boolean));
    body.lastChild.append(button("Approve and make the final film", () => run(() => flow.approveRoughCut(), "Making the final film.")),
      button("Ask the crew for changes", () => run(() => flow.requestChanges(), "Taking it back to the crew."), "secondary"));
    const output = state.animatic.output; if (output) attach(video, assetUrl(output.hlsUrl), assetUrl(output.mp4Url), assetUrl(output.captionsUrl));
  }

  function renderFinal(state) {
    const video = node("video"); video.controls = true; video.setAttribute("playsinline", "");
    const views = node("input"); views.type = "number"; views.min = "1"; views.max = "25"; views.value = "3"; views.id = "studio-views";
    const viewsLabel = node("label", "Viewers allowed"); viewsLabel.htmlFor = views.id;
    const parts = [heading(STEP_TITLES.final), video, spendLine(state), ...(state.finishNotes ?? []).map(note => node("p", note, "environment"))].filter(Boolean);
    if (state.final.output?.mp4Url) {const download = node("a", "Download MP4"); download.href = assetUrl(state.final.output.mp4Url); download.download = ""; parts.push(download);}
    parts.push(viewsLabel, views, button("Share with a reviewer", () => run(() => flow.share(Number(views.value)), "Creating the review link.")));
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

  const spendLine = state => state.spend ? node("p", `Spent on this film so far: $${(state.spend.spentUsd + state.spend.heldUsd).toFixed(2)} of its $${state.spend.capUsd.toFixed(2)} limit.`, "environment") : null;
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
