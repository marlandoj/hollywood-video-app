/**
 * HV-030-07 — a finished film thrown away by the step after it, and paid for again.
 *
 * `studio.js` already states the rule, in `voiceFinal`'s own comment: "Idempotency keys are fixed
 * by line, character and voice policy, so a retry or a second pass never pays for a line twice."
 * Every cheap render in the file obeys it — `crew-voices-${cut.id}`, `crew-score-${cut.id}`,
 * `crew-titles-${cut.id}`. The three **picture** renders, which are the expensive ones, sent
 * `idempotencyKey: crypto.randomUUID()` on every attempt, which is the one value that cannot
 * dedupe anything.
 *
 * The server does not need to be told. `POST /projects/:id/jobs` with no key derives one from what
 * the render is of — `${stage}:${scriptVersion}:cast-${castingVersion}:direction-${directionVersion}`
 * — and returns the existing job for a repeat (`server.ts`, and `queue/src/index.ts:344` /
 * `storage/src/ledger.ts:98` behind it). The studio overrode that with a fresh UUID.
 *
 * On its own that would only have been a latent risk. What made it reachable is that
 * `approveRoughCut` ran `voiceFinal` **unguarded** between two siblings that were guarded, and
 * `approveLook` ran `pinStills` unguarded after the rough cut was already rendered. Either failing
 * threw out of the approval before the state assignment, so the paid film was dropped from state,
 * the step did not advance, and the only button left was the one that renders again.
 */
import {expect, test} from 'bun:test';
import {createStudioFlow} from '../src/studio.js';

const readThrough = () => ({facts: {concerns: [], scenes: 1, shots: 2, estimatedRuntimeSec: 4, estimate: {finalVideoUsd: 0.7}},
  logline: 'A reunion.', summary: 'Quiet.', questions: [{id: 'q1', persona: 'director', question: 'Hopeful?', proposal: 'Yes.'}],
  expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}});

/**
 * A fake that charges. `POST /jobs` obeys the server's own rule: a key the caller sent, or one
 * derived from the stage, the script version, the cast version and the direction version; a repeat
 * of an admitted key returns that job rather than admitting another. Every admitted picture render
 * is charged to a ledger, which is what the studio's own `/spend` then reports.
 */
function fake(overrides = {}) {
  const calls = [], admitted = [];
  let project = null, direction = 1, spent = 0;
  const price = stage => (stage === 'final' ? 8 : 1);
  const responses = {
    'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
    'PUT /api/projects/p1/script': () => ({version: 1}),
    'POST /api/projects/p1/rights': () => ({}),
    'POST /api/projects/p1/crew/read-through': () => readThrough(),
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [], finalAnchors: true}),
    'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters: []}}),
    'POST /api/projects/p1/jobs': body => {
      const stage = body.stage ?? 'animatic';
      const key = body.idempotencyKey ?? `${stage}:1:cast-1:direction-${direction}`;
      const existing = admitted.find(job => job.key === key);
      if (existing) return {jobId: existing.id};
      const job = {key, id: `${stage}-${admitted.filter(value => value.stage === stage).length + 1}`, stage};
      admitted.push(job); spent += price(stage);
      return {jobId: job.id};
    },
    'POST /api/projects/p1/animatic/decision': () => ({}),
    'GET /api/projects/p1/spend': () => ({spentUsd: spent, heldUsd: 0, capUsd: 40}),
    'GET /api/projects/p1/audio-takes': () => ({enabled: false}),
    'GET /api/projects/p1/graphics': () => ({rendering: {available: false, chromeVersion: '152.0.7977.75'}, library: {version: 0}, graphics: []}),
    // The pinning view: one directed shot with a still, nothing anchored yet.
    'GET /api/projects/p1/direction': () => ({scriptVersion: 1, direction: {version: direction, entries: [{source: {id: 's1'}, sourceHash: 'h1', settings: {}}]},
      plan: [{source: {id: 's1'}, sourceHash: 'h1'}], viewfinderSources: [{shotId: 's1', jobId: 'animatic-1', url: '/still.png'}]}),
    'POST /api/projects/p1/direction/s1/anchors?label=Storyboard%20still': () => ({asset: {id: 'a1'}}),
    'PUT /api/projects/p1/direction/s1': () => { direction += 1; return {direction: {version: direction}}; },
    ...overrides,
  };
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET', body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({method, path, body});
    if (/^GET \/api\/jobs\//.test(`${method} ${path}`) && !responses[`${method} ${path}`]) {
      const id = path.split('/').at(-1);
      return {id, status: 'done', outputRevision: 'r'.repeat(64), storyboard: [], output: {}};
    }
    const handler = responses[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(body);
  };
  const flow = createStudioFlow({api, getProject: () => project, setProject: value => { project = value; }, wait: async () => {},
    fetchImage: async () => new Uint8Array([137, 80, 78, 71]).buffer});
  const reach = async () => {
    await flow.pitch({script: 'INT. ROOM - DAY', format: 'reel', tone: 'warm', rightsAttested: true});
    await flow.plan([{id: 'q1', accepted: true}]);
    await flow.approveLook(true);
  };
  return {flow, calls, admitted, reach, spentUsd: () => spent,
    renders: stage => admitted.filter(job => job.stage === stage).length};
}

test('a finishing step that fails keeps the film it was finishing, and says so', async () => {
  // `voiceFinal`'s first call. Before this increment the throw left `approveRoughCut` before the
  // state assignment: step stayed `rough-cut`, `state.final` was undefined, and the finished final
  // render -- already paid for -- was gone from the studio's own state.
  const {flow, reach, renders} = fake({'GET /api/projects/p1/audio-takes': () => { throw new Error('the voice service is unavailable'); }});
  await reach();
  const state = await flow.approveRoughCut();
  expect(state.step).toBe('final');
  expect(state.final.id).toBe('final-1');
  expect(state.finishNotes.join(' ')).toContain('the cast\'s production voices could not be recorded');
  expect(state.finishNotes.join(' ')).toContain('the voice service is unavailable');
  expect(renders('final')).toBe(1);
});

test('and so does the approval before it, when pinning the storyboard stills fails', async () => {
  // `pinStills` runs after the rough cut has been rendered and polled, and could throw on the
  // fetch, the anchor upload or a direction version conflict. It threw out of `approveLook`.
  const {flow, reach, renders} = fake({'PUT /api/projects/p1/direction/s1': () => { throw new Error('the direction changed in another window'); }});
  await reach();
  expect(flow.state.step).toBe('rough-cut');
  expect(flow.state.animatic.id).toBe('animatic-1');
  expect(flow.state.lookNotes.join(' ')).toContain('storyboard stills could not be pinned');
  expect(renders('animatic')).toBe(1);
  // And the film goes on from there: the final is made from the rough cut that was kept.
  expect((await flow.approveRoughCut()).final.id).toBe('final-1');
});

test('the spend the creator reads before deciding is the spend after the render, not before it', async () => {
  // The number is on the screen the creator is looking at when they choose whether to press again.
  // It was refreshed only on the success path, so a failure left the pre-render figure on screen --
  // $1.00 spent, at the moment the next press would charge $8.
  const {flow, reach, spentUsd} = fake({'GET /api/projects/p1/audio-takes': () => { throw new Error('unavailable'); },
    // No frame anchors, so one rough cut at $1 and one final at $8 -- the shape the figures below describe.
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [], finalAnchors: false})});
  await reach();
  expect(flow.state.spend.spentUsd).toBe(spentUsd());
  await flow.approveRoughCut();
  expect(flow.state.spend.spentUsd).toBe(spentUsd());
  expect(spentUsd()).toBe(9);
});

test('and pressing a picture render twice admits one job, because the studio names no key', async () => {
  // The three picture renders send no `idempotencyKey`, so the server derives one from what the
  // render is *of*. Exhibited by driving the same approval twice against a fake that applies the
  // server's own rule: the second press is answered with the first job.
  const first = fake();
  await first.reach();
  const looks = first.calls.filter(call => call.path === '/api/projects/p1/jobs');
  expect(looks.every(call => call.body.idempotencyKey === undefined)).toBe(true);
  // The pinned re-cut is a second job, and correctly so: pinning moved the direction version, so
  // it is a different render by the same rule rather than a different key for the same render.
  expect(first.renders('animatic')).toBe(2);
  await first.flow.approveRoughCut();
  expect(first.renders('final')).toBe(1);

  // Now the retry. A `GET /api/jobs/...` that fails once is a lost connection mid-poll: the studio
  // throws, the creator presses the button again, and the second press must not be a second film.
  let polls = 0;
  const retry = fake({'GET /api/jobs/animatic-1': () => { polls += 1; if (polls === 1) throw new Error('the connection dropped'); return {id: 'animatic-1', status: 'done', storyboard: [], output: {}}; }});
  await retry.flow.pitch({script: 'INT. ROOM - DAY', format: 'reel', tone: 'warm', rightsAttested: true});
  await retry.flow.plan([{id: 'q1', accepted: true}]);
  await expect(retry.flow.approveLook(true)).rejects.toThrow('the connection dropped');
  expect(retry.flow.state.step).toBe('look');
  expect((await retry.flow.approveLook(true)).step).toBe('rough-cut');
  // Two presses, one rough cut -- plus the one pinned re-cut, which is its own render because the
  // pin moved the direction version (and which costs nothing: it makes no new pictures).
  expect(retry.renders('animatic')).toBe(2);
  expect(retry.admitted.map(job => job.key)).toEqual(['animatic:1:cast-1:direction-1', 'animatic:1:cast-1:direction-2']);
});

test('and no picture render in the studio mints a key that cannot dedupe', async () => {
  // Asserted over the source as well as the calls: every remaining `idempotencyKey` in this file is
  // fixed by what it renders -- the line and voice, the cut, the graphic's spec revision -- which is
  // the rule `voiceFinal`'s own comment states and which the picture renders broke.
  const source = await Bun.file(new URL('../src/studio.js', import.meta.url)).text();
  expect(source).not.toContain('idempotencyKey: crypto.randomUUID()');
  // HV-024-11 added the sixth: the generated music cue, keyed by the cut (`crew-music-<cut id>`; by its final since HV-030-39).
  // HV-024-14 moved the score's mix key into a `key` chosen between two keys, both fixed by the cut:
  // `crew-score-<cut id>`, and `crew-score-ambience-<cut id>` for a session with the studio's
  // ambience. The two mix keys are named here so neither can drift to a random one.
  // HV-030-30 added the seventh: the feature's join, keyed by the sequence films and graphics it joins.
  // HV-024-16: the cue's key moves to `crew-music-<final>-retry-<n>` only past a cue that was charged but not kept.
  // HV-030-37 added the eighth: a resumed feature's failed final, asked for again, keyed by its rough cut and the attempt.
  // HV-030-39 routes the five finishing keys -- the takes, the voices, the score, the titles and the join -- through
  // `askFinishing`, which sends each fixed key as it is, or, for a resumed feature whose job of that key died,
  // `<key>-retry-<n>`. So the keys are asserted where they are made: three literal keys, the helper's two, and
  // the five finishing steps, each with its key fixed by what it finishes.
  expect(source.match(/idempotencyKey: (`[^`]*`|\w+)/g)).toEqual(['idempotencyKey: base', 'idempotencyKey: key', 'idempotencyKey: `crew-music-${picture.id}`', 'idempotencyKey: `${request.idempotencyKey}-retry-${lost}`',
    'idempotencyKey: `crew-titles-${cut.id}`', 'idempotencyKey: `crew-final-${animatic.id}-retry-${stopped.length}`']);
  expect(source.match(/askFinishing\("[a-z-]+"/g)).toEqual(['askFinishing("titles"', 'askFinishing("join"', 'askFinishing("voice-take"', 'askFinishing("voices"', 'askFinishing("score"']);
  expect(source).toContain('askFinishing("voices", projectPath(`/dialogue/${final.id}`), `crew-voices-${final.id}`');
  expect(source).toContain('const key = `crew-voice-${line.sceneIndex}-${line.source.index}-${line.source.hash.slice(0, 16)}-${line.characterId.slice(0, 8)}-${voice.policyRevision.slice(0, 12)}`;');
  expect(source).toContain('const key = ambience.length ? `crew-score-ambience-${cut.id}` : `crew-score-${cut.id}`;');
  expect(source).toContain('const key = featureJoinKey([...films.map(film => film.id), titles?.title.id ?? "untitled", titles?.credits.id ?? "untitled"]);');
  expect(source).not.toMatch(/idempotencyKey:\s*crypto\./);
});
