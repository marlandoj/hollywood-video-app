/**
 * The studio's film formats (HV-030-01; `feature` added by HV-030-28, Release 3 step 1,
 * G20-202610031349). A reel runs up to 90 s, a short up to 600 s and a feature up to 1,200 s
 * (20 minutes). These three are the only formats: the read-through, the plan step and the style card
 * refuse anything else.
 */
export type FilmFormat = "reel" | "short" | "feature";
export const FILM_FORMATS: readonly FilmFormat[] = Object.freeze(["reel", "short", "feature"] as const);
export const FORMAT_LIMIT_SEC: Readonly<Record<FilmFormat, number>> = Object.freeze({reel: 90, short: 600, feature: 1200});
export const isFilmFormat = (value: unknown): value is FilmFormat => typeof value === "string" && (FILM_FORMATS as readonly string[]).includes(value);
