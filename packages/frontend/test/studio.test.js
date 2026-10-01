/**
 * HV-030-03 -- the studio front door: script -> crew questions -> three approvals.
 * The flow is driven here through a fake network that records every call, so the
 * sequence of requests the studio makes is itself the assertion.
 */
import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BLOCKING_CONCERNS, PERSONA_TITLES, createStudioFlow} from '../src/studio.js';

const SRC = join(import.meta.dir, '..', 'src');
const UNTITLED = 'Editor: titles and credits were skipped because this studio has no graphics renderer installed; the film is shared untitled.';
const readThrough = (concerns = []) => ({facts: {concerns, scenes: 1, shots: 2, estimatedRuntimeSec: 4, estimate: {finalVideoUsd: 0.7}},
  logline: 'A reunion.', summary: 'Quiet.', questions: [{id: 'q1', persona: 'director', question: 'Hopeful?', proposal: 'Yes.'}, {id: 'q2', persona: 'sound', question: 'Music?', proposal: 'Light.'}],
  expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}});

function fake(overrides = {}) {
  const calls = [];
  let project = null;
  const responses = {
    'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
    'PUT /api/projects/p1/script': () => ({version: 1}),
    'POST /api/projects/p1/rights': () => ({}),
    'POST /api/projects/p1/crew/read-through': () => readThrough(),
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [{persona: 'casting', change: 'Cast Maya.'}]}),
    'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters: [{name: 'MAYA', kind: 'original-fictional', permission: {status: 'pending'}}]}}),
    'POST /api/projects/p1/crew/approve-cast': () => ({}),
    'POST /api/projects/p1/jobs': body => ({jobId: body.stage === 'final' ? 'final-1' : 'animatic-1'}),
    'GET /api/jobs/animatic-1': () => ({id: 'animatic-1', status: 'done', storyboard: [], output: {}}),
    'GET /api/jobs/final-1': () => ({id: 'final-1', status: 'done', outputRevision: 'r'.repeat(64), output: {}}),
    'POST /api/projects/p1/animatic/decision': () => ({}),
    'POST /api/projects/p1/reviews': body => ({reviewUrl: 'https://studio.test/#/review/x', maxViews: body.maxViews}),
    'GET /api/projects/p1/spend': () => ({spentUsd: 0, heldUsd: 0, capUsd: 40}),
    'GET /api/projects/p1/audio-takes': () => ({enabled: false}),
    'GET /api/projects/p1/sound-mixes/final-1': () => ({sourceRevision: 'sound-src', engineVersion: 'ffmpeg-sound', durationSec: 4}),
    'GET /api/projects/p1/sounds': () => ({library: {version: 0, assets: []}}),
    'POST /api/projects/p1/sounds': () => ({asset: {id: 'score-asset', revision: 'score-rev', label: 'x', original: {bytes: 1}, audio: {frames: 1_536_000}}}),
    'POST /api/projects/p1/sound-mixes/final-1': () => ({jobId: 'scored-1'}),
    'GET /api/jobs/scored-1': () => ({id: 'scored-1', status: 'done', outputRevision: 's'.repeat(64), output: {}}),
    // HV-025-03: by default this studio has no graphics renderer, so the film is not titled.
    'GET /api/projects/p1/graphics': () => ({rendering: {available: false, chromeVersion: '152.0.7977.75'}, library: {version: 0}, graphics: []}),
    ...overrides,
  };
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET', body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({method, path, body, auth: options.headers?.authorization});
    const handler = responses[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(body);
  };
  const images = [];
  const flow = createStudioFlow({api, getProject: () => project, setProject: value => { project = value; }, wait: async () => {},
    fetchImage: async url => { images.push(url); return new Uint8Array([137, 80, 78, 71]).buffer; }});
  return {flow, calls, images, route: () => calls.map(call => `${call.method} ${call.path}`)};
}

test('pitch -> questions -> plan -> look -> rough cut -> final -> share, in that order', async () => {
  const {flow, calls, route} = fake();
  expect((await flow.pitch({script: 'INT. ROOM - DAY', format: 'reel', tone: 'warm', rightsAttested: true})).step).toBe('questions');
  expect((await flow.plan([{id: 'q1', accepted: true}, {id: 'q2', accepted: false, reply: 'No music.'}])).step).toBe('look');
  expect(flow.state.pendingCast).toHaveLength(1);
  expect((await flow.approveLook(true)).step).toBe('rough-cut');
  expect((await flow.approveRoughCut()).step).toBe('final');
  expect((await flow.share(5)).reviewUrl).toBe('https://studio.test/#/review/x');
  expect(route()).toEqual([
    'POST /api/projects', 'PUT /api/projects/p1/script', 'POST /api/projects/p1/rights', 'POST /api/projects/p1/crew/read-through',
    'POST /api/projects/p1/crew/plan', 'GET /api/projects/p1/cast', 'GET /api/projects/p1/spend', 'POST /api/projects/p1/crew/approve-cast',
    'POST /api/projects/p1/jobs', 'GET /api/jobs/animatic-1', 'GET /api/projects/p1/spend', 'POST /api/projects/p1/animatic/decision', 'POST /api/projects/p1/jobs', 'GET /api/jobs/final-1',
    'GET /api/projects/p1/audio-takes', 'GET /api/projects/p1/graphics', 'GET /api/projects/p1/spend', 'POST /api/projects/p1/reviews']);
  // The creator answered the Composer "No music.", so nothing was scored.
  expect(flow.state.spend).toEqual({spentUsd: 0, heldUsd: 0, capUsd: 40});
  // Every call after the project exists carries its token.
  expect(calls.slice(1).every(call => call.auth === 'Bearer t1')).toBe(true);
  const plan = calls.find(call => call.path.endsWith('/crew/plan')).body;
  expect(plan.answers).toEqual([
    {id: 'q1', persona: 'director', question: 'Hopeful?', proposal: 'Yes.', accepted: true, reply: ''},
    {id: 'q2', persona: 'sound', question: 'Music?', proposal: 'Light.', accepted: false, reply: 'No music.'}]);
  expect(plan.expected).toEqual({scriptVersion: 1, castingVersion: 0, directionVersion: 0});
  expect(calls.find(call => call.path.endsWith('/approve-cast')).body).toEqual({attested: true, expectedVersion: 1});
  expect(calls.filter(call => call.path.endsWith('/jobs'))[1].body).toMatchObject({stage: 'final', animaticJobId: 'animatic-1'});
  expect(calls.at(-1).body).toMatchObject({permission: 'approve', jobId: 'final-1', maxViews: 5});
});

test('nothing is sent without the rights attestation or a script', async () => {
  const {flow, calls} = fake();
  await expect(flow.pitch({script: 'INT. ROOM - DAY', format: 'reel', tone: '', rightsAttested: false})).rejects.toThrow('rights');
  await expect(flow.pitch({script: '  ', format: 'reel', tone: '', rightsAttested: true})).rejects.toThrow('script');
  expect(calls).toEqual([]);
});

test('a script the crew cannot make stays at the pitch with the reason', async () => {
  for (const kind of BLOCKING_CONCERNS) {
    const {flow} = fake({'POST /api/projects/p1/crew/read-through': () => readThrough([{kind, detail: `blocked: ${kind}`}])});
    const state = await flow.pitch({script: 'INT. ROOM - DAY', format: 'reel', tone: '', rightsAttested: true});
    expect(state.step).toBe('pitch');
    expect(state.blocked.map(concern => concern.detail)).toEqual([`blocked: ${kind}`]);
    expect(state.script).toBe('INT. ROOM - DAY');
  }
  const {flow} = fake({'POST /api/projects/p1/crew/read-through': () => readThrough([{kind: 'over_format', detail: 'long'}])});
  expect((await flow.pitch({script: 'x', format: 'reel', tone: '', rightsAttested: true})).step).toBe('questions');
});

test('the crew never permits the cast; the creator must, before anything renders', async () => {
  const {flow, route} = fake();
  await flow.pitch({script: 'x', format: 'reel', tone: '', rightsAttested: true});
  await flow.plan([]);
  await expect(flow.approveLook(false)).rejects.toThrow('original characters');
  expect(route().some(entry => entry.endsWith('/jobs') || entry.endsWith('/approve-cast'))).toBe(false);
});

test('asking for changes takes the film back to the crew', async () => {
  const {flow, calls} = fake();
  await flow.pitch({script: 'x', format: 'short', tone: 'noir', rightsAttested: true});
  await flow.plan([]);
  await flow.approveLook(true);
  expect((await flow.requestChanges()).step).toBe('questions');
  expect(calls.find(call => call.path.endsWith('/animatic/decision')).body).toEqual({animaticJobId: 'animatic-1', decision: 'changes_requested'});
  expect(calls.filter(call => call.path.endsWith('/read-through')).at(-1).body).toEqual({format: 'short', tone: 'noir'});
});

test('a failed render is reported, not shown as done', async () => {
  const {flow} = fake({'GET /api/jobs/animatic-1': () => ({status: 'failed', failureReason: 'We can\'t generate this shot.'})});
  await flow.pitch({script: 'x', format: 'reel', tone: '', rightsAttested: true});
  await flow.plan([]);
  await expect(flow.approveLook(true)).rejects.toThrow("can't generate");
  expect(flow.state.step).toBe('look');
});

test('the page opens on the studio and keeps the Director\'s desk behind Advanced', () => {
  const page = readFileSync(join(SRC, 'index.html'), 'utf8');
  expect(page).toContain('<section id="studio" class="studio-panel" aria-label="Studio"></section>');
  expect(page).toContain('<section id="creator-flow" hidden>');
  expect(page).toContain('<input type="checkbox" id="advanced"> Advanced: Director\'s desk');
  expect(page).toContain('/api/studio/app.js');
  expect(Object.keys(PERSONA_TITLES)).toEqual(['producer', 'director', 'casting', 'cinematographer', 'sound', 'editor', 'continuity']);
  // Crew and creator text is assigned as text, never parsed as markup.
  expect(readFileSync(join(SRC, 'studio.js'), 'utf8')).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
});

// HV-017-06: with a final provider that starts from a given frame, the crew pins each still of
// the rough cut as its shot's first frame and re-cuts the rough cut from them.
test('the storyboard stills become the final\'s first frames when the final pool can use them', async () => {
  const entry = (id, extra = {}) => ({source: {id}, sourceHash: 'h-' + id, settings: {size: 'wide', durationFrames: 150, ...extra}});
  let jobs = 0;
  const {flow, calls, images, route} = fake({
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [], finalAnchors: true}),
    'POST /api/projects/p1/jobs': body => ({jobId: body.stage === 'final' ? 'final-1' : `animatic-${++jobs}`}),
    'GET /api/jobs/animatic-2': () => ({id: 'animatic-2', status: 'done', storyboard: [], output: {}}),
    'GET /api/projects/p1/direction': () => ({scriptVersion: 1, direction: {version: 1, entries: [entry('shot-1-1'), entry('shot-2-1', {frameAnchors: {frames: [], fallback: 'stop'}})]},
      plan: [{source: {id: 'shot-1-1'}, sourceHash: 'h-shot-1-1'}, {source: {id: 'shot-2-1'}, sourceHash: 'h-shot-2-1'}],
      viewfinderSources: [{shotId: 'shot-1-1', jobId: 'animatic-1', url: '/artifacts/x/shot-1-1.png'}, {shotId: 'shot-2-1', jobId: 'animatic-1', url: '/artifacts/x/shot-2-1.png'},
        {shotId: 'shot-3-1', jobId: 'older', url: '/artifacts/y/shot-3-1.png'}]}),
    'POST /api/projects/p1/direction/shot-1-1/anchors?label=Storyboard%20still': () => ({asset: {id: 'a1'}}),
    'PUT /api/projects/p1/direction/shot-1-1': () => ({direction: {version: 2}}),
  });
  await flow.pitch({script: 'x', format: 'reel', tone: '', rightsAttested: true});
  await flow.plan([]);
  expect((await flow.approveLook(true)).animatic.id).toBe('animatic-2');
  // Only the crew-directed, unanchored shot of this rough cut is pinned; the creator's own anchor and older renders are left.
  expect(images).toEqual(['/artifacts/x/shot-1-1.png']);
  expect(route().slice(8)).toEqual(['POST /api/projects/p1/jobs', 'GET /api/jobs/animatic-1', 'GET /api/projects/p1/direction',
    'POST /api/projects/p1/direction/shot-1-1/anchors?label=Storyboard%20still', 'PUT /api/projects/p1/direction/shot-1-1',
    'POST /api/projects/p1/jobs', 'GET /api/jobs/animatic-2', 'GET /api/projects/p1/spend']);
  const upload = calls.find(call => call.path.includes('/anchors'));
  expect(upload.body).toBeInstanceOf(ArrayBuffer);
  const put = calls.find(call => call.method === 'PUT' && call.path.endsWith('/direction/shot-1-1')).body;
  expect(put).toEqual({settings: {size: 'wide', durationFrames: 150, frameAnchors: {frames: [{at: 0, asset: {id: 'a1'}}], fallback: 'stop'}},
    sourceHash: 'h-shot-1-1', expectedVersion: 1, expectedScriptVersion: 1});
  await flow.approveRoughCut();
  expect(calls.filter(call => call.path.endsWith('/jobs')).at(-1).body).toMatchObject({stage: 'final', animaticJobId: 'animatic-2'});
});

// HV-022-03: the cast's production voices replace the temporary ones in the final.
test('the final is re-voiced with the cast\'s voices, one take per line, and shared as the voiced cut', async () => {
  const line = (sceneIndex, index, characterId, extra = {}) => ({sceneIndex, characterId, unavailable: null, performanceRevision: null,
    source: {index, hash: `hash-${sceneIndex}-${index}-${'x'.repeat(20)}`}, ...extra});
  let polls = 0;
  const takes = () => ({enabled: true, nativeCapabilityRevision: 'native-rev',
    characters: [{id: 'c-nora-000', profile: {voice: {id: 'en-US-JaneNeural'}}, voiceAvailable: true}, {id: 'c-teo-0000', profile: null, voiceAvailable: false}],
    voices: [{id: 'en-US-JaneNeural', provider: 'azure', policyRevision: 'policy-rev-0123456789'}],
    lines: [line(0, 0, 'c-nora-000'), line(1, 0, 'c-teo-0000'), line(1, 1, 'c-nora-000'), line(1, 2, 'c-nora-000', {unavailable: 'No permission.'})],
    jobs: [{id: 'take-a', status: polls > 1 ? 'done' : 'running'}, {id: 'take-b', status: polls > 1 ? 'failed' : 'queued'}]});
  let taken = 0;
  const {flow, calls} = fake({
    'GET /api/projects/p1/audio-takes': () => { polls++; return takes(); },
    'POST /api/projects/p1/audio-takes': () => ({jobId: ['take-a', 'take-b'][taken++]}),
    'GET /api/projects/p1/dialogue/final-1': () => ({sourceRevision: 'src', sourceFilesRevision: 'files', engineVersion: 'espeak', conversionEngineVersion: 'conv',
      lines: [{shotId: 'shot-1-1', index: 0, sourceHash: 'l1', auditions: [{jobId: 'old-take', revision: 'r0', unavailable: null}, {jobId: 'take-a', revision: 'ra', unavailable: null}]},
        {shotId: 'shot-2-1', index: 1, sourceHash: 'l2', auditions: [{jobId: 'take-b', revision: 'rb', unavailable: 'The take failed.'}]}]}),
    'POST /api/projects/p1/dialogue/final-1': () => ({jobId: 'voiced-1'}),
    'GET /api/jobs/voiced-1': () => ({id: 'voiced-1', status: 'done', outputRevision: 'v'.repeat(64), output: {}}),
  });
  await flow.pitch({script: 'x', format: 'reel', tone: '', rightsAttested: true});
  await flow.plan([]);
  await flow.approveLook(true);
  expect((await flow.approveRoughCut()).final.id).toBe('voiced-1');
  // One take per line with a voice: TEO has none, and the unavailable line is skipped.
  const posted = calls.filter(call => call.method === 'POST' && call.path.endsWith('/audio-takes')).map(call => call.body);
  expect(posted.map(body => [body.sceneIndex, body.lineIndex, body.voiceId])).toEqual([[0, 0, 'en-US-JaneNeural'], [1, 1, 'en-US-JaneNeural']]);
  expect(posted[0]).toMatchObject({generationApproved: true, characterId: 'c-nora-000', policyRevision: 'policy-rev-0123456789', nativeCapabilityRevision: 'native-rev',
    idempotencyKey: 'crew-voice-0-0-hash-0-0-xxxxxxx-c-nora-0-policy-rev-0'});
  // Only this pass's successful takes are laid, over the final's own dialogue.
  expect(calls.find(call => call.method === 'POST' && call.path.endsWith('/dialogue/final-1')).body).toEqual({idempotencyKey: 'crew-voices-final-1', generationApproved: true,
    sourceRevision: 'src', sourceFilesRevision: 'files', engineVersion: 'espeak', conversionEngineVersion: 'conv',
    edits: [{shotId: 'shot-1-1', index: 0, sourceHash: 'l1', auditionJobId: 'take-a', auditionRevision: 'ra'}]});
  await flow.share(3);
  expect(calls.at(-1).body).toMatchObject({jobId: 'voiced-1'});
});

test('without an authorized voice catalogue the final keeps its temporary voices and nothing is recorded', async () => {
  const {flow, route} = fake();
  await flow.pitch({script: 'x', format: 'reel', tone: '', rightsAttested: true});
  await flow.plan([]);
  await flow.approveLook(true);
  expect((await flow.approveRoughCut()).final.id).toBe('scored-1');
  expect(route().some(entry => entry.startsWith('POST') && (entry.endsWith('/audio-takes') || entry.includes('/dialogue/')))).toBe(false);
});

// HV-024-02: the Composer scores the finished cut with the application's own loop.
test('the Composer uploads its score once, loops it under the whole film, and the scored cut is shared', async () => {
  const {flow, calls, route} = fake();
  await flow.pitch({script: 'x', format: 'reel', tone: 'warm and hopeful', rightsAttested: true});
  await flow.plan([]);
  await flow.approveLook(true);
  const done = await flow.approveRoughCut();
  expect(done.final.id).toBe('scored-1');
  expect(done.finishNotes).toEqual([UNTITLED]);
  expect(route().slice(-7)).toEqual(['GET /api/projects/p1/sound-mixes/final-1', 'GET /api/projects/p1/sounds', 'POST /api/projects/p1/sounds',
    'POST /api/projects/p1/sound-mixes/final-1', 'GET /api/jobs/scored-1', 'GET /api/projects/p1/graphics', 'GET /api/projects/p1/spend']);
  const upload = calls.find(call => call.method === 'POST' && call.path.endsWith('/sounds'));
  expect(upload.body).toBeInstanceOf(Uint8Array);
  const mix = calls.find(call => call.method === 'POST' && call.path.endsWith('/sound-mixes/final-1')).body;
  expect(mix).toMatchObject({idempotencyKey: 'crew-score-final-1', generationApproved: true, sourceRevision: 'sound-src', engineVersion: 'ffmpeg-sound'});
  expect(mix.session.cues).toEqual([{id: 'final-1', assetId: 'score-asset', assetRevision: 'score-rev', role: 'music', start: 0, frames: 120 * 1600, trimIn: 0, trimOut: 1_536_000,
    loop: true, gainDb: -12, balance: 0, fadeIn: 48000, fadeOut: 48000, duckDb: -10, duckAttack: 12000, duckRelease: 28800}]);
  await flow.share(2);
  expect(calls.at(-1).body).toMatchObject({jobId: 'scored-1'});
});

test('an existing score is reused, and a failed mix keeps the film and says so', async () => {
  const asset = {id: 'kept', revision: 'kept-rev', label: 'Composer score hv-crew-score/1 major 72', original: {bytes: 44 + 8 * 4 * 48000 * 60 / 72 * 4}, audio: {frames: 1}};
  const {flow, route} = fake({'GET /api/projects/p1/sounds': () => ({library: {version: 4, assets: [asset]}}),
    'POST /api/projects/p1/sound-mixes/final-1': () => { throw new Error('The selected picture changed.'); }});
  await flow.pitch({script: 'x', format: 'reel', tone: 'warm', rightsAttested: true});
  await flow.plan([]);
  await flow.approveLook(true);
  const done = await flow.approveRoughCut();
  expect(route().includes('POST /api/projects/p1/sounds')).toBe(false);
  expect(done.final.id).toBe('final-1');
  expect(done.finishNotes).toEqual(['Composer: the score could not be mixed (The selected picture changed.); the film is shared without music.', UNTITLED]);
});

// HV-025-03: the Editor titles the scored cut with an opening title and closing credits.
const SCRIPT = 'Title: The Long Way Home\nAuthor: Ana Ruiz\n\nINT. KITCHEN - DAY\n\nMAYA pours tea.';
const SEQUENCE = '/api/projects/p1/editorial/sequences/crew-titles-scored-1';
const facts = (id, frames, extra = {}) => ({id, revision: 'f'.repeat(64), label: id, frames, width: 1280, height: 720, audio: [], captions: [], voices: [], unmeasuredAudio: false, ...extra});
function titling(overrides = {}) {
  const saved = [];
  const sequence = (version, history, clips = []) => ({libraryVersion: version, sequence: {id: 'crew-titles-scored-1', history: {revision: history}},
    timeline: {sources: [{id: 'scored-1'}, {id: 'g-title'}, {id: 'g-credits'}], clips}});
  const faked = fake({
    'GET /api/projects/p1/graphics': () => ({rendering: {available: true, chromeVersion: '152.0.7977.75'}, library: {version: 5}, graphics: []}),
    'GET /api/projects/p1/editorial/sources/scored-1': () => ({sources: [{jobId: 'scored-1', sourceRevision: 'rev-film',
      facts: facts('scored-1', 300, {audio: ['mix', 'dialogue', 'narration', 'music', 'ambience', 'effects']})}]}),
    'PUT /api/projects/p1/graphics': body => {
      saved.push(body);
      return {library: {version: body.expectedVersion + 1}, graphics: saved.map(value => ({available: true, spec: {id: value.change.id, label: value.change.label,
        plan: {...value.change.plan, revision: 'p'.repeat(64)}, revision: `${value.change.id}-revision-0123456789abcdef0123456789abcdef`}}))};
    },
    'POST /api/projects/p1/graphics/crew-title/renders': () => ({jobId: 'g-title'}),
    'POST /api/projects/p1/graphics/crew-credits/renders': () => ({jobId: 'g-credits'}),
    'GET /api/projects/p1/graphics/jobs/g-title': () => ({id: 'g-title', status: 'done'}),
    'GET /api/projects/p1/graphics/jobs/g-credits': () => ({id: 'g-credits', status: 'done'}),
    'GET /api/projects/p1/editorial/sources/g-title': () => ({sources: [{jobId: 'g-title', sourceRevision: 'rev-title', facts: facts('g-title', 120, {media: 'graphic-rgba'})}]}),
    'GET /api/projects/p1/editorial/sources/g-credits': () => ({sources: [{jobId: 'g-credits', sourceRevision: 'rev-credits', facts: facts('g-credits', 180, {media: 'graphic-rgba'})}]}),
    'GET /api/projects/p1/editorial': () => ({libraryVersion: 2, sequences: []}),
    'POST /api/projects/p1/editorial/sequences': () => sequence(3, 'h1'),
    [`PATCH ${SEQUENCE}`]: () => sequence(4, 'h2', [{id: 'crew-title'}, {id: 'crew-credits'}]),
    [`GET ${SEQUENCE}/renders`]: () => ({sequence: {historyRevision: 'h2'}, sourceBindingsRevision: 'bindings', engineVersion: 'engine', review: {speech: [], accepted: false}, unavailable: null}),
    [`POST ${SEQUENCE}/renders`]: () => ({jobId: 'titled-1'}),
    'GET /api/jobs/titled-1': () => ({id: 'titled-1', stage: 'picture-edit', status: 'done', outputRevision: 't'.repeat(64), output: {}}),
    ...overrides,
  });
  return {...faked, saved, sequence};
}
async function finish(flow) {
  await flow.pitch({script: SCRIPT, format: 'reel', tone: 'warm', rightsAttested: true});
  await flow.plan([]);
  await flow.approveLook(true);
  return flow.approveRoughCut();
}

test('without a graphics renderer the Editor skips the titles, says so, and shares the scored cut', async () => {
  const {flow, calls, route} = fake();
  const done = await finish(flow);
  expect(done.final.id).toBe('scored-1');
  expect(done.finishNotes).toEqual([UNTITLED]);
  expect(route().filter(entry => entry.includes('/graphics') || entry.includes('/editorial'))).toEqual(['GET /api/projects/p1/graphics']);
  await flow.share(2);
  expect(calls.at(-1).body).toMatchObject({jobId: 'scored-1'});
});

// HV-025-07: checking a long film as an editorial source takes minutes, so the API answers 202
// while it runs. The Editor waits for the receipt instead of giving up and sharing the film untitled.
test('the Editor waits while the film is still being checked, then titles it', async () => {
  let checks = 0;
  const {flow, route} = titling({'GET /api/projects/p1/editorial/sources/scored-1': () => {
    if (++checks < 3) return {inspecting: true, jobId: 'scored-1', startedAt: '2026-09-20T21:00:00.000Z'};
    return {sources: [{jobId: 'scored-1', sourceRevision: 'rev-film',
      facts: facts('scored-1', 300, {audio: ['mix', 'dialogue', 'narration', 'music', 'ambience', 'effects']})}]};
  }});
  const done = await finish(flow);
  expect(checks).toBe(3);
  expect(done.final.id).toBe('titled-1');
  expect(done.finishNotes).toEqual([]);
  expect(route().filter(entry => entry === 'GET /api/projects/p1/editorial/sources/scored-1')).toHaveLength(3);
});

test('the Editor titles and credits the scored cut, and the titled cut is shared', async () => {
  const {flow, calls, route, saved} = titling();
  const done = await finish(flow);
  expect(done.final.id).toBe('titled-1');
  expect(done.finishNotes).toEqual([]);
  expect(route().slice(route().indexOf('GET /api/jobs/scored-1') + 1)).toEqual(['GET /api/projects/p1/graphics',
    'GET /api/projects/p1/editorial/sources/scored-1',
    'PUT /api/projects/p1/graphics', 'POST /api/projects/p1/graphics/crew-title/renders', 'GET /api/projects/p1/graphics/jobs/g-title',
    'PUT /api/projects/p1/graphics', 'POST /api/projects/p1/graphics/crew-credits/renders', 'GET /api/projects/p1/graphics/jobs/g-credits',
    'GET /api/projects/p1/editorial/sources/g-title', 'GET /api/projects/p1/editorial/sources/g-credits', 'GET /api/projects/p1/editorial',
    'POST /api/projects/p1/editorial/sequences', `PATCH ${SEQUENCE}`, `GET ${SEQUENCE}/renders`, `POST ${SEQUENCE}/renders`, 'GET /api/jobs/titled-1',
    'GET /api/projects/p1/spend']);
  // The graphics: the title page's title, the writer, the crew, and the score that was mixed.
  expect(saved.map(body => [body.change.id, body.change.label, body.change.plan.kind, body.expectedVersion])).toEqual([
    ['crew-title', 'Editor: opening title', 'title', 5], ['crew-credits', 'Editor: closing credits', 'credits', 6]]);
  expect(saved[0].change.plan).toMatchObject({text: 'The Long Way Home', width: 1280, height: 720, frames: 120});
  expect(saved[1].change.plan.credits[0]).toEqual({role: 'Written by', name: 'Ana Ruiz'});
  expect(saved[1].change.plan.credits.at(-1)).toEqual({role: 'Original score', name: 'Composer (AI crew)'});
  expect(saved[1].change.plan.credits.some(row => row.role === 'Voices')).toBe(false);
  expect(calls.find(call => call.path.endsWith('/crew-title/renders')).body).toEqual({idempotencyKey: 'crew-title-crew-title-revision-0123456789ab',
    specRevision: 'crew-title-revision-0123456789abcdef0123456789abcdef', generationApproved: true});
  // The sequence: the finished cut first, both graphics, and one edit laying them in.
  expect(calls.find(call => call.path.endsWith('/editorial/sequences')).body).toEqual({id: 'crew-titles-scored-1', label: 'Editor: titles and credits',
    sources: [{jobId: 'scored-1', sourceRevision: 'rev-film'}, {jobId: 'g-title', sourceRevision: 'rev-title'}, {jobId: 'g-credits', sourceRevision: 'rev-credits'}],
    firstSourceId: 'scored-1', width: 1280, height: 720, expectedVersion: 2});
  const patch = calls.find(call => call.method === 'PATCH').body;
  expect(patch).toMatchObject({expectedVersion: 3, expectedHistoryRevision: 'h1', change: {kind: 'edit', operation: {kind: 'insert', rippleAt: 300, rippleFrames: 180}}});
  expect(patch.change.operation.clips.map(clip => [clip.id, clip.sourceId, clip.lane, clip.layer, clip.at])).toEqual([
    ['crew-title', 'g-title', 'picture', 1, 0], ['crew-credits', 'g-credits', 'picture', 0, 300], ['crew-credits-music', 'scored-1', 'music', 0, 300]]);
  expect(calls.find(call => call.method === 'POST' && call.path === `${SEQUENCE}/renders`).body).toEqual({idempotencyKey: 'crew-titles-scored-1', generationApproved: true,
    historyRevision: 'h2', sourceBindingsRevision: 'bindings', engineVersion: 'engine', review: {speech: [], accepted: true}});
  await flow.share(4);
  expect(calls.at(-1).body).toMatchObject({jobId: 'titled-1', expectedOutputRevision: 't'.repeat(64)});
});

test('a second pass reuses the saved graphics and the titled sequence instead of making new ones', async () => {
  const first = titling();
  await finish(first.flow);
  const graphics = first.saved.map(body => ({available: true, spec: {id: body.change.id, label: body.change.label, plan: {...body.change.plan, revision: 'p'.repeat(64)},
    revision: `${body.change.id}-revision-0123456789abcdef0123456789abcdef`}}));
  const {flow, route, sequence} = titling({
    'GET /api/projects/p1/graphics': () => ({rendering: {available: true}, library: {version: 7}, graphics}),
    'GET /api/projects/p1/editorial': () => ({libraryVersion: 4, sequences: [{id: 'crew-titles-scored-1'}]}),
    [`GET ${SEQUENCE}`]: () => sequence(4, 'h2', [{id: 'crew-title'}, {id: 'crew-credits'}]),
  });
  expect((await finish(flow)).final.id).toBe('titled-1');
  expect(route().some(entry => entry === 'PUT /api/projects/p1/graphics' || entry.startsWith('PATCH') || entry.endsWith('/editorial/sequences'))).toBe(false);
  expect(route()).toContain(`GET ${SEQUENCE}`);
});

test('a failed title render keeps the scored cut and the Editor says why', async () => {
  const {flow, calls} = titling({'GET /api/projects/p1/graphics/jobs/g-credits': () => ({id: 'g-credits', status: 'failed', failureReason: 'Graphic text exceeds its safe area.'})});
  const done = await finish(flow);
  expect(done.final.id).toBe('scored-1');
  expect(done.finishNotes).toEqual(['Editor: the title and credits could not be added (Graphic text exceeds its safe area.); the film is shared without them.']);
  expect(calls.some(call => call.path.includes('/editorial/sequences'))).toBe(false);
  await flow.share(1);
  expect(calls.at(-1).body).toMatchObject({jobId: 'scored-1'});
});
