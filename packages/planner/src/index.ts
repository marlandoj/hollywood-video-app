import type { ParseResult, Scene } from "../../parser/src/index";

export interface Shot {
  id: string;
  sceneIndex: number;
  prompt: string;
  dialogue: { character: string; lines: string[] }[];
  durationSec: number;
  seed: number;
}

function allocateShots(beatCounts: number[], maxShots: number): number[] {
  const scenes = beatCounts.length;
  const totalBeats = beatCounts.reduce((sum, count) => sum + count, 0);
  if (scenes === 0) return [];
  if (totalBeats <= maxShots) return [...beatCounts];
  if (scenes >= maxShots) return beatCounts.map(() => 1);
  const spare = maxShots - scenes;
  const extras = beatCounts.map((count) => Math.max(count - 1, 0));
  const extraTotal = extras.reduce((sum, count) => sum + count, 0);
  const allocation = extras.map((count) => Math.floor((count * spare) / extraTotal));
  let remaining = spare - allocation.reduce((sum, count) => sum + count, 0);
  const order = extras
    .map((count, index) => ({ index, remainder: (count * spare) % extraTotal }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (remaining === 0) break;
    if (allocation[index] < extras[index]) {
      allocation[index] += 1;
      remaining -= 1;
    }
  }
  return allocation.map((count) => count + 1);
}

function groupBeats(beats: string[], groups: number): string[][] {
  const result: string[][] = [];
  const size = Math.floor(beats.length / groups);
  const larger = beats.length % groups;
  let cursor = 0;
  for (let index = 0; index < groups; index += 1) {
    const length = size + (index < larger ? 1 : 0);
    result.push(beats.slice(cursor, cursor + length));
    cursor += length;
  }
  return result;
}

export function planShots(parsed: ParseResult, baseSeed = 1, maxShots?: number): Shot[] {
  const shots: Shot[] = [];
  const sceneBeats = parsed.scenes.map((scene) => (scene.action.length > 0 ? scene.action : [scene.heading]));
  const budget = maxShots === undefined || !Number.isFinite(maxShots) || maxShots < 1
    ? sceneBeats.map((beats) => beats.length)
    : allocateShots(sceneBeats.map((beats) => beats.length), Math.floor(maxShots));
  parsed.scenes.forEach((scene, si) => {
    groupBeats(sceneBeats[si], budget[si]).forEach((group, bi) => {
      shots.push({
        id: `shot-${scene.index + 1}-${bi + 1}`,
        sceneIndex: scene.index,
        prompt: `${scene.heading}. ${group.join(" ")}`,
        dialogue: bi === 0 ? scene.dialogue : [],
        durationSec: 2,
        seed: baseSeed + shots.length,
      });
    });
  });
  return shots;
}

export interface CreativeBible {
  projectId: string;
  generatedAt: string;
  characters: string[];
  locations: string[];
  toneNotes: string;
  rightsAttestation: { attested: boolean; attestedAt: string | null; statement: string };
}

export function generateBible(projectId: string, parsed: ParseResult): CreativeBible {
  const characters = [...new Set(parsed.scenes.flatMap((s: Scene) => s.dialogue.map((d) => d.character)))];
  const locations = [...new Set(parsed.scenes.map((s) => s.heading.replace(/^(INT|EXT|EST|I\/E)[.\s]+/i, "").replace(/\s*-\s*(DAY|NIGHT|DUSK|DAWN).*$/i, "").trim()))];
  return {
    projectId,
    generatedAt: new Date().toISOString(),
    characters,
    locations,
    toneNotes: `Auto-generated from ${parsed.scenes.length} scenes; edit freely.`,
    rightsAttestation: {
      attested: false,
      attestedAt: null,
      statement: "I attest that I hold the rights to this screenplay and that it depicts no real person without consent.",
    },
  };
}

export function attestRights(bible: CreativeBible, attestedAt: string): CreativeBible {
  if (!attestedAt || Number.isNaN(Date.parse(attestedAt))) {
    throw new Error("rights attestation requires the timestamp captured from the user");
  }
  return { ...bible, rightsAttestation: { ...bible.rightsAttestation, attested: true, attestedAt } };
}

export interface ProvenanceManifest {
  spec: "hv-provenance/1.0";
  projectId: string;
  scriptSha256: string;
  shots: { id: string; provider: string; model: string; seed: number; fingerprint: string }[];
  assembledAt: string;
  credentials: { type: "c2pa-style"; issuer: "hollywood-video-app"; claim: string };
}
