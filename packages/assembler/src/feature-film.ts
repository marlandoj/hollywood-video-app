/**
 * HV-030-30: a feature's sequence films joined into one film, with the Editor's opening title over the
 * start and end credits after the last frame (Release 3 step 7).
 *
 * This is the assembler's own join, applied to whole films instead of shots: the pictures dissolve
 * with `xfade` and the sound with `acrossfade` at each join, as `assemble` joins a film's shots, so the
 * sound runs on unbroken from one sequence into the next; the export is encoded with the assembler's
 * settings, passes the same ffprobe gate (`validateExport`) before anything is recorded, is signed
 * beside its record with the host's C2PA key when it holds one (`exportCredentials`), and is cut into
 * the same HLS segments. Each film's captions are carried over at its place in the feature.
 *
 * Everything streams through one ffmpeg run, so a 20-minute feature needs the space of its export and
 * nothing like a picture edit's lossless masters.
 */
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {runAsync,validateExport,type ExportProbe} from "./index";
import {sha256Stream,type C2paSigning} from "./c2pa";
import {exportC2paSigner,exportCredentials} from "./export-credentials";
import {PROVENANCE_ISSUER,provenanceAssembledAt,type ProvenanceCredentials} from "../../planner/src/provenance";
import {FEATURE_FILM_RESULT_SPEC as FEATURE_FILM_SPEC} from "../../planner/src/feature-film";
const FPS = 30, RATE = 48000;

export interface FeatureFilmMedia {path:string;captionsPath:string|null}
export interface FeatureFilmGraphicMedia {path:string;frames:number}
export interface FeatureFilmAssembleOptions {
  films:FeatureFilmMedia[];title:FeatureFilmGraphicMedia|null;credits:FeatureFilmGraphicMedia|null;
  width:number;height:number;crossfadeFrames:number;outDir:string;projectId:string;assembledAt:string;
  /** What the record says this film is (the join: each sequence's final and film), written into provenance.json as given. */
  record:Record<string,unknown>;
  signal?:AbortSignal;
  /** The host's key and certificate; left out, read from the environment; null means unsigned. */
  c2pa?:C2paSigning|null;
}
export interface FeatureFilmExport {
  mp4Path:string;hlsPlaylistPath:string;vttPath:string;srtPath:string;manifestPath:string;c2paPath?:string;
  sha256:string;durationSec:number;crossfadeSec:number;credentials:ProvenanceCredentials;ffprobe:ExportProbe;films:{durationSec:number;sha256:string;audio:boolean}[];
}

interface Cue {start:number;end:number;text:string}
const stamp = (seconds:number, comma = false) => {
  const millis = Math.max(0, Math.round(seconds * 1000)), pad = (value:number, width = 2) => String(value).padStart(width, "0");
  const text = `${pad(Math.floor(millis / 3600000))}:${pad(Math.floor(millis % 3600000 / 60000))}:${pad(Math.floor(millis % 60000 / 1000))}.${pad(millis % 1000, 3)}`;
  return comma ? text.replace(".", ",") : text;
};
const seconds = (value:string) => {
  const parts = value.trim().split(":").map(Number);
  return parts.some(part => !Number.isFinite(part)) ? NaN : parts.reduce((total, part) => total * 60 + part, 0);
};
/** The cues of a WebVTT file, without the assembler's "[no dialogue]" stand-in. */
export function vttCues(text:string):Cue[] {
  const cues:Cue[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n"), at = lines.findIndex(line => line.includes("-->"));
    if (at < 0) continue;
    const [from, to] = lines[at]!.split("-->").map(part => part.trim().split(/\s+/)[0]!), start = seconds(from!), end = seconds(to!), words = lines.slice(at + 1).join("\n").trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && words && words !== "[no dialogue]") cues.push({start, end, text: words});
  }
  return cues;
}

/**
 * The feature's captions: each film's cues moved to where the film starts in the feature, and cut to
 * the part of the film the feature keeps. With no cues at all, the assembler's stand-in.
 */
export function featureCaptions(films:{cues:Cue[];start:number;durationSec:number}[]):Cue[] {
  const ms = (value:number) => Math.round(value * 1000) / 1000;
  return films.flatMap(film => film.cues.flatMap(cue => {
    const start = ms(Math.max(film.start, film.start + cue.start)), end = ms(Math.min(film.start + film.durationSec, film.start + cue.end));
    return end > start ? [{start, end, text: cue.text}] : [];
  })).sort((a, b) => a.start - b.start || a.end - b.end);
}

async function probe(path:string, signal?:AbortSignal) {
  const info = JSON.parse(await runAsync(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path], signal)) as {streams?:{codec_type:string}[];format?:{duration?:string}};
  const durationSec = Number(info.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("A sequence film has no measurable duration.");
  if (!info.streams?.some(stream => stream.codec_type === "video")) throw new Error("A sequence film has no picture.");
  return {durationSec, audio: Boolean(info.streams?.some(stream => stream.codec_type === "audio"))};
}

/** The ffmpeg filter graph: each film to the feature's size and clock, the joins, the title over the start, the credits after. */
export function featureFilmFilter(films:{durationSec:number;audio:boolean}[], crossfadeSec:number, size:{width:number;height:number}, title:number|null, credits:{input:number;seconds:number}|null):string {
  const {width, height} = size, parts:string[] = [];
  films.forEach((film, index) => {
    parts.push(`[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${index}]`);
    parts.push(film.audio ? `[${index}:a]aresample=${RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${film.durationSec},asetpts=PTS-STARTPTS[a${index}]`
      : `anullsrc=channel_layout=stereo:sample_rate=${RATE},atrim=duration=${film.durationSec}[a${index}]`);
  });
  if (films.length === 1) parts.push("[v0]null[vj]", "[a0]anull[aj]");
  else if (crossfadeSec > 0) {
    let offset = 0, video = "[v0]", sound = "[a0]";
    for (let index = 1; index < films.length; index++) {
      offset += films[index - 1]!.durationSec - crossfadeSec;
      const last = index === films.length - 1;
      parts.push(`${video}[v${index}]xfade=transition=fade:duration=${crossfadeSec}:offset=${offset.toFixed(3)}${last ? "[vj]" : `[x${index}]`}`);
      parts.push(`${sound}[a${index}]acrossfade=d=${crossfadeSec}${last ? "[aj]" : `[y${index}]`}`);
      video = `[x${index}]`; sound = `[y${index}]`;
    }
  } else parts.push(films.map((_, index) => `[v${index}][a${index}]`).join("") + `concat=n=${films.length}:v=1:a=1[vj][aj]`);
  let video = "[vj]";
  if (title !== null) {
    parts.push(`[${title}:v]scale=${width}:${height},format=rgba,setpts=PTS-STARTPTS[title]`, `${video}[title]overlay=0:0:eof_action=pass:format=auto,format=yuv420p[vt]`);
    video = "[vt]";
  }
  if (credits) {
    parts.push(`[${credits.input}:v]scale=${width}:${height},setsar=1,fps=${FPS},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[vc]`,
      `anullsrc=channel_layout=stereo:sample_rate=${RATE},atrim=duration=${credits.seconds}[ac]`, `${video}[aj][vc][ac]concat=n=2:v=1:a=1[vout][aout]`);
  } else parts.push(`${video}null[vout]`, "[aj]anull[aout]");
  return parts.join(";");
}

export async function assembleFeatureFilm(options:FeatureFilmAssembleOptions):Promise<FeatureFilmExport> {
  const {films, title, credits, width, height, outDir, projectId, signal} = options;
  if (!films.length) throw new Error("A feature's film joins at least one sequence film.");
  const assembledAt = provenanceAssembledAt(options.assembledAt);
  // The key is checked before anything is encoded (HV-031-15).
  const signer = options.c2pa === undefined ? exportC2paSigner() : exportC2paSigner(options.c2pa);
  const measured:{durationSec:number;audio:boolean;sha256:string}[] = [];
  for (const film of films) measured.push({...await probe(film.path, signal), sha256: await sha256Stream(film.path, signal)});
  // The dissolve borrows half its length from each side of a join; a film too short to give it joins with a cut.
  const wanted = options.crossfadeFrames / FPS, crossfadeSec = films.length > 1 && measured.every(film => film.durationSec >= 4 * wanted) ? wanted : 0;
  const creditsSec = credits ? credits.frames / FPS : 0;
  const starts = measured.map((_, index) => measured.slice(0, index).reduce((total, film) => total + film.durationSec - crossfadeSec, 0));
  const filmSec = measured.reduce((total, film) => total + film.durationSec, 0) - crossfadeSec * (films.length - 1), durationSec = filmSec + creditsSec;

  mkdirSync(outDir, {recursive: true});
  const mp4Path = join(outDir, "export.mp4"), vttPath = join(outDir, "captions.vtt"), srtPath = join(outDir, "captions.srt");
  const cues = featureCaptions(films.map((film, index) => ({cues: film.captionsPath ? vttCues(readFileSync(film.captionsPath, "utf8")) : [], start: starts[index]!, durationSec: measured[index]!.durationSec})));
  const shown = cues.length ? cues : [{start: 0, end: 1, text: "[no dialogue]"}];
  writeFileSync(vttPath, ["WEBVTT", "", ...shown.flatMap(cue => [`${stamp(cue.start)} --> ${stamp(cue.end)}`, cue.text, ""])].join("\n"));
  writeFileSync(srtPath, shown.flatMap((cue, index) => [String(index + 1), `${stamp(cue.start, true)} --> ${stamp(cue.end, true)}`, cue.text, ""]).join("\n"));

  const inputs = [...films.map(film => film.path), ...(title ? [title.path] : []), ...(credits ? [credits.path] : [])].flatMap(path => ["-i", path]);
  const filter = featureFilmFilter(measured, crossfadeSec, {width, height}, title ? films.length : null, credits ? {input: films.length + (title ? 1 : 0), seconds: creditsSec} : null);
  await runAsync(["ffmpeg", "-y", "-v", "error", "-nostdin", ...inputs, "-filter_complex", filter, "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "aac", "-b:a", "128k",
    "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact", mp4Path], signal);
  // The assembler's gate: codec, size, frame rate, duration, bitrate and sound, before anything is recorded.
  const ffprobe = validateExport(JSON.parse(await runAsync(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", mp4Path], signal)), {width, height, fps: FPS, durationSec});
  const {credentials, sidecarPath} = await exportCredentials(signer, {mp4Path, recordDirectory: outDir, spec: FEATURE_FILM_SPEC, projectId, signedAt: assembledAt}, signal);
  const sha256 = await sha256Stream(mp4Path, signal);
  const manifestPath = join(outDir, "provenance.json");
  writeFileSync(manifestPath, JSON.stringify({spec: FEATURE_FILM_SPEC, issuer: PROVENANCE_ISSUER, projectId, assembledAt, ...options.record,
    films: measured.map((film, index) => ({...film, startSec: Number(starts[index]!.toFixed(3))})), crossfadeSec, creditsSec, durationSec: Number(durationSec.toFixed(3)), ffprobe, credentials}, null, 2) + "\n", {flag: "wx"});
  const hlsPlaylistPath = join(outDir, "hls", "index.m3u8");
  mkdirSync(join(outDir, "hls"), {recursive: true});
  await runAsync(["ffmpeg", "-y", "-v", "error", "-nostdin", "-i", mp4Path, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-hls_time", "2", "-hls_list_size", "0", "-hls_playlist_type", "vod",
    "-hls_segment_filename", join(outDir, "hls", "segment-%03d.ts"), hlsPlaylistPath], signal);
  return {mp4Path, hlsPlaylistPath, vttPath, srtPath, manifestPath, ...(sidecarPath ? {c2paPath: sidecarPath} : {}), sha256, durationSec, crossfadeSec, credentials, ffprobe, films: measured};
}
