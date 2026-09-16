// Client mirror of server/src/lib/ticketFiles.ts, so the composer can reject a file before a 10 MB upload.
// The server list is the one that enforces; keep this in step with it.

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB per file
/** Video is the one thing nobody can make small — a screen recording gets more room. */
export const MAX_VIDEO_BYTES = 40 * 1024 * 1024; // 40 MB per video
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/** Longest message — a ticket description, a reply, a saved reply — in characters. */
export const MAX_MESSAGE_CHARS = 1_000;

/** What people can pick from disk, in the words the UI uses. Keep in step with ALLOWED. */
export const SUPPORTED_FILES_LABEL =
  "PDF, DOC/DOCX, PPT/PPTX, XLS/XLSX, TXT, CSV, JPG/PNG/GIF/WebP/HEIC, MP4/MOV, MP3/WAV, ZIP";

const ALLOWED: Record<string, string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "image/heic": ["heic"],
  "application/pdf": ["pdf"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.ms-powerpoint": ["ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "text/plain": ["txt"],
  "text/csv": ["csv"],
  "application/zip": ["zip"],
  "application/x-zip-compressed": ["zip"],
  "video/mp4": ["mp4"],
  "video/quicktime": ["mov"],
  "audio/mpeg": ["mp3"],
  "audio/mp3": ["mp3"],
  "audio/wav": ["wav"],
  "audio/x-wav": ["wav"],
};

export const ALLOWED_EXTENSIONS: string[] = [...new Set(Object.values(ALLOWED).flat())].sort();

/** `accept` attribute for the hidden file input — extensions AND types, since
 *  some platforms match on one and some on the other. */
export const FILE_ACCEPT = [
  ...ALLOWED_EXTENSIONS.map((e) => `.${e}`),
  ...Object.keys(ALLOWED),
].join(",");

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  // A limit reads as "10 MB", not "10.0 MB"; a real file keeps its "2.4 MB".
  return `${mb.endsWith(".0") ? mb.slice(0, -2) : mb} MB`;
}

export type FileKind = "image" | "pdf" | "doc" | "sheet" | "slides" | "archive" | "media" | "text";

/** Which icon and accent the attachment chip should wear. */
export function fileKind(mime: string, name: string): FileKind {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/") || m.startsWith("video/")) return "media";
  if (m === "application/pdf") return "pdf";
  if (m.includes("spreadsheet") || m.includes("ms-excel")) return "sheet";
  if (m.includes("presentation") || m.includes("powerpoint")) return "slides";
  if (m.includes("word")) return "doc";
  if (m.includes("zip")) return "archive";
  const ext = extensionOf(name);
  if (ext === "csv" || ext === "xlsx" || ext === "xls") return "sheet";
  return "text";
}

/** Why this file can't be sent, or null when it's fine. */
export function rejectionReason(file: File): string | null {
  if (!isAllowedAttachment(file.type, file.name)) {
    return `${file.name} isn't a supported file type. You can attach ${SUPPORTED_FILES_LABEL}.`;
  }
  const cap = maxBytesFor(file.type);
  if (file.size > cap) {
    return cap === MAX_VIDEO_BYTES
      ? `${file.name} is ${formatBytes(file.size)} — videos must be ${formatBytes(cap)} or smaller.`
      : `${file.name} is ${formatBytes(file.size)} — files must be ${formatBytes(cap)} or smaller (videos up to ${formatBytes(MAX_VIDEO_BYTES)}).`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  return null;
}
