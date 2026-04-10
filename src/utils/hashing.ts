// Content-addressed storage helpers. Used by the recorder for frame-hash
// idle detection and by the content module for dedup-on-write of OCR text
// and frame images.

import * as crypto from "node:crypto";

/** Hex-encoded SHA-256. Stable across Node versions. */
export function sha256(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Short prefix of a content hash, useful for filenames or log lines. */
export function shortHash(hash: string, length = 12): string {
  return hash.slice(0, length);
}
