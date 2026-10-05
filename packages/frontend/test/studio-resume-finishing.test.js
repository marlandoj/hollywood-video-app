/**
 * HV-030-39 — a resumed feature redoes the finishing step that died, and keeps the ones that didn't.
 *
 * Release 3's live run: sequence 1's voices pass ("Laying the cast's voices into the final") hung in the
 * worker's upload. The studio gave up waiting on it after 30 minutes without progress, noted that the
 * film keeps its temporary voices, and asked for the score on the unvoiced final, which queued behind
 * the hung job. The operator cancels the hung job and resumes. Asked again with its key, the voices
 * pass is answered with the cancelled job for ever.
 *
 * The cast's takes need the operator's PostgreSQL audio service, so this drives the studio flow against
 * a fake of the routes it calls; `test/release-3-resume-finishing.test.ts` drives a cancelled score
 * through the real API and worker.
 */
import {expect, test} from 'bun:test';
import {createStudioFlow} from '../src/studio.js';

const HASH = 'h'.repeat(64), CHARACTER = 'c1aaaaaaaa', POLICY = 'p'.repeat(64);
const TAKE_KEY = `crew-voice-0-0-${HASH.slice(0, 16)}-${CHARACTER.slice(0, 8)}-${POLICY.slice(0, 12)}`;
const sequence = {number: 1, of: 1, firstScene: 1, lastScene: 1, planRevision: 'split'};

/** A one-sequence feature whose final f1 is made, its take t1 recorded, and whose voices pass is `voices`. */
function studio(voices, {music = false} = {}) {
  const calls = [], made = [];
  const jobs = [
    {id: 'a1', stage: 'animatic', status: 'done', sequence, idempotencyKey: 'p1:animatic:1'},
    {id: 'f1', stage: 'final', status: 'done', sequence, animaticJobId: 'a1', idempotencyKey: 'p1:final:1'},
    {id: 't1', stage: 'audio-take', status: 'done', idempotencyKey: `p1:${TAKE_KEY}`},
    ...voices,
    // The score the studio asked for on the unvoiced final once it gave up on the voices, queued behind them.
    {id: 's1', stage: 'sound-mix', status: 'queued', idempotencyKey: 'p1:crew-score-f1'},
  ];
  const admit = (prefix, body) => {
    const id = `${prefix}-${made.length + 1}`;
    made.push({id, key: body.idempotencyKey});
    return {jobId: id, admitted: true};
  };
  const known = key => jobs.find(job => job.idempotencyKey === `p1:${key}`);
  const routes = {
    'GET /api/projects/p1': () => ({script: 'Title: Voices\n\nINT. ROOM - DAY\n\nMARA\nHello.', jobs, animaticApprovals: [{animaticJobId: 'a1', decision: 'approved'}]}),
    'GET /api/projects/p1/feature-film': () => ({planRevision: 'split', size: {width: 1280, height: 720}, sequences: [{number: 1, firstScene: 1, lastScene: 1, final: {jobId: 'f1', frames: 60}}]}),
    'GET /api/projects/p1/cast': () => ({casting: {version: 2, characters: []}}),
    'GET /api/projects/p1/spend': () => ({spentUsd: 0, heldUsd: 0, capUsd: 150}),
    'GET /api/jobs/f1': () => jobs[1],
    'GET /api/projects/p1/audio-takes': () => ({enabled: true, nativeCapabilityRevision: 'n',
      characters: [{id: CHARACTER, profile: {voice: {id: 'v1'}}, voiceAvailable: true}], voices: [{id: 'v1', policyRevision: POLICY, provider: 'cartesia'}],
      lines: [{sceneIndex: 0, source: {index: 0, hash: HASH}, characterId: CHARACTER, unavailable: null, performanceRevision: null}], jobs: [{id: 't1', status: 'done'}]}),
    'POST /api/projects/p1/audio-takes': body => { const job = known(body.idempotencyKey); return job ? {jobId: job.id, admitted: false} : admit('take', body); },
    'GET /api/projects/p1/dialogue/f1': () => ({sourceRevision: 'sr', sourceFilesRevision: 'sf', engineVersion: 'e', conversionEngineVersion: 'c',
      lines: [{shotId: 's-1', index: 0, sourceHash: HASH, auditions: [{jobId: 't1', revision: 'tr'}]}]}),
    'POST /api/projects/p1/dialogue/f1': body => { const job = known(body.idempotencyKey); return job ? {jobId: job.id, admitted: false} : admit('voices', body); },
    'GET /api/projects/p1/sounds': () => ({library: {version: 1, assets: []}, music: music ? {generated: true} : null}),
    // The cue the Composer asked for when it scored the unvoiced final, answered again for its key.
    'POST /api/projects/p1/music-cues': () => ({asset: {id: 'cue', revision: 'r', audio: {frames: 48000}, label: 'cue', original: {bytes: 2}}, credit: 'generated'}),
    'POST /api/projects/p1/sounds': () => ({asset: {id: 'score', revision: 'r', audio: {frames: 48000}, label: 'x', original: {bytes: 1}}}),
    'GET /api/projects/p1/graphics': () => ({rendering: {available: false}, library: {version: 0}, graphics: []}),
    'POST /api/projects/p1/feature-film': body => admit('join', body),
  };
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET', body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({method, path, body});
    const handler = routes[`${method} ${path}`];
    if (handler) return handler(body);
    if (method === 'GET' && path.startsWith('/api/projects/p1/sound-mixes/')) return {durationSec: 2, sourceRevision: 'q', engineVersion: 'e'};
    if (method === 'POST' && path.startsWith('/api/projects/p1/ambience/')) return {cues: []};
    if (method === 'POST' && path.startsWith('/api/projects/p1/sound-mixes/')) { const job = known(body.idempotencyKey); return job ? {jobId: job.id, admitted: false} : admit('score', body); }
    if (method === 'GET' && path.startsWith('/api/jobs/')) {
      // A job still running finishes while it is waited on.
      const id = path.split('/').at(-1), job = jobs.find(value => value.id === id);
      return job ? {...job, status: job.status === 'running' ? 'done' : job.status} : {id, status: 'done', stage: id.split('-')[0], outputRevision: 'o'};
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  let project = {projectId: 'p1', token: 't'};
  const flow = createStudioFlow({api, getProject: () => project, setProject: value => { project = value; }, wait: async () => {}});
  return {flow, calls, made};
}

/**
 * Criteria 1 and 2: the voices pass the operator cancelled is asked for again under
 * `crew-voices-f1-retry-1`, on the final. The score is then asked for on the voiced cut, not on the
 * unvoiced final the studio scored when it gave up, with the music cue already made for that final. The
 * take already recorded is kept, and nothing
 * renders a picture. The flow's log says the voices were retried, which job they replace, and why.
 */
test('a resumed feature asks again for the voices pass the operator cancelled, then scores the voiced cut', async () => {
  const {flow, calls, made} = studio([{id: 'd1', stage: 'dialogue-replacement', status: 'cancelled', idempotencyKey: 'p1:crew-voices-f1', cancelReason: 'Cancelled by the operator: the upload hung.'}], {music: true});
  const state = await flow.resumeFeature({tone: 'warm and hopeful'});
  expect(calls.filter(call => call.method === 'POST' && call.path === '/api/projects/p1/jobs')).toEqual([]);
  expect(made.map(job => job.key)).toEqual(['crew-voices-f1-retry-1', 'crew-score-voices-1', expect.stringMatching(/^crew-feature-/)]);
  expect(calls.find(call => call.method === 'POST' && call.path === '/api/projects/p1/audio-takes').body.idempotencyKey).toBe(TAKE_KEY);
  // The generated cue is named by the final it scores, so the one already paid for scores the voiced cut.
  expect(calls.filter(call => call.path === '/api/projects/p1/music-cues').map(call => call.body.idempotencyKey)).toEqual(['crew-music-f1']);
  expect(state.finishes[1]).toMatchObject({voiced: true, scored: 'generated'});
  expect(state.finals[1].id).toBe('score-2');
  expect(state.joined).toBe(true);
  expect(flow.finishLog).toEqual([
    {sequence: 1, step: 'voices', how: 'retried', key: 'crew-voices-f1-retry-1', jobId: 'voices-1', retryOf: {jobId: 'd1', status: 'cancelled', reason: 'Cancelled by the operator: the upload hung.'}},
    {sequence: 1, step: 'score', how: 'made', key: 'crew-score-voices-1', jobId: 'score-2'},
    {sequence: null, step: 'join', how: 'made', key: made[2].key, jobId: 'join-3'}]);
});

/**
 * Criterion 1: a retry that is still running is the one waited on, not a third; a voices pass that
 * finished is kept. Neither is asked for under a new key.
 */
test('a voices retry still running is waited on, and a finished voices pass is kept', async () => {
  const running = studio([{id: 'd1', stage: 'dialogue-replacement', status: 'failed', idempotencyKey: 'p1:crew-voices-f1', failureReason: 'upload hung'},
    {id: 'd2', stage: 'dialogue-replacement', status: 'running', idempotencyKey: 'p1:crew-voices-f1-retry-1'}]);
  await running.flow.resumeFeature({tone: 'warm'});
  expect(running.flow.finishLog[0]).toEqual({sequence: 1, step: 'voices', how: 'waited', key: 'crew-voices-f1-retry-1', jobId: 'd2'});
  expect(running.made.map(job => job.key)).toEqual(['crew-score-d2', expect.stringMatching(/^crew-feature-/)]);
  const kept = studio([{id: 'd1', stage: 'dialogue-replacement', status: 'done', idempotencyKey: 'p1:crew-voices-f1'}]);
  await kept.flow.resumeFeature({tone: 'warm'});
  expect(kept.flow.finishLog[0]).toEqual({sequence: 1, step: 'voices', how: 'kept', key: 'crew-voices-f1', jobId: 'd1'});
});

/** With no earlier job of a key, the step is asked for with that key, as before; a flow that hasn't resumed logs nothing. */
test('a finishing step with no earlier job is asked for with its own key, and a fresh flow logs nothing', async () => {
  const {flow, calls} = studio([]);
  await flow.resumeFeature({tone: 'warm'});
  expect(calls.find(call => call.path === '/api/projects/p1/dialogue/f1' && call.method === 'POST').body.idempotencyKey).toBe('crew-voices-f1');
  const fresh = createStudioFlow({api: async () => { throw new Error('offline'); }, getProject: () => ({projectId: 'p1', token: 't'}), setProject: () => {}});
  expect(fresh.finishLog).toEqual([]);
});
