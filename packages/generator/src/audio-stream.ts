/** Bounded SSE framing, independent of TCP chunk, UTF-8 or CRLF boundaries. */
export class AudioStreamError extends Error { override name = "AudioStreamError"; }
const MAX_FRAME = 2 * 1024 * 1024, MAX_STREAM = 96 * 1024 * 1024, MAX_EVENTS = 50000;

export function audioAbortable<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { if (!settled) { settled = true; reject(new AudioStreamError("Audio request interrupted.")); } };
    signal.addEventListener("abort", abort, {once: true});
    if (signal.aborted) abort();
    promise.then(value => { signal.removeEventListener("abort", abort); if (settled) { try { late?.(value); } catch { /* Cleanup must not create an unhandled rejection. */ } } else { settled = true; resolve(value); } },
      error => { signal.removeEventListener("abort", abort); if (!settled) { settled = true; reject(error); } });
  });
}

export async function readAudioSse(response: Response, signal: AbortSignal, event: (value: unknown) => boolean): Promise<void> {
  if (!response.body || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") {
    void response.body?.cancel().catch(() => {});
    throw new AudioStreamError("The audio provider did not return an event stream.");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", {fatal: true});
  let pending = "", scanned = 0, data: string[] = [], frameSize = 0, total = 0, count = 0;
  const line = (value: string): boolean => {
    frameSize += value.length + 1;
    if (frameSize > MAX_FRAME) throw new AudioStreamError("Audio event exceeds its size limit.");
    if (!value) {
      frameSize = 0;
      if (!data.length) return false;
      if (++count > MAX_EVENTS) throw new AudioStreamError("Audio stream exceeds its event limit.");
      const json = data.join("\n"); data = [];
      return event(JSON.parse(json));
    }
    if (value.startsWith(":")) return false;
    const colon = value.indexOf(":"), field = colon === -1 ? value : value.slice(0, colon);
    let content = colon === -1 ? "" : value.slice(colon + 1); if (content.startsWith(" ")) content = content.slice(1);
    if (field === "data") data.push(content);
    return false;
  };
  const drain = (eof: boolean): boolean => {
    let consumed = 0;
    for (let i = scanned; i < pending.length; i++) {
      scanned = i + 1;
      if (pending[i] !== "\r" && pending[i] !== "\n") continue;
      if (pending[i] === "\r" && i === pending.length - 1 && !eof) { scanned = i; break; }
      const value = pending.slice(consumed, i);
      if (pending[i] === "\r" && pending[i + 1] === "\n") i++;
      consumed = i + 1; scanned = consumed;
      if (line(value)) return true;
    }
    pending = pending.slice(consumed); scanned -= consumed;
    if (pending.length + frameSize > MAX_FRAME) throw new AudioStreamError("Audio event exceeds its size limit.");
    return false;
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await audioAbortable(reader.read(), signal);
      if (next.done) {
        pending += decoder.decode();
        if (drain(true)) return;
        // SSE requires a blank line to dispatch the terminal event. EOF itself is
        // not a successful completion and must not turn partial audio into a take.
        throw new AudioStreamError("Audio stream ended without its completion event.");
      }
      total += next.value.length;
      if (total > MAX_STREAM) throw new AudioStreamError("Audio stream exceeds its byte limit.");
      pending += decoder.decode(next.value, {stream: true});
      if (drain(false)) return;
    }
  } finally {
    // Do not wait for a remote cancellation acknowledgement. SSE disconnect does
    // not establish that generation stopped or that the provider did not bill.
    void reader.cancel().catch(() => {});
  }
}
