/* ------------------------------------------------------------------ *
 *  What may go into a ticket: how long a message can be, and what may
 *  be attached to it.
 *
 *  Allow-list, never a block-list: anything not named here is rejected,
 *  so a new dangerous extension can't sneak in by default. The browser's
 *  reported MIME type is only a hint, so the extension has to line up
 *  with it too — that is what stops `payload.exe` renamed to `.png`.
 *
 *  Mirrored (labels + limits only) in src/lib/ticketFiles.ts so the
 *  composer can reject a file before it ever leaves the browser. The
 *  server list here is the one that actually enforces.
 * ------------------------------------------------------------------ */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB per file
/** Video is the one thing nobody can make small — a screen recording gets more room. */
export const MAX_VIDEO_BYTES = 40 * 1024 * 1024; // 40 MB per video
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/** Longest message — a ticket description, a reply, a saved reply — in characters. */
export const MAX_MESSAGE_CHARS = 1_000;
export const MESSAGE_TOO_LONG = `Messages can be up to ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters.`;

/** What people can pick from disk, in the words the UI uses. Keep in step with ALLOWED. */
export const SUPPORTED_FILES_LABEL =
  "PDF, DOC/DOCX, PPT/PPTX, XLS/XLSX, TXT, CSV, JPG/PNG/GIF/WebP/HEIC, MP4/MOV, MP3/WAV, ZIP";

/** mime → the extensions that are legitimately allowed to carry it. */
const ALLOWED: Record<string, string[]> = {
  // Images
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "image/heic": ["heic"],
  // Documents
  "application/pdf": ["pdf"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.ms-powerpoint": ["ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "text/plain": ["txt"],
  "text/csv": ["csv"],
  // Archives — support often needs a bundle of logs.
  "application/zip": ["zip"],
  "application/x-zip-compressed": ["zip"],
  // Video — screen recordings. Capped by MAX_VIDEO_BYTES rather than the usual limit.
  "video/mp4": ["mp4"],
  "video/quicktime": ["mov"],
  // Audio picked from disk.
  "audio/mpeg": ["mp3"],
  "audio/mp3": ["mp3"],
  "audio/wav": ["wav"],
  "audio/x-wav": ["wav"],
};

/** Human list for error copy and the "what can I attach?" hint. */
export const ALLOWED_EXTENSIONS: string[] = [...new Set(Object.values(ALLOWED).flat())].sort();

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/**
 * True when the MIME type is allowed AND the filename's extension is one that
 * type legitimately uses. Both must agree — a `.exe` announcing itself as
 * `image/png` fails on the extension, and a real `.png` posted with a forged
 * `application/x-msdownload` fails on the type.
 */
export function isAllowedAttachment(mime: string, filename: string): boolean {
  const exts = ALLOWED[(mime || "").toLowerCase()];
  if (!exts) return false;
  return exts.includes(extensionOf(filename));
}

/** The size cap for a file of this type — video gets the bigger one. */
export function maxBytesFor(mime: string): number {
  return (mime || "").toLowerCase().startsWith("video/") ? MAX_VIDEO_BYTES : MAX_ATTACHMENT_BYTES;
}

export function isImageMime(mime: string): boolean {
  return (mime || "").toLowerCase().startsWith("image/");
}

/** "2.4 MB" — used in error messages and the attachment chips. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  // A limit reads as "10 MB", not "10.0 MB"; a real file keeps its "2.4 MB".
  return `${mb.endsWith(".0") ? mb.slice(0, -2) : mb} MB`;
}
