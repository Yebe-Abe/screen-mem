// frame_extractor capability — wraps `ffmpeg -ss` to pull a single frame
// from a clip at a given offset and write it as a JPEG.
//
// `-ss` placement matters: putting it *before* `-i` is fast but inaccurate
// (seeks to nearest keyframe); putting it *after* `-i` is accurate but
// reads the whole clip from the start. We use the after-input form because
// 1-minute clips are small and accuracy matters more than speed here.

import { spawn } from "node:child_process";
import type { ClipOffset } from "../types.js";

export interface FrameExtractor {
  /**
   * Extract a single frame at `offset` from `clipPath`, writing it to
   * `outputPath` as a JPEG. Throws on ffmpeg failure.
   */
  extract(
    clipPath: string,
    offset: ClipOffset,
    outputPath: string
  ): Promise<void>;
}

export function createFrameExtractor(): FrameExtractor {
  return {
    async extract(clipPath, offset, outputPath): Promise<void> {
      const seekSeconds = offset.mm * 60 + offset.ss;
      const args = [
        "-i",
        clipPath,
        "-ss",
        String(seekSeconds),
        "-frames:v",
        "1",
        "-q:v",
        "3",
        "-y",
        outputPath,
      ];
      await runFfmpeg(args);
    },
  };
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) =>
      reject(new Error(`ffmpeg spawn failed: ${err.message}`))
    );
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = stderr.split("\n").slice(-5).join("\n");
        reject(new Error(`ffmpeg frame extract exited ${code}: ${tail}`));
      }
    });
  });
}
