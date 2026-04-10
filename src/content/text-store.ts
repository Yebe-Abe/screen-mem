// text_store capability — content-addressed write for OCR text snapshots.
// File is named by wall-clock time (so the agent can find content by when),
// but a sibling marker in `.dedup/` records the content hash so a duplicate
// snapshot (same screen text 30 seconds apart) doesn't write a second file.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureDir, pathExists } from "../utils/fs.js";
import { sha256 } from "../utils/hashing.js";

export interface TextStore {
  /**
   * Write `text` as `base-HH-MM.txt` in the session's content directory.
   * No-op if a previous write in the same session already stored identical
   * text. The wallClock argument is in "HH:MM" format.
   */
  write(
    sessionContentDir: string,
    wallClock: string,
    text: string
  ): Promise<void>;
}

export function createTextStore(): TextStore {
  return {
    async write(sessionContentDir, wallClock, text): Promise<void> {
      await ensureDir(sessionContentDir);
      const dedupDir = path.join(sessionContentDir, ".dedup");
      await ensureDir(dedupDir);

      const hash = sha256(text);
      const marker = path.join(dedupDir, `text-${hash}`);
      if (await pathExists(marker)) return;

      const filename = `base-${wallClock.replace(":", "-")}.txt`;
      await fs.writeFile(path.join(sessionContentDir, filename), text, "utf8");
      await fs.writeFile(marker, "");
    },
  };
}
