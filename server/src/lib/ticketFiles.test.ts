import { describe, it, expect } from "vitest";
import {
  ALLOWED_EXTENSIONS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_CHARS,
  MAX_VIDEO_BYTES,
  extensionOf,
  formatBytes,
  isAllowedAttachment,
  isImageMime,
  maxBytesFor,
} from "./ticketFiles.js";

/* The attachment allow-list is the only thing standing between the ticket
 * uploader and the bucket, so its edges are worth pinning down. */

describe("isAllowedAttachment", () => {
  it("accepts a file whose type and extension agree", () => {
    expect(isAllowedAttachment("image/png", "screenshot.png")).toBe(true);
    expect(isAllowedAttachment("image/jpeg", "photo.JPG")).toBe(true);
    expect(isAllowedAttachment("application/pdf", "invoice.pdf")).toBe(true);
    expect(isAllowedAttachment("text/csv", "calls.csv")).toBe(true);
    expect(isAllowedAttachment("video/mp4", "screen.mp4")).toBe(true);
    expect(isAllowedAttachment("application/zip", "logs.zip")).toBe(true);
    expect(
      isAllowedAttachment(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "calls.xlsx",
      ),
    ).toBe(true);
  });

  it("rejects a type that isn't on the list at all", () => {
    expect(isAllowedAttachment("application/x-msdownload", "setup.exe")).toBe(false);
    expect(isAllowedAttachment("text/html", "page.html")).toBe(false);
    expect(isAllowedAttachment("application/x-sh", "run.sh")).toBe(false);
    // SVG is an image that can carry script, so it is deliberately absent.
    expect(isAllowedAttachment("image/svg+xml", "icon.svg")).toBe(false);
  });

  it("rejects an executable wearing an allowed MIME type", () => {
    // The whole point of checking both: the browser's declared type is a hint,
    // the extension is what the recipient's machine will actually open.
    expect(isAllowedAttachment("image/png", "payload.exe")).toBe(false);
    expect(isAllowedAttachment("application/pdf", "invoice.pdf.bat")).toBe(false);
  });

  it("rejects an allowed extension announced as a type it doesn't belong to", () => {
    expect(isAllowedAttachment("image/png", "sheet.xlsx")).toBe(false);
    expect(isAllowedAttachment("video/mp4", "song.mp3")).toBe(false);
  });

  it("rejects a file with no extension", () => {
    expect(isAllowedAttachment("image/png", "screenshot")).toBe(false);
  });

  it("is case-insensitive on both halves", () => {
    expect(isAllowedAttachment("IMAGE/PNG", "Shot.PNG")).toBe(true);
  });
});

describe("extensionOf", () => {
  it("takes the last segment, lowercased", () => {
    expect(extensionOf("archive.tar.gz")).toBe("gz");
    expect(extensionOf("REPORT.PDF")).toBe("pdf");
  });

  it("returns empty for a name with no dot", () => {
    expect(extensionOf("README")).toBe("");
  });
});

describe("allow-list shape", () => {
  it("never lists an executable or scriptable extension", () => {
    for (const ext of ["exe", "bat", "cmd", "sh", "ps1", "js", "html", "svg"]) {
      expect(ALLOWED_EXTENSIONS).not.toContain(ext);
    }
  });

  it("covers the everyday support attachments", () => {
    for (const ext of ["png", "jpg", "pdf", "csv", "xlsx", "zip", "mp4"]) {
      expect(ALLOWED_EXTENSIONS).toContain(ext);
    }
  });
});

describe("limits", () => {
  it("are what the composer tells people", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_VIDEO_BYTES).toBe(40 * 1024 * 1024);
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(5);
    expect(MAX_MESSAGE_CHARS).toBe(1000);
  });
});

describe("maxBytesFor", () => {
  it("gives video the bigger cap and everything else the usual one", () => {
    expect(maxBytesFor("video/mp4")).toBe(MAX_VIDEO_BYTES);
    expect(maxBytesFor("VIDEO/QUICKTIME")).toBe(MAX_VIDEO_BYTES);
    expect(maxBytesFor("image/png")).toBe(MAX_ATTACHMENT_BYTES);
    expect(maxBytesFor("")).toBe(MAX_ATTACHMENT_BYTES);
  });
});

describe("isImageMime", () => {
  it("only treats image/* as an image", () => {
    expect(isImageMime("image/webp")).toBe(true);
    expect(isImageMime("application/pdf")).toBe(false);
    expect(isImageMime("")).toBe(false);
  });
});

describe("formatBytes", () => {
  it("scales the unit to the size", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  it("drops the pointless decimal on a whole number of megabytes", () => {
    expect(formatBytes(MAX_ATTACHMENT_BYTES)).toBe("10 MB");
    expect(formatBytes(MAX_VIDEO_BYTES)).toBe("40 MB");
  });
});
