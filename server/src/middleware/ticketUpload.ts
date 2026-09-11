import type { Request } from "express";
import multer from "multer";
import { badRequest } from "../lib/http.js";
import { isStorageConfigured, uploadObject } from "../services/storage.js";
import { signAttachment, type AttachmentDescriptor } from "../services/tickets.js";
import {
  MAX_VIDEO_BYTES,
  SUPPORTED_FILES_LABEL,
  formatBytes,
  isAllowedAttachment,
  maxBytesFor,
} from "../lib/ticketFiles.js";

/* ------------------------------------------------------------------ *
 *  One shared upload path for every ticket surface — both lanes, both
 *  sides. Files are held in memory and streamed straight to S3: the cap
 *  is small enough that no disk staging is warranted, and it keeps the
 *  routers from each inventing their own limits.
 * ------------------------------------------------------------------ */

export const ticketUpload = multer({
  storage: multer.memoryStorage(),
  // The largest cap any type gets; the per-type cap is applied below, once the
  // file's type is known.
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (isAllowedAttachment(file.mimetype, file.originalname)) cb(null, true);
    else cb(badRequest(`That file type isn't supported. You can attach ${SUPPORTED_FILES_LABEL}.`));
  },
});

/**
 * Put the uploaded file in the bucket and hand back a SIGNED descriptor the
 * client replays when it sends the message. Nothing is written to the database
 * yet: the file is only staged, exactly like an unsent draft.
 */
export async function storeTicketUpload(
  req: Request,
  prefix = "tickets",
): Promise<AttachmentDescriptor> {
  const file = req.file;
  if (!file) throw badRequest("No file was uploaded.");
  if (!isStorageConfigured()) {
    throw badRequest(
      "File uploads aren't available right now. Please send your message without the attachment.",
    );
  }
  const cap = maxBytesFor(file.mimetype);
  if (file.size > cap) {
    throw badRequest(
      cap === MAX_VIDEO_BYTES
        ? `Videos must be ${formatBytes(cap)} or smaller.`
        : `Files must be ${formatBytes(cap)} or smaller (videos up to ${formatBytes(MAX_VIDEO_BYTES)}).`,
    );
  }
  // Re-check after multer: the filter runs on the declared type, and this is the
  // last point where both the type and the name are known together.
  if (!isAllowedAttachment(file.mimetype, file.originalname)) {
    throw badRequest(`That file type isn't supported. You can attach ${SUPPORTED_FILES_LABEL}.`);
  }

  const { url, key } = await uploadObject(prefix, file.buffer, file.mimetype, file.originalname);
  return signAttachment({
    // Keep the display name the sender saw, but strip any path the browser sent.
    name: file.originalname.split(/[\\/]/).pop()!.slice(0, 200),
    mime: file.mimetype,
    size: file.size,
    key,
    url,
  });
}
