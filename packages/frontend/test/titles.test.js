/**
 * HV-025-03 -- the Editor titles the film. The title, the credits, the two graphic plans and the
 * timeline operation are pure, and the plans are checked with the renderer's own validator.
 */
import {expect, test} from 'bun:test';
import {motionGraphic} from '../../planner/src/motion-graphics';
import {applyEditOperation, initialEditTimeline} from '../../planner/src/edit-timeline';
import {CREDITS_FRAMES, PERSONA_TITLES, TITLE_FRAMES, creditRows, filmTitle, frameSize, samePlan, shorten, titleOperation, titlePage, titlePlans} from '../src/titles.js';
import {PERSONA_TITLES as STUDIO_TITLES} from '../src/studio.js';

const PAGE = 'Title:\n    _**The Long Way Home**_\nCredit: Written by\nAuthor: Ana Ruiz\nDraft date: 1/1/2026\n\nINT. KITCHEN - DAY\n\nMAYA pours tea.';

test('the title comes from the title page, else the logline, else "Untitled"', () => {
  expect(titlePage(PAGE)).toMatchObject({title: 'The Long Way Home', credit: 'Written by', author: 'Ana Ruiz'});
  expect(filmTitle(PAGE, 'A reunion.')).toBe('The Long Way Home');
  expect(filmTitle('Title: ' + 'Word '.repeat(40), '')).toBe('Word '.repeat(15).trim() + '…');
  expect(filmTitle('INT. ROOM - DAY\n\nTitle: not a title page', 'Two sisters meet again after forty years, in the kitchen where they last argued about the farm.'))
    .toBe('Two sisters meet again after forty years, in the kitchen where they last…');
  expect(filmTitle('INT. ROOM - DAY', '   ')).toBe('Untitled');
  expect(filmTitle('', undefined)).toBe('Untitled');
  // Hidden characters never reach the renderer, and a long word is cut rather than dropped.
  expect(filmTitle('Title: A\u200Bb\u0007c')).toBe('A b c');
  expect(shorten('x'.repeat(100), 10)).toBe('x'.repeat(9) + '…');
});

test('the credits name the writer, the whole AI crew, and only the voices and score that were used', () => {
  const rows = creditRows({script: PAGE, voiced: true, scored: true});
  expect(rows[0]).toEqual({role: 'Written by', name: 'Ana Ruiz'});
  expect(rows.slice(1, 7).map(row => row.name)).toEqual(Object.entries(PERSONA_TITLES).filter(([persona]) => persona !== 'continuity').map(([, title]) => `${title} (AI crew)`));
  expect(rows.slice(7)).toEqual([{role: 'Voices', name: 'synthetic (Azure neural voices)'}, {role: 'Original score', name: 'Composer (AI crew)'}]);
  const plain = creditRows({script: 'INT. ROOM - DAY'});
  expect(plain[0]).toEqual({role: 'Written by', name: 'The creator'});
  expect(plain).toHaveLength(7);
  expect(plain.some(row => /Azure|score/.test(row.name + row.role))).toBe(false);
  expect(creditRows({script: 'Title: X\nCredit: Jo Park'})[0].name).toBe('Jo Park');
  // The studio still exports the same persona titles it always did.
  expect(STUDIO_TITLES).toBe(PERSONA_TITLES);
});

test('the title and credits plans are valid graphics that fit, landscape and vertical', () => {
  const long = 'W'.repeat(80), credits = creditRows({script: 'Author: ' + 'M'.repeat(200), voiced: true, scored: true});
  for (const facts of [{width: 1280, height: 720}, {width: 1080, height: 1920}, {width: 320, height: 180}, {width: 3840, height: 2160}]) {
    const size = frameSize(facts), plans = titlePlans({...size, title: long, credits});
    expect(size.width % 2 + size.height % 2).toBe(0);
    expect(size.width <= 1920 && size.height <= 1080).toBe(true);
    const title = motionGraphic(plans.title), roll = motionGraphic(plans.credits);
    expect([title.kind, title.frames, title.background]).toEqual(['title', TITLE_FRAMES, null]);
    expect([roll.kind, roll.frames, roll.credits.length]).toEqual(['credits', CREDITS_FRAMES, 9]);
    // Conservative type: about 7% of the short side for the title, 5% for the credits.
    expect(title.fontSize).toBeLessThanOrEqual(Math.ceil(Math.min(size.width, size.height) * 0.07));
    expect(roll.fontSize).toBeLessThanOrEqual(Math.ceil(Math.min(size.width, size.height) * 0.05));
    expect(roll.credits.every(row => row.name.length <= 60)).toBe(true);
  }
  // A film shorter than the title holds it for the film's length.
  const short = motionGraphic(titlePlans({width: 320, height: 180, title: 'Hi', credits, filmFrames: 4}).title);
  expect([short.frames, short.enterFrames, short.exitFrames]).toEqual([4, 1, 2]);
  const plan = titlePlans({width: 320, height: 180, title: 'Hi', credits}).title;
  expect(samePlan({...plan, revision: 'r'}, plan)).toBe(true);
  expect(samePlan({...plan, text: 'Other', revision: 'r'}, plan)).toBe(false);
});

const hash = c => c.repeat(64);
const source = (id, frames, extra = {}) => ({id, revision: hash({film: 'a', title: 'b', roll: 'c'}[id]), label: id, frames, width: 320, height: 180, audio: [], captions: [], voices: [], unmeasuredAudio: false, ...extra});

test('the title lies over the start, and the credits extend the film with its music under them', () => {
  const film = source('film', 400, {audio: ['mix', 'dialogue', 'narration', 'music', 'ambience', 'effects']}), title = source('title', 120, {media: 'graphic-rgba'}), roll = source('roll', 180, {media: 'graphic-rgba'});
  const start = initialEditTimeline([film, title, roll], 'film', 320, 180);
  const operation = titleOperation({film, title, credits: roll});
  const edited = applyEditOperation(start, operation);
  expect(edited.frames).toBe(580);
  const byId = Object.fromEntries(edited.clips.map(clip => [clip.id, clip]));
  expect(byId['crew-title']).toMatchObject({sourceId: 'title', lane: 'picture', layer: 1, at: 0, frames: 120});
  expect(byId['crew-credits']).toMatchObject({sourceId: 'roll', lane: 'picture', layer: 0, at: 400, frames: 180});
  expect(byId['crew-credits-music']).toMatchObject({sourceId: 'film', lane: 'music', at: 400, from: 60, frames: 180, envelope: {from: 60, frames: 180, fadeIn: 15, fadeOut: 45}});
  // The film itself is untouched.
  expect(edited.clips.filter(clip => clip.sourceId === 'film' && clip.lane !== 'music').every(clip => clip.at === 0 && clip.frames === 400)).toBe(true);
});

test('a cut without a music stem gets silent credits, and a short film a short title', () => {
  const film = source('film', 30, {audio: ['mix']}), title = source('title', 30, {media: 'graphic-rgba'}), roll = source('roll', 180, {media: 'graphic-rgba'});
  const edited = applyEditOperation(initialEditTimeline([film, title, roll], 'film', 320, 180), titleOperation({film, title, credits: roll}));
  expect(edited.frames).toBe(210);
  expect(edited.clips.map(clip => clip.id).sort()).toEqual(['crew-credits', 'crew-title', 'initial-0', 'initial-1', 'initial-2']);
  // A scored film shorter than the credits lends what music it has, from its start.
  const scored = source('film', 30, {audio: ['mix', 'music']});
  const music = titleOperation({film: scored, title, credits: roll}).clips.find(clip => clip.lane === 'music');
  expect(music).toMatchObject({from: 0, frames: 30, envelope: {fadeIn: 7, fadeOut: 15}});
  expect(applyEditOperation(initialEditTimeline([scored, title, roll], 'film', 320, 180), titleOperation({film: scored, title, credits: roll})).frames).toBe(210);
});

// HV-024-11: a generated cue is credited as what it is, never as the Composer's own score.
test('a generated score is credited by its own line, shortened like any other name', () => {
  expect(creditRows({script: 'x', scored: 'Composer (AI crew), generated with ElevenLabs Music'}).at(-1)).toEqual({role: 'Music', name: 'Composer (AI crew), generated with ElevenLabs Music'});
  expect(creditRows({script: 'x', scored: true}).at(-1)).toEqual({role: 'Original score', name: 'Composer (AI crew)'});
  expect(creditRows({script: 'x', scored: 'M'.repeat(90)}).at(-1).name.length).toBeLessThanOrEqual(60);
});
