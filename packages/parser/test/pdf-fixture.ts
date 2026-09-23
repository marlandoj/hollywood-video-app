/**
 * A screenplay PDF, written by hand, so the tests own every byte they read.
 *
 * HV-016-08: a fixture that came out of a real word processor would prove that this importer reads
 * *that* word processor. This builds the file the way a screenplay PDF is built -- Courier at
 * twelve points, one `Td` per line, the left margin carrying the element -- from a list of
 * `[inchesFromTheLeftEdge, text]`, so a test can state the layout it is asserting about.
 */
import {deflateSync} from "node:zlib";

export interface PdfPageSpec {lines: [number, string][]}

export interface PdfSpec {
  pages: PdfPageSpec[];
  /** Compress the content streams with FlateDecode, as every real producer does. */
  deflate?: boolean;
  /** Extra entries for the font dictionary, to exercise the encodings this importer refuses. */
  font?: string;
  /** A filter name other than FlateDecode. */
  filter?: string;
  /** An /Encrypt entry in the trailer. */
  encrypted?: boolean;
}

const POINTS_PER_INCH = 72, TOP = 720, LEADING = 12;

function content(page: PdfPageSpec): string {
  const drawn = page.lines.map(([inches, text], index) =>
    `BT /F1 12 Tf ${(inches * POINTS_PER_INCH).toFixed(2)} ${(TOP - index * LEADING).toFixed(2)} Td (${text.replace(/([()\\])/g, "\\$1")}) Tj ET`);
  return drawn.join("\n") + "\n";
}

/** The bytes of a PDF drawing exactly these lines at exactly these margins. */
export function pdfFixture(spec: PdfSpec): Uint8Array {
  const parts: (string | Uint8Array)[] = ["%PDF-1.4\n"];
  const pageIds = spec.pages.map((_, index) => 4 + index * 2);
  const object = (id: number, body: string, stream?: Uint8Array) => {
    parts.push(`${id} 0 obj\n${body}\n`);
    if (stream) {parts.push("stream\n", stream, "\nendstream\n");}
    parts.push("endobj\n");
  };
  object(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  object(2, `<< /Type /Pages /Count ${spec.pages.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] >>`);
  object(3, `<< /Type /Font /Subtype /Type1 /BaseFont /Courier${spec.font ?? ""} >>`);
  spec.pages.forEach((page, index) => {
    const id = pageIds[index]!;
    const text = new TextEncoder().encode(content(page));
    const body = spec.deflate ? new Uint8Array(deflateSync(text)) : text;
    const filter = spec.filter ? ` /Filter /${spec.filter}` : spec.deflate ? " /Filter /FlateDecode" : "";
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`);
    object(id + 1, `<< /Length ${body.length}${filter} >>`, body);
  });
  parts.push(`trailer\n<< /Size ${pageIds.at(-1)! + 2} /Root 1 0 R${spec.encrypted ? " /Encrypt 99 0 R" : ""} >>\n%%EOF\n`);
  const encoder = new TextEncoder();
  const chunks = parts.map(part => typeof part === "string" ? encoder.encode(part) : part);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {bytes.set(chunk, at); at += chunk.length;}
  return bytes;
}

/** The margins a US screenplay uses, in inches from the left edge of the page. */
export const MARGIN = Object.freeze({action: 1.5, dialogue: 2.5, parenthetical: 3.0, character: 3.5, transition: 6.0});

/** One scene, laid out the way a screenplay PDF lays one out. */
export const SCENE: [number, string][] = [
  [MARGIN.action, "INT. LIGHTHOUSE - NIGHT"],
  [MARGIN.action, "Marguerite winds the lamp. Rain hammers the glass."],
  [MARGIN.character, "MARGUERITE"],
  [MARGIN.parenthetical, "(quietly)"],
  [MARGIN.dialogue, "The light has to hold."],
  [MARGIN.character, "TOMAS"],
  [MARGIN.dialogue, "Then we hold it together."],
  [MARGIN.transition, "CUT TO:"],
  [MARGIN.action, "EXT. THE CLIFF PATH - LATER"],
  [MARGIN.action, "Tomas walks the path with a lantern."],
];
