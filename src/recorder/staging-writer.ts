// staging_writer capability — owns the staging directory layout. Knows the
// filename format (clip-HH-MM.mp4 / idle-HH-MM) so the index module on the
// other end can parse them with parseStagingFilename().

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { ensureDir } from "../utils/fs.js";
import {
  formatClipFilename,
  formatIdleFilename,
} from "../utils/timestamps.js";

export interface StagingWriter {
  /**
   * Reserve a clip output path for the given hour/minute. The recorder writes
   * the MP4 directly to this path via ffmpeg. Returns the absolute path.
   */
  clipPath(hour: number, minute: number): Promise<string>;
  /** Write a zero-byte idle marker for the given hour/minute. */
  writeIdleMarker(hour: number, minute: number): Promise<void>;
}

export function createStagingWriter(stagingDir: string): StagingWriter {
  return {
    async clipPath(hour: number, minute: number): Promise<string> {
      await ensureDir(stagingDir);
      return path.join(stagingDir, formatClipFilename(hour, minute));
    },
    async writeIdleMarker(hour: number, minute: number): Promise<void> {
      await ensureDir(stagingDir);
      const p = path.join(stagingDir, formatIdleFilename(hour, minute));
      await fs.writeFile(p, "");
    },
  };
}
