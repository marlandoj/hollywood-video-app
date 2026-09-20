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
export const BLOCKING_CONCERNS = ["public_figure", "content_policy", "empty_script"];
export const PERSONA_TITLES = {producer: "Producer", director: "Director", casting: "Casting", cinematographer: "Cinematographer", sound: "Composer and Sound", editor: "Editor"};

export function createStudioFlow({api, getProject, setProject, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), onProgress = () => {},
  fetchImage = async url => { const response = await fetch(url); if (!response.ok) throw new Error('A storyboard still could not be read.'); return response.arrayBuffer(); }}) {
  let state = {step: "pitch"};
  const auth = (extra = {}) => ({authorization: `Bearer ${getProject().token}`, ...extra});
  const json = (method, body) => ({method, headers: auth({"content-type": "application/json"}), body: JSON.stringify(body)});
  const projectPath = path => `/api/projects/${getProject().projectId}${path}`;

  async function pollJob(jobId) {
    for (;;) {
      const job = await api(`/api/jobs/${jobId}`, {headers: auth()});
      if (job.status === "done") return job;
      if (job.status === "failed" || job.status === "cancelled") throw new Error(job.failureReason || job.cancelReason || "The render stopped.");
      onProgress(job.status === "running" ? `Rendering: ${job.checkpointShots ?? 0} shot(s) done.` : "Waiting for a free render slot.");
      await wait(1500);
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
      const queued = await api(projectPath("/jobs"), json("POST", {idempotencyKey: crypto.randomUUID()}));
      let animatic = await pollJob(queued.jobId);
      // HV-017-06: when the final provider can start a clip from a given frame, the crew pins
      // each storyboard still as its shot's first frame, so the final begins from the picture
      // the creator approves. The rough cut is re-cut from the pinned stills (no new pictures).
      if (state.plan.finalAnchors && await pinStills(animatic)) {
        onProgress("The crew pinned the storyboard stills as the final's first frames.");
        const again = await api(projectPath("/jobs"), json("POST", {idempotencyKey: crypto.randomUUID()}));
        animatic = await pollJob(again.jobId);
      }
      state = {...state, step: "rough-cut", animatic, spend: await spend()};
      return state;
    },

    /** Approval 2, the rough cut: approve it and make the final, or send the crew back. */
    async approveRoughCut() {
      if (state.step !== "rough-cut") throw new Error("Watch the rough cut first.");
      await api(projectPath("/animatic/decision"), json("POST", {animaticJobId: state.animatic.id, decision: "approved"}));
      onProgress("Approved. The crew is making the final film.");
      const queued = await api(projectPath("/jobs"), json("POST", {idempotencyKey: crypto.randomUUID(), stage: "final", animaticJobId: state.animatic.id}));
      let final = await pollJob(queued.jobId);
      // HV-022-03: the cast's production voices replace the temporary ones in the final.
      const voiced = await voiceFinal(final);
      if (voiced) final = voiced;
      state = {...state, step: "final", final, spend: await spend()};
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
      node("div", undefined, "review-actions")].filter(Boolean));
    body.lastChild.append(button("Approve and make the final film", () => run(() => flow.approveRoughCut(), "Making the final film.")),
      button("Ask the crew for changes", () => run(() => flow.requestChanges(), "Taking it back to the crew."), "secondary"));
    const output = state.animatic.output; if (output) attach(video, assetUrl(output.hlsUrl), assetUrl(output.mp4Url), assetUrl(output.captionsUrl));
  }

  function renderFinal(state) {
    const video = node("video"); video.controls = true; video.setAttribute("playsinline", "");
    const views = node("input"); views.type = "number"; views.min = "1"; views.max = "25"; views.value = "3"; views.id = "studio-views";
    const viewsLabel = node("label", "Viewers allowed"); viewsLabel.htmlFor = views.id;
    const parts = [node("h2", "Approval 3 of 3: your film"), video, spendLine(state)].filter(Boolean);
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
