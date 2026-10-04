import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

/**
 * HV-037-03. The benchmark corpus's locked character references, KEEPER and SAILOR.
 *
 * Both are invented characters, drawn here from a handful of flat shapes -- a cartoon portrait,
 * head and shoulders -- so nothing about them is a photograph, a likeness or a real person. They
 * cost $0: no provider, model or network is involved, only this file's arithmetic and zlib.
 *
 * The drawing is deterministic. Every pixel is the average of a 4x4 grid of samples, each sample is
 * decided by additions, multiplications and comparisons only (no trigonometry, whose last bit can
 * differ between platforms), and colours are integers. `referencePixels` is therefore the same
 * bytes everywhere, and a test decodes the committed PNGs and compares them with it pixel for pixel.
 * (The PNG bytes themselves depend on the deflate implementation, so the manifest pins the committed
 * files' sha256 rather than asking every zlib to reproduce them.)
 *
 *   bun packages/benchmarks/src/references.ts            # rewrites fixtures/references/
 *
 * A paid pass sends these as `--references packages/benchmarks/fixtures/references`; the measured
 * record carries their sha256 and fingerprints, and the routing reader refuses records measured
 * against different references, so every model is scored against these same two pictures.
 */
export const REFERENCE_SIZE = 512;
export const CORPUS_REFERENCES_DIR = fileURLToPath(new URL("../fixtures/references/", import.meta.url));
export const REFERENCES_MANIFEST_SCHEMA = "hv-benchmark-references/1";

export type CorpusCharacter = "KEEPER" | "SAILOR";
export const CORPUS_CHARACTERS: readonly CorpusCharacter[] = Object.freeze(["KEEPER", "SAILOR"] as const);

/** What each reference shows, in words. An invented character; the corpus's screenplay names them. */
export const REFERENCE_DESCRIPTIONS: Readonly<Record<CorpusCharacter, string>> = Object.freeze({
  KEEPER: "Invented cartoon lighthouse keeper, head and shoulders: an older man with a grey beard and bushy grey eyebrows, a navy peaked cap with a gold badge, "
    + "a yellow oilskin coat; night sky behind him, a red and white lighthouse and its pale beam.",
  SAILOR: "Invented cartoon sailor, head and shoulders: a young clean-shaven man with short dark hair and a small smile, a red knit cap, "
    + "a navy and white striped shirt under an open navy peacoat; daytime sky and sea behind him.",
});

type Rgb = readonly [number, number, number];
/** A region: its exact test, and an inclusive bounding box that contains every point the test admits. */
interface Shape { test: (x: number, y: number) => boolean; box: readonly [number, number, number, number] }

const SAMPLES = 4;
const FULL = [-Infinity, -Infinity, Infinity, Infinity] as const;

const ellipse = (cx: number, cy: number, rx: number, ry: number): Shape => ({ box: [cx - rx, cy - ry, cx + rx, cy + ry], test: (x, y) => {
  const dx = (x - cx) / rx, dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
} });
const rect = (x0: number, y0: number, x1: number, y1: number): Shape => ({ box: [x0, y0, x1, y1], test: (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1 });
/** A convex polygon, its vertices clockwise as seen on screen (y down). */
const polygon = (points: readonly (readonly [number, number])[]): Shape => ({
  box: [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))],
  test: (x, y) => {
    for (let index = 0; index < points.length; index++) {
      const [ax, ay] = points[index]!, [bx, by] = points[(index + 1) % points.length]!;
      if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false;
    }
    return true;
  },
});
const and = (a: Shape, b: Shape): Shape => ({ box: [Math.max(a.box[0], b.box[0]), Math.max(a.box[1], b.box[1]), Math.min(a.box[2], b.box[2]), Math.min(a.box[3], b.box[3])],
  test: (x, y) => a.test(x, y) && b.test(x, y) });
const not = (a: Shape): Shape => ({ box: FULL, test: (x, y) => !a.test(x, y) });

interface Layer { shape: Shape; color: (x: number, y: number) => Rgb; alpha?: number }
const solid = (color: Rgb) => () => color;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const S = REFERENCE_SIZE;
const everywhere: Shape = { box: FULL, test: () => true };

function keeper(): Layer[] {
  const skin: Rgb = [224, 172, 130], beard: Rgb = [186, 186, 190], cap: Rgb = [29, 45, 80], coat: Rgb = [233, 179, 34];
  return [
    { shape: everywhere, color: (_x, y) => mix([13, 27, 42], [40, 54, 86], y / S) },
    { shape: polygon([[0, 40], [420, 120], [420, 160], [0, 230]]), color: solid([250, 240, 190]), alpha: 0.28 },
    { shape: rect(408, 90, 470, S), color: (_x, y) => (Math.floor((y - 90) / 46) % 2 === 0 ? [236, 236, 230] : [196, 48, 44]) },
    { shape: rect(398, 70, 480, 92), color: solid([60, 60, 70]) },
    { shape: rect(414, 40, 464, 72), color: solid([255, 226, 120]) },
    { shape: ellipse(256, 600, 230, 200), color: solid(coat) },
    { shape: polygon([[200, 400], [256, 470], [312, 400], [256, 430]]), color: solid([196, 146, 20]) },
    { shape: rect(226, 330, 286, 420), color: solid([206, 154, 114]) },
    { shape: ellipse(166, 262, 18, 30), color: solid(skin) },
    { shape: ellipse(346, 262, 18, 30), color: solid(skin) },
    { shape: ellipse(256, 256, 90, 108), color: solid(skin) },
    { shape: and(ellipse(256, 316, 92, 86), rect(0, 280, S, S)), color: solid(beard) },
    { shape: ellipse(256, 300, 40, 12), color: solid([164, 164, 170]) },
    { shape: ellipse(256, 322, 20, 7), color: solid([150, 70, 70]) },
    { shape: ellipse(256, 272, 16, 22), color: solid([206, 146, 110]) },
    { shape: ellipse(222, 246, 11, 8), color: solid([245, 245, 245]) },
    { shape: ellipse(290, 246, 11, 8), color: solid([245, 245, 245]) },
    { shape: ellipse(223, 247, 5, 6), color: solid([40, 30, 26]) },
    { shape: ellipse(291, 247, 5, 6), color: solid([40, 30, 26]) },
    { shape: polygon([[196, 226], [246, 220], [248, 232], [198, 238]]), color: solid(beard) },
    { shape: polygon([[266, 220], [316, 226], [314, 238], [264, 232]]), color: solid(beard) },
    { shape: ellipse(256, 168, 104, 44), color: solid(cap) },
    { shape: rect(162, 166, 350, 196), color: solid([22, 34, 62]) },
    { shape: and(ellipse(256, 198, 110, 22), rect(0, 196, S, S)), color: solid([12, 12, 16]) },
    { shape: ellipse(256, 160, 14, 12), color: solid([226, 186, 64]) },
  ];
}

function sailor(): Layer[] {
  const skin: Rgb = [198, 138, 94], hair: Rgb = [46, 32, 24], navy: Rgb = [24, 36, 72], red: Rgb = [196, 40, 44];
  return [
    { shape: everywhere, color: (_x, y) => mix([132, 196, 220], [196, 228, 238], y / 300) },
    { shape: rect(0, 300, S, S), color: (_x, y) => (Math.floor((y - 300) / 14) % 3 === 0 ? [36, 112, 150] : [28, 92, 132]) },
    { shape: ellipse(256, 590, 236, 206), color: (_x, y) => (Math.floor(y / 26) % 2 === 0 ? navy : [240, 240, 236]) },
    { shape: polygon([[20, 512], [60, 420], [196, 392], [210, 512]]), color: solid([18, 26, 52]) },
    { shape: polygon([[302, 512], [316, 392], [452, 420], [492, 512]]), color: solid([18, 26, 52]) },
    { shape: rect(224, 330, 288, 410), color: solid([182, 124, 84]) },
    { shape: ellipse(170, 268, 16, 28), color: solid(skin) },
    { shape: ellipse(342, 268, 16, 28), color: solid(skin) },
    { shape: ellipse(256, 262, 86, 102), color: solid(skin) },
    { shape: and(ellipse(256, 200, 90, 60), rect(0, 0, S, 214)), color: solid(hair) },
    { shape: ellipse(256, 276, 14, 20), color: solid([180, 120, 80]) },
    { shape: ellipse(222, 244, 11, 8), color: solid([245, 245, 245]) },
    { shape: ellipse(290, 244, 11, 8), color: solid([245, 245, 245]) },
    { shape: ellipse(223, 245, 5, 6), color: solid([34, 24, 18]) },
    { shape: ellipse(291, 245, 5, 6), color: solid([34, 24, 18]) },
    { shape: rect(202, 224, 244, 230), color: solid(hair) },
    { shape: rect(268, 224, 310, 230), color: solid(hair) },
    { shape: and(and(ellipse(256, 300, 34, 26), not(ellipse(256, 294, 32, 22))), rect(0, 304, S, S)), color: solid([120, 50, 44]) },
    { shape: and(ellipse(256, 176, 98, 70), rect(0, 0, S, 182)), color: (x) => (Math.floor(x / 12) % 2 === 0 ? red : [176, 32, 38]) },
    { shape: rect(160, 168, 352, 198), color: solid([150, 26, 32]) },
    { shape: ellipse(256, 102, 22, 18), color: solid([226, 226, 220]) },
  ];
}

const DRAWINGS: Readonly<Record<CorpusCharacter, () => Layer[]>> = { KEEPER: keeper, SAILOR: sailor };

/** The reference as 8-bit RGB, row by row, REFERENCE_SIZE square. */
export function referencePixels(character: CorpusCharacter): Buffer {
  const layers = DRAWINGS[character]();
  const out = Buffer.alloc(S * S * 3);
  for (let py = 0; py < S; py++) {
    // Only the layers whose box meets this row; the box is a fast rejection, never a different answer.
    const row = layers.filter(layer => layer.shape.box[1] <= py + 1 && layer.shape.box[3] >= py);
    for (let px = 0; px < S; px++) {
      const here = row.filter(layer => layer.shape.box[0] <= px + 1 && layer.shape.box[2] >= px);
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px + (sx + 0.5) / SAMPLES, y = py + (sy + 0.5) / SAMPLES;
          let colour: Rgb = [0, 0, 0];
          for (const layer of here) {
            if (!layer.shape.test(x, y)) continue;
            const top = layer.color(x, y);
            colour = layer.alpha === undefined ? top : mix(colour, top, layer.alpha);
          }
          r += colour[0]; g += colour[1]; b += colour[2];
        }
      }
      const at = (py * S + px) * 3, n = SAMPLES * SAMPLES;
      out[at] = Math.round(r / n); out[at + 1] = Math.round(g / n); out[at + 2] = Math.round(b / n);
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8), tail = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, "ascii");
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, data, tail]);
}

/** An 8-bit RGB PNG, every row unfiltered. No text, time or colour-profile chunk. */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  if (rgb.length !== width * height * 3) throw new Error("RGB buffer does not match the image size.");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

export interface ReferencesManifest {
  schema: typeof REFERENCES_MANIFEST_SCHEMA;
  generator: string;
  costUsd: 0;
  size: string;
  references: { character: CorpusCharacter; file: string; sha256: string; pixelsSha256: string; description: string }[];
}

/** Write `<dir>/<character>.png` for each corpus character and `<dir>/references.json`. */
export function writeCorpusReferences(dir: string = CORPUS_REFERENCES_DIR): ReferencesManifest {
  mkdirSync(dir, { recursive: true });
  const references = CORPUS_CHARACTERS.map(character => {
    const pixels = referencePixels(character), png = encodePng(S, S, pixels), file = character.toLowerCase() + ".png";
    writeFileSync(join(dir, file), png);
    return { character, file, sha256: createHash("sha256").update(png).digest("hex"), pixelsSha256: createHash("sha256").update(pixels).digest("hex"),
      description: REFERENCE_DESCRIPTIONS[character] };
  });
  const manifest: ReferencesManifest = { schema: REFERENCES_MANIFEST_SCHEMA, generator: "packages/benchmarks/src/references.ts", costUsd: 0, size: `${S}x${S}`, references };
  writeFileSync(join(dir, "references.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (import.meta.main) {
  const flag = process.argv.indexOf("--out");
  const dir = flag >= 0 ? resolve(process.argv[flag + 1] ?? "") : CORPUS_REFERENCES_DIR;
  console.log(JSON.stringify(writeCorpusReferences(dir), null, 2));
}
