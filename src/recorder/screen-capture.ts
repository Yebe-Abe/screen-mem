// screen_capture capability — wraps ffmpeg subprocesses for two operations:
// recording a 1-min clip and grabbing a single still frame for the idle hash.
// Per-OS input flags are encapsulated here so the rest of the recorder is
// platform-agnostic.

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../config.js";
import { createLogger } from "../logging.js";

const log = createLogger("recorder:screen-capture");

/**
 * Build the ffmpeg `-f <fmt> -i <input>` arguments for capturing the primary
 * display on the current OS. The "input" half of the command — output flags
 * are added by the caller.
 */
function inputArgsForPlatform(platform: Config["platform"]): string[] {
  switch (platform) {
    case "darwin":
      // avfoundation device "1:none" = primary display, no audio. Mac users
      // may need to grant Screen Recording permission to the terminal.
      return ["-f", "avfoundation", "-framerate", "10", "-i", "1:none"];
    case "win32":
      return ["-f", "gdigrab", "-framerate", "10", "-i", "desktop"];
    case "linux":
      // x11grab is the safest default. Wayland users will need to set
      // SCREEN_MEMORY_LINUX_DISPLAY or provide an explicit DISPLAY.
      return [
        "-f",
        "x11grab",
        "-framerate",
        "10",
        "-i",
        process.env.DISPLAY ?? ":0.0",
      ];
  }
}

export interface ScreenCapture {
  /** Record a clip of the given duration to outputPath. Resolves on success. */
  recordClip(outputPath: string, durationSec: number): Promise<void>;
  /** Capture a single still frame as raw bytes for hashing. */
  captureFrameBytes(): Promise<Buffer>;
}

export function createScreenCapture(config: Config): ScreenCapture {
  const inputArgs = inputArgsForPlatform(config.platform);

  return {
    async recordClip(outputPath: string, durationSec: number): Promise<void> {
      const args = [
        ...inputArgs,
        "-t",
        String(durationSec),
        // libx264 baseline gives a small file the VLM API will accept
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "ultrafast",
        "-y",
        outputPath,
      ];
      await runFfmpeg(args, { stderrTag: "record" });
    },

    async captureFrameBytes(): Promise<Buffer> {
      const tmpFile = path.join(
        os.tmpdir(),
        `screen-memory-frame-${process.pid}-${Date.now()}.png`
      );
      try {
        const args = [
          ...inputArgs,
          "-frames:v",
          "1",
          "-f",
          "image2",
          "-y",
          tmpFile,
        ];
        await runFfmpeg(args, { stderrTag: "frame" });
        return await fs.readFile(tmpFile);
      } finally {
        await fs.unlink(tmpFile).catch(() => {
          /* best effort */
        });
      }
    },
  };
}

interface RunOpts {
  stderrTag: string;
}

function runFfmpeg(args: string[], opts: RunOpts): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      reject(new Error(`ffmpeg spawn failed (${opts.stderrTag}): ${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        // ffmpeg is verbose; only log the tail to avoid flooding logs
        const tail = stderr.split("\n").slice(-5).join("\n");
        log.warn("ffmpeg exited non-zero", { tag: opts.stderrTag, code, tail });
        reject(new Error(`ffmpeg exited with code ${code} (${opts.stderrTag})`));
      }
    });
  });
}
