/**
 * HV-022-21 — the review panel names what a take will hold.
 *
 * An ElevenLabs take now holds its own line's characters at the voice's rate rather than the
 * policy's whole 10,000-character ceiling, so the panel no longer shows that ceiling as the take's
 * reservation. It states the rate it is held at; every other vendor's take holds a fixed amount and
 * keeps saying so.
 */
import {expect,test} from "bun:test";
import {reservationText} from "../src/audio-studio.js";

test("an ElevenLabs take is reviewed at its line's characters and the voice's rate",()=>{
  expect(reservationText({provider:"elevenlabs",heldUsd:0.555556,maxCharacters:10000}))
    .toBe("Operator reservation: this line's own characters at $0.555556 per 10,000 characters.");
});

test("other vendors keep their fixed per-take reservation",()=>{
  expect(reservationText({provider:"azure",heldUsd:0.03,maxCharacters:1500})).toBe("Operator reservation: $0.030000.");
  expect(reservationText({provider:"cartesia",heldUsd:0.25,maxCharacters:20000})).toBe("Operator reservation: $0.250000.");
});
