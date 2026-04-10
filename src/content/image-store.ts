// image_store capability — content-addressed write for frame images. Same
// shape as text_store but for binary content.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureDir, pathExists } from "../utils/fs.js";
import { sha256 } from "../utils/hashing.js";

export interface ImageStore {
  /**
   * Write `bytes` as `frame-HH-MM.jpg` in the session's content directory.
   * No-op if a previous write in the same session already stored identical
   * image bytes.
   */
  write(
    sessionContentDir: string,
    wallClock: string,
    bytes: Buffer
  ): Promise<void>;
}

export function createImageStore(): ImageStore {
  return {
    async write(sessionContentDir, wallClock, bytes): Promise<void> {
      await ensureDir(sessionContentDir);
      const dedupDir = path.join(sessionContentDir, ".dedup");
      await ensureDir(dedupDir);

      const hash = sha256(bytes);
      const marker = path.join(dedupDir, `image-${hash}`);
      if (await pathExists(marker)) return;

      const filename = `frame-${wallClock.replace(":", "-")}.jpg`;
      await fs.writeFile(path.join(sessionContentDir, filename), bytes);
      await fs.writeFile(marker, "");
    },
  };
}
