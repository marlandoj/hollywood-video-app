/**
 * HV-022-15 — the two loops in the studio that HV-030-08 did not reach.
 *
 * HV-030-08 gave `pollJob` a ceiling, and wrote down why: a job that never reaches a terminal status
 * "was polled every 1,500 ms for as long as the tab stayed open… a promise that never settles, and a
 * step of the studio that never advances". Two loops in the same file kept that shape.
 *
 *     for (;;) {                                        // voiceFinal: the cast's takes
 *       const jobs = (await api(…/audio-takes)).jobs.filter(job => ids.has(job.id));
 *       if (jobs.length === ids.size && jobs.every(terminal)) break;
 *       onProgress(…); await wait(3000);
 *     }
 *
 *     while (!asset) {                                  // scoreFinal: the score upload
 *       try { …POST /sounds… } catch (error) {
 *         if (!/being processed/.test(error.message)) throw error;
 *         await wait(2000); …
 *       }
 *     }
 *
 * The second is worse than it looks: "being processed" is the studio's 429, and the counter behind
 * it is **server-process-global**, so any other film's upload anywhere on that server keeps this
 * branch retrying.
 *
 * Both run inside `finishFinal`, after the final has been rendered and paid for, in the try/catch
 * that makes a failed finishing pass cost a note rather than the film. A hang never throws, so that
 * catch never runs: the creator was left on "The cast is recording: 1 of 4 lines done." with an
 * approval step that could not be reached. Waiting for ever is the one outcome a note cannot
 * describe — which is what these tests are about.
 */
import {expect, test} from 'bun:test';
import {INSPECTION_INTERVAL_MS, INSPECTION_LIMIT_MS, SOUND_UPLOAD_INTERVAL_MS, STALL_LIMIT_MS, TAKE_POLL_INTERVAL_MS, createStudioFlow} from '../src/studio.js';
import {readFileSync} from 'node:fs';

const readThrough = () => ({facts: {concerns: [], scenes: 1, shots: 2, estimatedRuntimeSec: 4, estimate: {finalVideoUsd: 0.7}},
  logline: 'A reunion.', summary: 'Quiet.', questions: [{id: 'q1', persona: 'director', question: 'Hopeful?', proposal: 'Yes.'},
    {id: 'q2', persona: 'sound', question: 'Music?', proposal: 'Light.'}],
  expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}});
/** One character with a production voice, and one line of theirs to record. */
const CAST = {characters: [{id: 'c1', profile: {voice: {id: 'v1'}}, voiceAvailable: true}],
  voices: [{id: 'v1', policyRevision: 'p'.repeat(16), provider: 'cartesia'}],
  lines: [{characterId: 'c1', sceneIndex: 0, source: {index: 0, hash: 'h'.repeat(64)}, performanceRevision: null}],
  nativeCapabilityRevision: 'n'.repeat(16)};

/** The studio driven to the final film, with the two waiting loops under the test's control. */
function fake(overrides = {}) {
  let project = null, waited = 0;
  const polls = {takes: 0, uploads: 0};
  const responses = {
    'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
    'PUT /api/projects/p1/script': () => ({version: 1}),
    'POST /api/projects/p1/rights': () => ({}),
    'POST /api/projects/p1/crew/read-through': () => readThrough(),
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [], finalAnchors: false}),
    'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters: []}}),
    'POST /api/projects/p1/jobs': body => ({jobId: body.stage === 'final' ? 'final-1' : 'animatic-1'}),
    'GET /api/jobs/animatic-1': () => ({id: 'animatic-1', status: 'done', storyboard: [], output: {}}),
    'GET /api/jobs/final-1': () => ({id: 'final-1', status: 'done', outputRevision: 'r'.repeat(64), output: {}}),
    'POST /api/projects/p1/animatic/decision': () => ({}),
    'GET /api/projects/p1/spend': () => ({spentUsd: 0, heldUsd: 0, capUsd: 40}),
    'GET /api/projects/p1/audio-takes': () => ({enabled: false}),
    'POST /api/projects/p1/audio-takes': () => ({jobId: 'take-1'}),
    'GET /api/projects/p1/dialogue/final-1': () => ({lines: []}),
    'GET /api/projects/p1/sound-mixes/final-1': () => ({sourceRevision: 'sound-src', engineVersion: 'ffmpeg-sound', durationSec: 4}),
    'GET /api/projects/p1/sounds': () => ({library: {version: 0, assets: []}}),
    'POST /api/projects/p1/sounds': () => ({asset: {id: 'score-asset', revision: 'score-rev', label: 'x', original: {bytes: 1}, audio: {frames: 1_536_000}}}),
    'POST /api/projects/p1/sound-mixes/final-1': () => ({jobId: 'scored-1'}),
    'GET /api/jobs/scored-1': () => ({id: 'scored-1', status: 'done', outputRevision: 's'.repeat(64), output: {}}),
    'GET /api/projects/p1/graphics': () => ({rendering: {available: false, chromeVersion: '152.0.7977.75'}, library: {version: 0}, graphics: []}),
    ...overrides,
  };
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET';
    const key = `${method} ${path}`;
    if (key === 'GET /api/projects/p1/audio-takes') polls.takes += 1;
    if (key === 'POST /api/projects/p1/sounds') polls.uploads += 1;
    const handler = responses[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    return handler(typeof options.body === 'string' ? JSON.parse(options.body) : options.body);
  };
  const flow = createStudioFlow({api, getProject: () => project, setProject: value => {project = value;},
    wait: async ms => {waited += ms;}, fetchImage: async () => new Uint8Array([137, 80, 78, 71]).buffer});
  const reach = async () => {
    await flow.pitch({script: 'INT. ROOM - DAY', format: 'reel', tone: 'warm', rightsAttested: true});
    await flow.plan([{id: 'q1', accepted: true}, {id: 'q2', accepted: true}]);
    await flow.approveLook(false);
    return flow.approveRoughCut();
  };
  return {reach, polls, waited: () => waited};
}

test('the two other loops stop on the same clock as the render does', () => {
  // One half-hour, three loops, three intervals each named where it is waited. Before this, two of
  // them spelled their interval out and neither had a ceiling at all.
  expect({limit: STALL_LIMIT_MS / 60000, takes: TAKE_POLL_INTERVAL_MS, uploads: SOUND_UPLOAD_INTERVAL_MS})
    .toEqual({limit: 30, takes: 3000, uploads: 2000});
  // The Editor's source check keeps its own, shorter clock, and it is now exactly what its comment
  // said: ten minutes, rather than 120 polls of a number written beside them.
  expect({minutes: INSPECTION_LIMIT_MS / 60000, interval: INSPECTION_INTERVAL_MS, polls: INSPECTION_LIMIT_MS / INSPECTION_INTERVAL_MS})
    .toEqual({minutes: 10, interval: 5000, polls: 120});
});

test('a cast recording that never moves stops being waited on, and costs a note rather than the film', async () => {
  // Before: this never returned. The film had already been rendered and paid for.
  const stuck = fake({'GET /api/projects/p1/audio-takes': () => ({enabled: true, ...CAST, jobs: [{id: 'take-1', status: 'queued'}]})});
  const state = await stuck.reach();
  expect(state.step).toBe('final');
  const note = state.finishNotes.find(text => text.startsWith('Casting:'));
  expect(note).toContain('has not moved for 30 minutes');
  expect(note).toContain('0 of 1 line(s) are done');
  expect(note).toContain('the film keeps its temporary voices');
  // It stops at the ceiling rather than somewhere near it: one poll per interval, no more. The first
  // read is `voiceFinal`'s own, before the loop.
  expect({polls: stuck.polls.takes, waited: stuck.waited()})
    .toEqual({polls: STALL_LIMIT_MS / TAKE_POLL_INTERVAL_MS + 2, waited: STALL_LIMIT_MS});
});

test('and a recording that is moving is waited on for as long as it keeps moving', async () => {
  // The distinction the ceiling turns on, as in `pollJob`: a status change resets the clock, so a
  // slow queue that is working is not given up on. Four times the ceiling, finishing inside it.
  const window = STALL_LIMIT_MS / TAKE_POLL_INTERVAL_MS;
  let reads = 0;
  const moving = fake({'GET /api/projects/p1/audio-takes': () => {
    reads += 1;
    if (reads === 1) return {enabled: true, ...CAST, jobs: []};
    if (reads >= window * 4) return {enabled: true, ...CAST, jobs: [{id: 'take-1', status: 'done'}]};
    return {enabled: true, ...CAST, jobs: [{id: 'take-1', status: reads % Math.floor(window - 1) === 0 ? 'running' : 'queued'}]};
  }});
  const state = await moving.reach();
  expect(state.step).toBe('final');
  expect(state.finishNotes.some(text => text.startsWith('Casting:'))).toBe(false);
  expect({polls: moving.polls.takes, beyondTheCeiling: moving.polls.takes > window}).toEqual({polls: window * 4, beyondTheCeiling: true});
});

test('and a sound library that stays busy stops being retried, and costs a note rather than the film', async () => {
  // "being processed" is the studio's 429 on a counter it keeps for the whole server, so this waits
  // on other films as well as on itself, and it waited without end.
  const busy = fake({'POST /api/projects/p1/sounds': () => {throw new Error('This sound library is being processed. Try again shortly.');}});
  const state = await busy.reach();
  expect(state.step).toBe('final');
  const note = state.finishNotes.find(text => text.startsWith('Composer:'));
  expect(note).toContain('has been busy for 30 minutes');
  expect(note).toContain('the film is shared without music');
  expect(busy.polls.uploads).toBe(STALL_LIMIT_MS / SOUND_UPLOAD_INTERVAL_MS);
});

test('and every loop in the studio that waits on the server has a ceiling', () => {
  // The guard on the shape rather than on the two that were wrong. A loop that waits is a loop that
  // can wait for ever, and this file is where a creator's whole session lives.
  const source = readFileSync(new URL('../src/studio.js', import.meta.url), 'utf8');
  const loops = [];
  for (const match of source.matchAll(/\n( *)(for|while) ?\(/g)) {
    const open = source.indexOf('{', match.index + match[0].length);
    let depth = 0, at = open;
    do {const character = source[at]; if (character === '{') depth += 1; else if (character === '}') depth -= 1; at += 1;} while (depth > 0 && at < source.length);
    // The header as well as the body: `inspect` carries its ceiling in the `for(...)`.
    loops.push(source.slice(match.index, at));
  }
  const waiting = loops.filter(loop => loop.includes('await wait('));
  // Four: the render, the cast's takes, the score upload and the Editor's source check. A fifth is
  // a decision, not an accident.
  expect(waiting.length).toBe(4);
  for (const loop of waiting) {
    // Each waits an interval with a name, and each gives up against a limit with a name.
    expect(loop).toMatch(/await wait\((POLL_INTERVAL_MS|TAKE_POLL_INTERVAL_MS|SOUND_UPLOAD_INTERVAL_MS|INSPECTION_INTERVAL_MS)\)/);
    expect(loop).toMatch(/STALL_LIMIT_MS|INSPECTION_POLLS/);
  }
  // And each of them ends in a refusal rather than in another turn of the loop.
  expect(source.match(/throw new Error\(/g).length).toBeGreaterThanOrEqual(4);
});
