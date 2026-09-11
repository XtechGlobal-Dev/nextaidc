/**
 * Minimal single-range `Range: bytes=…` parsing (RFC 9110 §14.1.2).
 *
 * Used by the recording proxy so an audio player can seek: a media element that
 * jumps mid-file issues a byte-range request, and a server that answers 200 with
 * the whole file from byte 0 makes the browser restart playback from the start.
 *
 * Returns:
 *  - `{ start, end }` — an inclusive, clamped range to serve as 206.
 *  - `"unsatisfiable"` — syntactically valid but outside the resource → 416.
 *  - `null` — not a form we handle (multi-range, other units) → serve the whole
 *    body as a normal 200, which the spec allows.
 */
export type ByteRange = { start: number; end: number };

export function parseByteRange(header: string, size: number): ByteRange | "unsatisfiable" | null {
  if (size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // multi-range or a unit we don't implement
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return "unsatisfiable";

  let start: number;
  let end: number;

  if (rawStart === "") {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return "unsatisfiable";
    if (end > size - 1) end = size - 1; // clamp an over-long end, per spec
  }

  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}
