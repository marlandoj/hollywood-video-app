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

/** Up to about ten minutes of waiting for one source check (HV-025-07). */
const INSPECTION_POLLS = 120;

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
export function createStudioFlow({api, getProject, setProject, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), onProgress = () => {},
  fetchImage = async url => { const response = await fetch(url); if (!response.ok) throw new Error('A storyboard still could not be read.'); return response.arrayBuffer(); }}) {
  let state = {step: "pitch"};
  // The creator's last answers to the crew, which the Composer reads (HV-024-02).
  let answered = [];
  // The script as pitched, which the Editor reads for the title page (HV-025-03).
  let pitched = "";
  const auth = (extra = {}) => ({authorization: `Bearer ${getProject().token}`, ...extra});
  const json = (method, body) => ({method, headers: auth({"content-type": "application/json"}), body: JSON.stringify(body)});
  const projectPath = path => `/api/projects/${getProject().projectId}${path}`;

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

  /** Pins each still of this rough cut as its shot's first frame; only shots the crew directed and nobody anchored. */
  async function pinStills(animatic) {
    const view = await api(projectPath("/direction"), {headers: auth()});
    let version = view.direction.version, pinned = 0;
    for (const source of view.viewfinderSources.filter(value => value.jobId === animatic.id)) {
      const entry = view.direction.entries.find(value => value.source.id === source.shotId);
      const planned = view.plan.find(value => value.source.id === source.shotId);
      if (!entry || !planned || entry.settings.frameAnchors || entry.sourceHash !== planned.sourceHash) continue;
      const image = await fetchImage(source.url);
      const {asset} = await api(projectPath(`/direction/${encodeURIComponent(source.shotId)}/anchors?label=Storyboard%20still`), {method: "POST", body: image,
        headers: auth({"content-type": "image/png", "x-hv-reference-attested": "true", "x-hv-direction-version": String(version),
          "x-hv-script-version": String(view.scriptVersion), "x-hv-source-hash": planned.sourceHash})});
      const saved = await api(projectPath(`/direction/${encodeURIComponent(source.shotId)}`), json("PUT", {
        settings: {...entry.settings, frameAnchors: {frames: [{at: 0, asset}], fallback: "stop"}},
        sourceHash: planned.sourceHash, expectedVersion: version, expectedScriptVersion: view.scriptVersion}));
      version = saved.direction.version; pinned++;
    }
    return pinned;
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
    for (;;) {
      const jobs = (await api(projectPath("/audio-takes"), {headers: auth()})).jobs.filter(job => ids.has(job.id));
      if (jobs.length === ids.size && jobs.every(job => ["done", "failed", "cancelled"].includes(job.status))) break;
      onProgress(`The cast is recording: ${jobs.filter(job => job.status === "done").length} of ${ids.size} lines done.`);
      await wait(3000);
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
    while (!asset) {
      try {
        ({asset} = await api(projectPath("/sounds"), {method: "POST", body: bytes,
          headers: auth({"content-type": "audio/wav", "x-hv-sound-record": encodeURIComponent(JSON.stringify({...record, expectedVersion: library.version}))})}));
      } catch (error) {
        if (!/being processed/.test(error.message)) throw error;
        await wait(2000); ({library} = await api(projectPath("/sounds"), {headers: auth()}));
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
        await wait(5000);
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

  async function readThrough(format, tone) {
    const result = await api(projectPath("/crew/read-through"), json("POST", {format, tone}));
    const blocked = result.facts.concerns.filter(concern => BLOCKING_CONCERNS.includes(concern.kind));
    state = blocked.length ? {step: "pitch", format, tone, blocked, readThrough: result} : {step: "questions", format, tone, readThrough: result};
    return state;
  }

  return {
    get state() { return state; },

    /** Pitch: save the script, record the creator's rights attestation, and hand it to the crew. */
    async pitch({script, format, tone, rightsAttested}) {
      if (!script.trim()) throw new Error("Paste your script first.");
      if (!rightsAttested) throw new Error("Confirm that you hold the rights to this script.");
      if (!getProject()) setProject(await api("/api/projects", {method: "POST"}));
      await api(projectPath("/script"), json("PUT", {text: script}));
      await api(projectPath("/rights"), json("POST", {attested: true}));
      await readThrough(format, tone);
      pitched = script;
      state = {...state, script};
      return state;
    },

    /** Questions answered: the crew turns them into cast and shot direction. */
    async plan(answers) {
      if (state.step !== "questions") throw new Error("Answer the crew's questions first.");
      const {format, tone, readThrough: result} = state;
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
      state = {step: "look", format, tone, readThrough: result, plan, casting: cast.casting, spend: await spend(),
        pending: cast.casting.characters.filter(character => character.kind === "original-fictional" && character.permission.status === "pending")};
      return state;
    },

    /** Approval 1, the look: permit the crew's cast, then render the storyboard and rough cut. */
    async approveLook(attested) {
      if (state.step !== "look") throw new Error("Review the crew's plan first.");
      if (state.pending.length && !attested) throw new Error("Confirm that the cast are original characters you may use.");
      if (state.pending.length) await api(projectPath("/crew/approve-cast"), json("POST", {attested: true, expectedVersion: state.casting.version}));
      onProgress("The crew is drawing the storyboard and cutting the rough cut.");
      // HV-030-07: no request key. The server derives one from what the render is *of* --
      // `${stage}:${scriptVersion}:cast-${castingVersion}:direction-${directionVersion}` -- so
      // pressing the button twice admits one job. A `crypto.randomUUID()` here defeated that.
      const queued = await api(projectPath("/jobs"), json("POST", {}));
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
        if (state.plan.finalAnchors && await pinStills(animatic)) {
          onProgress("The crew pinned the storyboard stills as the final's first frames.");
          const again = await api(projectPath("/jobs"), json("POST", {}));
          animatic = await pollJob(again.jobId);
          state = {...state, animatic};
        }
      } catch (error) {
        notes.push(`Cinematographer: the storyboard stills could not be pinned as the final's first frames (${error.message}); the final begins from the script.`);
      }
      state = {...state, step: "rough-cut", animatic, lookNotes: notes, spend: await spend()};
      return state;
    },

    /** Approval 2, the rough cut: approve it and make the final, or send the crew back. */
    async approveRoughCut() {
      if (state.step !== "rough-cut") throw new Error("Watch the rough cut first.");
      await api(projectPath("/animatic/decision"), json("POST", {animaticJobId: state.animatic.id, decision: "approved"}));
      onProgress("Approved. The crew is making the final film.");
      const queued = await api(projectPath("/jobs"), json("POST", {stage: "final", animaticJobId: state.animatic.id}));
      let final = await pollJob(queued.jobId);
      // The final is paid for the moment it is done. It goes into the state here, before the three
      // finishing steps, so a failure in any of them costs a note rather than the film.
      state = {...state, step: "final", final};
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
      state = {...state, step: "final", final, finishNotes: notes, spend: await spend()};
      return state;
    },

    async requestChanges() {
      if (state.step !== "rough-cut") throw new Error("Watch the rough cut first.");
      await api(projectPath("/animatic/decision"), json("POST", {animaticJobId: state.animatic.id, decision: "changes_requested"}));
      return readThrough(state.format, state.tone);
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

export function initStudio({root, api, getProject, setProject, attach, assetUrl}) {
  const node = (tag, text, className) => {const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element;};
  const button = (label, action, className) => {const element = node("button", label, className); element.type = "button"; element.onclick = action; return element;};
  const status = node("p", "", "status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const body = node("div");
  const tell = (message, error = false) => {status.textContent = message; status.dataset.state = error ? "error" : "working";};
  const flow = createStudioFlow({api, getProject, setProject, onProgress: message => tell(message),
    fetchImage: async url => { const response = await fetch(assetUrl(url)); if (!response.ok) throw new Error("A storyboard still could not be read."); return response.arrayBuffer(); }});
  let draft = {};
  root.replaceChildren(node("h1", "Bring your script to the studio."), node("p", "Paste a script, answer a few questions from the crew, and approve three times. The crew handles the rest.", "intro"), status, body);

  const run = async (action, busyMessage) => {
    for (const control of root.querySelectorAll("button,input,textarea,select")) control.disabled = true;
    tell(busyMessage);
    try {await action(); render(); tell("");}
    catch (error) {tell(error.message || "Something went wrong. Try again.", true); render();}
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
    form.append(scriptLabel, script, formatLabel, format, toneLabel, tone, rightsLabel, submit);
    form.onsubmit = event => {event.preventDefault(); draft = {script: script.value, format: format.value, tone: tone.value}; run(() => flow.pitch({script: script.value, format: format.value, tone: tone.value, rightsAttested: rights.checked}), "The Producer is reading your script.");};
    const parts = [form];
    if (state.blocked?.length) {
      const list = node("ul", undefined, "studio-concerns");
      for (const concern of state.blocked) list.append(node("li", concern.detail));
      parts.unshift(node("h2", "The crew can't make this yet"), list);
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
    body.replaceChildren(summary, node("h2", "A few questions from the crew"), list,
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
    const parts = [node("h2", "Approval 1 of 3: the plan"), node("p", state.plan.lookNote), notes, node("h3", "The cast"), cast, spendLine(state)].filter(Boolean);
    if (state.pending.length) parts.push(attestLabel);
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
    body.replaceChildren(...[node("h2", "Approval 2 of 3: the storyboard and rough cut"), board, video, spendLine(state),
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
    const parts = [node("h2", "Approval 3 of 3: your film"), video, spendLine(state), ...(state.finishNotes ?? []).map(note => node("p", note, "environment"))].filter(Boolean);
    if (state.final.output?.mp4Url) {const download = node("a", "Download MP4"); download.href = assetUrl(state.final.output.mp4Url); download.download = ""; parts.push(download);}
    parts.push(viewsLabel, views, button("Share with a reviewer", () => run(() => flow.share(Number(views.value)), "Creating the review link.")));
    if (state.reviewUrl) parts.push(node("p", `${state.reviewUrl} — ${state.maxViews} viewer(s) can open it.`, "environment"));
    body.replaceChildren(...parts);
    const output = state.final.output; if (output) attach(video, assetUrl(output.hlsUrl), assetUrl(output.mp4Url), assetUrl(output.captionsUrl));
  }

  const spendLine = state => state.spend ? node("p", `Spent on this film so far: $${(state.spend.spentUsd + state.spend.heldUsd).toFixed(2)} of its $${state.spend.capUsd.toFixed(2)} limit.`, "environment") : null;
  function render() {
    const state = flow.state;
    ({pitch: renderPitch, questions: renderQuestions, look: renderLook, "rough-cut": renderRoughCut, final: renderFinal})[state.step](state);
  }
  render();
  return {flow, render};
}
