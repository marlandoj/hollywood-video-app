/**
 * HV-022-24 — a feature with studio lip-sync on. Each sequence's voiced cut stops on the "lip-sync" step, and the
 * creator's decision there (approve or decline the hold) finishes that sequence from where it stopped: its film and
 * its finish are kept for the join, the Editor's sequence note is kept, and the run goes on to the next sequence. After
 * the last sequence's decision the Editor joins the feature. A resumed feature never stops on the step: it notes the
 * hold it did not ask for and queues nothing.
 *
 * Driven through a fake network that records every call, as `studio-feature-join.test.js` (a feature) and
 * `studio.test.js` (a reel's lip-sync step) are; the work list itself is `packages/api/test/studio-lipsync.test.ts`.
 */
import {expect, test} from 'bun:test';
import {createStudioFlow} from '../src/studio.js';

const SEQUENCES = [{number: 1, firstScene: 1, lastScene: 4, shots: 22}, {number: 2, firstScene: 5, lastScene: 9, shots: 24}, {number: 3, firstScene: 10, lastScene: 12, shots: 9}];
const ref = number => ({number, of: 3, firstScene: SEQUENCES[number - 1].firstScene, lastScene: SEQUENCES[number - 1].lastScene, planRevision: 'a'.repeat(64)});
const LIP_ITEMS = [
  {shotId: 'shot-1', lineIndex: 0, character: 'NORA', text: 'Hello.', included: true, reason: 'ready'},
  {shotId: 'shot-2', lineIndex: 0, character: 'NORA', text: 'Stay a while.', included: true, reason: 'ready'},
];
const lipView = () => ({enabled: true, unavailable: null, workList: {revision: 'w'.repeat(64), passes: 2, needFacePoint: 1, heldUsd: 10, heldUsdPerPass: 5, items: LIP_ITEMS},
  queued: [], failed: [], newPasses: 2, newHeldUsd: 10});
const VOICE = {id: 'en-US-JaneNeural', provider: 'azure', policyRevision: 'policy-rev-0123456789'};
// One line for NORA in each sequence's first scene, so each sequence's final is voiced.
const LINES = SEQUENCES.map(sequence => ({sceneIndex: sequence.firstScene - 1, characterId: 'c-nora-000', unavailable: null, performanceRevision: null,
  source: {index: 0, hash: `hash-${sequence.number}-${'x'.repeat(20)}`}}));
const takes = () => ({enabled: true, nativeCapabilityRevision: 'native-rev', characters: [{id: 'c-nora-000', profile: {voice: {id: VOICE.id}}, voiceAvailable: true}],
  voices: [VOICE], lines: LINES, jobs: LINES.map(line => ({id: `take-${line.sceneIndex}`, status: 'done'}))});

const APPROVED = 'Lip-sync: 2 on-camera lines are queued as lip-sync versions of the voiced cut ($10.00 held), each for you to review under Direct lip-sync; '
  + 'the film here keeps its voiced cut. 1 on-camera line needs a face point chosen under Direct lip-sync first.';
const DECLINED = 'Lip-sync: you kept the voiced cut without lip-sync, so nothing was queued or held. The 2 on-camera lines ready for it can be lip-synced later under Direct lip-sync. '
  + '1 on-camera line needs a face point chosen under Direct lip-sync first.';
const SCORE = 'Composer: the score could not be mixed (the mixer is down); the film is shared without music.';
const SEQUENCE_NOTE = 'Editor: a sequence carries no title or credits. They belong to the whole feature, which the Editor joins into one film after the last sequence.';

/** A three-sequence feature whose finals are voiced, each voiced cut marked `studioLipSync` (and, as the server sends it, carrying no sequence). */
function fake() {
  const calls = [], jobs = new Map();
  let project = null, next = 0;
  const routes = {
    'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
    'PUT /api/projects/p1/script': () => ({version: 1}),
    'POST /api/projects/p1/rights': () => ({}),
    'POST /api/projects/p1/crew/read-through': () => ({facts: {concerns: [], scenes: 12, shots: 55, estimatedRuntimeSec: 110, estimate: {finalVideoUsd: 23.1}},
      logline: 'A long night.', summary: 'Long.', questions: [], expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}}),
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [], finalAnchors: false,
      sequences: {source: 'stand-in', revision: 'a'.repeat(64), sequences: SEQUENCES}}),
    'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters: []}}),
    'POST /api/projects/p1/jobs': body => {
      const id = `${body.stage === 'final' ? 'final' : 'animatic'}-${++next}`;
      const sequence = body.stage === 'final' ? jobs.get(body.animaticJobId).sequence : ref(body.sequence);
      jobs.set(id, {id, stage: body.stage ?? 'animatic', status: 'done', storyboard: [], output: {}, outputRevision: 'r'.repeat(64), sequence});
      return {jobId: id};
    },
    'POST /api/projects/p1/animatic/decision': () => ({}),
    'GET /api/projects/p1/spend': () => ({spentUsd: 1.5, heldUsd: 0, capUsd: 150}),
    'GET /api/projects/p1/audio-takes': takes,
    'POST /api/projects/p1/audio-takes': body => ({jobId: `take-${body.sceneIndex}`}),
    'GET /api/projects/p1/graphics': () => ({rendering: {available: false}, library: {version: 0}, graphics: []}),
    'GET /api/projects/p1/feature-film': () => ({planRevision: 'a'.repeat(64), size: {width: 1280, height: 720}, crossfadeFrames: 12, costUsd: 0, jobs: [],
      sequences: SEQUENCES.map(sequence => ({...sequence, final: {jobId: `final-${2 * sequence.number}`, frames: 600}}))}),
    'POST /api/projects/p1/feature-film': () => {
      jobs.set('joined-1', {id: 'joined-1', stage: 'feature-film', status: 'done', outputRevision: 'j'.repeat(64), output: {mp4Url: '/joined.mp4'}});
      return {jobId: 'joined-1', admitted: true};
    },
  };
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET', body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({method, path, body});
    if (method === 'GET' && path.startsWith('/api/jobs/')) return jobs.get(path.slice('/api/jobs/'.length));
    const handler = routes[`${method} ${path}`];
    if (handler) return handler(body);
    const dialogue = path.match(/^\/api\/projects\/p1\/dialogue\/(final-\d+)$/);
    if (dialogue && method === 'GET') {
      const take = `take-${jobs.get(dialogue[1]).sequence.firstScene - 1}`;
      return {sourceRevision: 'src', sourceFilesRevision: 'files', engineVersion: 'espeak', conversionEngineVersion: 'conv',
        lines: [{shotId: 'shot-1', index: 0, sourceHash: 'l1', auditions: [{jobId: take, revision: 'ra', unavailable: null}]}]};
    }
    if (dialogue && method === 'POST') {
      const id = `voiced-${dialogue[1]}`;
      jobs.set(id, {id, stage: 'dialogue-replacement', status: 'done', outputRevision: 'v'.repeat(64), output: {}, studioLipSync: true});
      return {jobId: id};
    }
    if (/^\/api\/projects\/p1\/lip-sync\/voiced-final-\d+\/work-list$/.test(path)) {
      if (method === 'GET') return lipView();
      return {admitted: [{jobId: `lip-${calls.length}-a`}, {jobId: `lip-${calls.length}-b`}], reused: [], skipped: [], heldUsd: body.holdApprovedUsd, actualUsd: null};
    }
    if (path.startsWith('/api/projects/p1/sound-mixes/')) throw new Error('the mixer is down');
    throw new Error(`unexpected ${method} ${path}`);
  };
  const flow = createStudioFlow({api, getProject: () => project, setProject: value => { project = value; }, wait: async () => {}});
  return {flow, calls};
}

async function toFirstSequence(flow) {
  await flow.pitch({script: 'Title: The Long Night\nAuthor: Ana Ruiz\n\nINT. ROOM - DAY', format: 'feature', tone: '', rightsAttested: true});
  await flow.plan([]);
  await flow.approveLook(true);
  return flow.approveRoughCut();
}
const decide = (flow, decision) => (decision === 'approve' ? flow.approveLipSync() : flow.declineLipSync());
const NOTE = {approve: APPROVED, decline: DECLINED};
const joins = calls => calls.filter(call => call.method === 'POST' && call.path === '/api/projects/p1/feature-film');
const queues = calls => calls.filter(call => call.method === 'POST' && call.path.includes('/lip-sync/')).map(call => call.path);
const renders = calls => calls.filter(call => call.method === 'POST' && call.path === '/api/projects/p1/jobs').map(call => call.body);

for (const decision of ['approve', 'decline']) {
  test(`paused on sequence 1 of 3, the creator's ${decision} keeps the voiced cut as that sequence's film, keeps the Editor's note, and sequence 2 follows`, async () => {
    const {flow, calls} = fake();
    const paused = await toFirstSequence(flow);
    expect([paused.step, paused.sequence, paused.final.id]).toEqual(['lip-sync', 1, 'voiced-final-2']);
    // Nothing of the sequence is kept for the join until the creator decides.
    expect(paused.finals?.[1]).toBeUndefined();
    expect(paused.finishes?.[1]).toBeUndefined();
    const done = await decide(flow, decision);
    expect([done.step, done.sequence, done.final.id]).toEqual(['final', 1, 'voiced-final-2']);
    expect(done.lipSync).toBeUndefined();
    // The sequence is read from the picture (the final), not from the voiced cut, which carries none.
    expect(done.finals[1].id).toBe('voiced-final-2');
    expect(done.finishes[1]).toEqual({voiced: true, scored: false, ambience: false, notes: [NOTE[decision], SCORE]});
    expect(done.finishNotes).toEqual([NOTE[decision], SCORE, SEQUENCE_NOTE]);
    expect(queues(calls)).toEqual(decision === 'approve' ? ['/api/projects/p1/lip-sync/voiced-final-2/work-list'] : []);
    // Not the last sequence, so nothing is joined.
    expect(done.joined).toBeUndefined();
    expect(joins(calls)).toEqual([]);
    // The run goes on to sequence 2 as it would without lip-sync.
    const second = await flow.nextSequence();
    expect([second.step, second.sequence, second.finals[1].id]).toEqual(['rough-cut', 2, 'voiced-final-2']);
    expect(renders(calls)).toEqual([{sequence: 1}, {stage: 'final', animaticJobId: 'animatic-1', sequence: 1}, {sequence: 2}]);
    expect((await flow.approveRoughCut())).toMatchObject({step: 'lip-sync', sequence: 2, final: {id: 'voiced-final-4'}});
  });

  test(`paused on the last sequence, the creator's ${decision} is followed by the join of every sequence's voiced cut`, async () => {
    const {flow, calls} = fake();
    let state = await toFirstSequence(flow);
    for (const number of [1, 2]) {
      expect([state.step, state.sequence]).toEqual(['lip-sync', number]);
      await decide(flow, number === 1 ? 'approve' : 'decline');
      state = await flow.nextSequence();
      state = await flow.approveRoughCut();
    }
    expect([state.step, state.sequence, state.final.id]).toEqual(['lip-sync', 3, 'voiced-final-6']);
    // The last sequence waits on the creator: the feature is not joined yet.
    expect(joins(calls)).toEqual([]);
    const decided = calls.length;
    const done = await decide(flow, decision);
    const joined = joins(calls);
    expect(joined).toHaveLength(1);
    expect(calls.indexOf(joined[0])).toBeGreaterThanOrEqual(decided);
    if (decision === 'approve') expect(calls.findIndex(call => call.method === 'POST' && call.path === '/api/projects/p1/lip-sync/voiced-final-6/work-list')).toBeLessThan(calls.indexOf(joined[0]));
    // Every sequence's film is its voiced cut, joined in order.
    expect(joined[0].body.sequences).toEqual([{number: 1, jobId: 'voiced-final-2'}, {number: 2, jobId: 'voiced-final-4'}, {number: 3, jobId: 'voiced-final-6'}]);
    expect([done.step, done.joined, done.final.id, done.finals[3].id]).toEqual(['final', true, 'joined-1', 'voiced-final-6']);
    expect(done.finishes[3]).toEqual({voiced: true, scored: false, ambience: false, notes: [NOTE[decision], SCORE]});
    // Each earlier sequence's decision is said on the feature; the last sequence carries no "no title" note.
    expect(done.finishNotes).toEqual([`Sequence 1 of 3: ${APPROVED}`, `Sequence 1 of 3: ${SCORE}`, `Sequence 2 of 3: ${DECLINED}`, `Sequence 2 of 3: ${SCORE}`,
      NOTE[decision], SCORE, 'Editor: titles and credits were skipped because this studio has no graphics renderer installed; the feature is joined untitled.']);
    expect(queues(calls)).toEqual(['/api/projects/p1/lip-sync/voiced-final-2/work-list', ...(decision === 'approve' ? ['/api/projects/p1/lip-sync/voiced-final-6/work-list'] : [])]);
  });
}

/** A resumed two-sequence feature, both finals made and their takes recorded, its voiced cuts marked `studioLipSync`. */
function resumed(view = lipView) {
  const calls = [];
  const sequence = number => ({number, of: 2, firstScene: number, lastScene: number, planRevision: 'split'});
  const jobs = [
    {id: 'a1', stage: 'animatic', status: 'done', sequence: sequence(1), idempotencyKey: 'p1:animatic:1'},
    {id: 'f1', stage: 'final', status: 'done', sequence: sequence(1), animaticJobId: 'a1', idempotencyKey: 'p1:final:1'},
    {id: 'a2', stage: 'animatic', status: 'done', sequence: sequence(2), idempotencyKey: 'p1:animatic:2'},
    {id: 'f2', stage: 'final', status: 'done', sequence: sequence(2), animaticJobId: 'a2', idempotencyKey: 'p1:final:2'},
  ];
  const lines = [0, 1].map(sceneIndex => ({sceneIndex, characterId: 'c-nora-000', unavailable: null, performanceRevision: null, source: {index: 0, hash: `hash-${sceneIndex}-${'x'.repeat(20)}`}}));
  const routes = {
    'GET /api/projects/p1': () => ({script: 'Title: Voices\n\nINT. ROOM - DAY\n\nNORA\nHello.', jobs, animaticApprovals: ['a1', 'a2'].map(animaticJobId => ({animaticJobId, decision: 'approved'}))}),
    'GET /api/projects/p1/feature-film': () => ({planRevision: 'split', size: {width: 1280, height: 720},
      sequences: [1, 2].map(number => ({number, firstScene: number, lastScene: number, final: {jobId: `f${number}`, frames: 60}}))}),
    'GET /api/projects/p1/cast': () => ({casting: {version: 2, characters: []}}),
    'GET /api/projects/p1/spend': () => ({spentUsd: 0, heldUsd: 0, capUsd: 150}),
    'GET /api/projects/p1/audio-takes': () => ({enabled: true, nativeCapabilityRevision: 'n', characters: [{id: 'c-nora-000', profile: {voice: {id: VOICE.id}}, voiceAvailable: true}],
      voices: [VOICE], lines, jobs: [{id: 't0', status: 'done'}, {id: 't1', status: 'done'}]}),
    'POST /api/projects/p1/audio-takes': body => ({jobId: `t${body.sceneIndex}`, admitted: false}),
    'GET /api/projects/p1/graphics': () => ({rendering: {available: false}, library: {version: 0}, graphics: []}),
    'POST /api/projects/p1/feature-film': () => ({jobId: 'joined-1', admitted: true}),
  };
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET', body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({method, path, body});
    const handler = routes[`${method} ${path}`];
    if (handler) return handler(body);
    const dialogue = path.match(/^\/api\/projects\/p1\/dialogue\/(f\d)$/);
    if (dialogue && method === 'GET') {
      return {sourceRevision: 'sr', sourceFilesRevision: 'sf', engineVersion: 'e', conversionEngineVersion: 'c',
        lines: [{shotId: 's-1', index: 0, sourceHash: 'l', auditions: [{jobId: `t${Number(dialogue[1].slice(1)) - 1}`, revision: 'tr'}]}]};
    }
    if (dialogue && method === 'POST') return {jobId: `voices-${dialogue[1]}`, admitted: true};
    if (/^\/api\/projects\/p1\/lip-sync\/voices-f\d\/work-list$/.test(path)) {
      if (method === 'GET') return view();
      throw new Error('queued on a resume');
    }
    if (path.startsWith('/api/projects/p1/sound-mixes/')) throw new Error('the mixer is down');
    if (method === 'GET' && path.startsWith('/api/jobs/')) {
      const id = path.slice('/api/jobs/'.length), job = jobs.find(value => value.id === id);
      if (job) return job;
      if (id.startsWith('voices-')) return {id, stage: 'dialogue-replacement', status: 'done', outputRevision: 'v'.repeat(64), output: {}, studioLipSync: true};
      if (id === 'joined-1') return {id, stage: 'feature-film', status: 'done', outputRevision: 'j'.repeat(64), output: {}};
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  let project = {projectId: 'p1', token: 't'};
  const flow = createStudioFlow({api, getProject: () => project, setProject: value => { project = value; }, wait: async () => {}});
  return {flow, calls};
}

const NOT_ASKED = 'Lip-sync: 2 on-camera lines are ready to lip-sync ($10.00 to hold), but a resumed run doesn\'t ask for the lip-sync hold, so nothing was queued or held. '
  + 'Lip-sync them under Direct lip-sync. 1 on-camera line needs a face point chosen under Direct lip-sync first.';

test('a resumed feature with studio lip-sync on never stops on the lip-sync step: each sequence notes the hold it did not ask for, and nothing is queued', async () => {
  const {flow, calls} = resumed();
  const state = await flow.resumeFeature({tone: 'warm'});
  // Both sequences were finished and joined; no step waits on the creator's lip-sync decision.
  expect([state.step, state.joined, state.final.id]).toEqual(['final', true, 'joined-1']);
  expect(state.lipSync).toBeUndefined();
  expect([state.finals[1].id, state.finals[2].id]).toEqual(['voices-f1', 'voices-f2']);
  expect(state.resumedSequences.map(value => [value.number, value.final, value.film])).toEqual([[1, 'f1', 'voices-f1'], [2, 'f2', 'voices-f2']]);
  for (const number of [1, 2]) expect(state.finishes[number]).toEqual({voiced: true, scored: false, ambience: false, notes: [NOT_ASKED, SCORE]});
  expect(state.finishNotes.slice(0, 3)).toEqual([`Sequence 1 of 2: ${NOT_ASKED}`, `Sequence 1 of 2: ${SCORE}`, NOT_ASKED]);
  // The list is read once per voiced cut, and never asked for.
  expect(calls.filter(call => call.path.includes('/lip-sync/')).map(call => `${call.method} ${call.path}`)).toEqual([
    'GET /api/projects/p1/lip-sync/voices-f1/work-list', 'GET /api/projects/p1/lip-sync/voices-f2/work-list']);
  expect(calls.filter(call => call.method === 'POST' && call.path === '/api/projects/p1/feature-film').map(call => call.body.sequences))
    .toEqual([[{number: 1, jobId: 'voices-f1'}, {number: 2, jobId: 'voices-f2'}]]);
  await expect(flow.approveLipSync()).rejects.toThrow('Review the lip-sync hold first.');
  await expect(flow.declineLipSync()).rejects.toThrow('Review the lip-sync hold first.');
});

// HV-022-25 (review O3): a resumed run whose list has only lines for the face-point finder says so in a sentence of its
// own, never "0 on-camera lines are ready".
test('a resumed feature whose list only has lines to look at for a face says so, and looks at none', async () => {
  const items = [{...LIP_ITEMS[0], included: false, reason: 'no-face-point', faceDetection: {status: 'planned', frame: 14, heldUsd: 0.02}}];
  const view = () => ({...lipView(), workList: {...lipView().workList, items, passes: 0, needFacePoint: 1, heldUsd: 0, faceDetection: {planned: 1, heldUsd: 0.02, heldUsdPerDetection: 0.02}},
    newPasses: 0, newHeldUsd: 5.02, faceDetection: {newDetections: 1, heldUsdPerDetection: 0.02, heldUsd: 0.02, passHeldUsd: 5, spentWithoutFace: true, lines: []}});
  const {flow, calls} = resumed(view);
  const state = await flow.resumeFeature({tone: 'warm'});
  const note = 'Lip-sync: 1 on-camera line could have had the speaker\'s face looked for and been lip-synced ($5.02 at most to hold), but a resumed run doesn\'t ask for the lip-sync hold, '
    + 'so no face was looked for and nothing was queued or held. Choose its face point under Direct lip-sync.';
  for (const number of [1, 2]) expect(state.finishes[number].notes[0]).toBe(note);
  expect(calls.filter(call => call.method === 'POST' && call.path.includes('/lip-sync/'))).toEqual([]);
});
