import type { ParseResult, Scene } from "../../parser/src/index";

export interface Shot {
  id: string;
  sceneIndex: number;
  prompt: string;
  dialogue: { character: string; lines: string[] }[];
  durationSec: number;
  seed: number;
}

export function planShots(parsed: ParseResult, baseSeed = 1): Shot[] {
  const shots: Shot[] = [];
  for (const scene of parsed.scenes) {
    const beats = scene.action.length > 0 ? scene.action : [scene.heading];
    beats.forEach((beat, bi) => {
      shots.push({
        id: `shot-${scene.index + 1}-${bi + 1}`,
        sceneIndex: scene.index,
        prompt: `${scene.heading}. ${beat}`,
        dialogue: bi === 0 ? scene.dialogue : [],
        durationSec: 2,
        seed: baseSeed + shots.length,
      });
    });
  }
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
