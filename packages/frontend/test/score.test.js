import {expect, test} from 'bun:test';
import {composeScore, scoreDirection, scoreRecord, SCORE_RECIPE} from '../src/score.js';

// HV-024-02: the Composer's own score. No sample, recording or model output.
test('the score is the same bytes every time, a 48 kHz 16-bit stereo WAV of eight bars', () => {
  const a = composeScore({mode: 'major', bpm: 80}), b = composeScore({mode: 'major', bpm: 80}), view = new DataView(a.buffer);
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  expect(new TextDecoder().decode(a.slice(0, 4))).toBe('RIFF');
  expect([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)]).toEqual([1, 2, 48000, 16]);
  const frames = view.getUint32(40, true) / 4;
  expect(frames).toBe(8 * 4 * 48000 * 60 / 80);
  expect(Buffer.from(composeScore({mode: 'minor', bpm: 80})).equals(Buffer.from(a))).toBe(false);
});

test('the loop is seamless and peaks at -12 dBFS', () => {
  const bytes = composeScore({mode: 'minor', bpm: 72}), view = new DataView(bytes.buffer), frames = (bytes.byteLength - 44) / 4;
  const sample = (frame, channel) => view.getInt16(44 + frame * 4 + channel * 2, true);
  expect([sample(0, 0), sample(0, 1), sample(frames - 1, 0), sample(frames - 1, 1)]).toEqual([0, 0, 0, 0]);
  let peak = 0; for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(sample(i, 0)), Math.abs(sample(i, 1)));
  expect(peak).toBe(Math.round(SCORE_RECIPE.peak * 32767));
});

test('the Composer decides from the tone and the answers; "no music" is respected', () => {
  expect(scoreDirection({tone: 'dark and tense'})).toMatchObject({enabled: true, mode: 'minor', bpm: 96});
  expect(scoreDirection({tone: 'warm, windswept, hopeful'})).toMatchObject({enabled: true, mode: 'major', bpm: 72});
  expect(scoreDirection({tone: ''})).toMatchObject({enabled: true, mode: 'major', bpm: 80});
  expect(scoreDirection({tone: 'warm', answers: [{persona: 'sound', accepted: false, reply: 'No music, just the wind.'}]}).enabled).toBe(false);
  expect(scoreDirection({tone: 'warm', answers: [{persona: 'director', accepted: false, reply: 'no music'}]}).enabled).toBe(true);
  expect(() => composeScore({mode: 'lydian', bpm: 80})).toThrow();
});

test('its rights record says the recording is the application\'s own', () => {
  const record = scoreRecord({mode: 'major', bpm: 72}, 3);
  expect(record).toMatchObject({label: 'Composer score hv-crew-score/1 major 72', expectedVersion: 3, rights: {basis: 'original', attested: true, credit: 'Original score: Composer (AI crew)'}});
  expect(record.rights.terms).toContain('no third-party recording, sample or model output');
});
