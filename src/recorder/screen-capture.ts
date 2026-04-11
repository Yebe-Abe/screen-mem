// screen_capture capability — wraps ffmpeg subprocesses for two operations:
// recording a 1-min clip and grabbing a single still frame for the idle hash.
// Per-OS input flags are encapsulated here so the rest of the recorder is
// platform-agnostic.
//
// On macOS, the avfoundation device index for the screen isn't stable — it
// shifts when a Continuity Camera / USB webcam / secondary display connects
// or disconnects. This module resolves the input lazily via
// `detectScreenCaptureInput` (runs `ffmpeg -list_devices` and finds
// "Capture screen 0"), caches the result, and re-detects on any "Invalid
// device index" failure. If the user has set SCREEN_MEMORY_CAPTURE_INPUT
// explicitly, their override wins and auto-detection is skipped entirely.

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../config.js";
import { createLogger } from "../logging.js";
import { detectScreenCaptureInput } from "./device-detect.js";

const log = createLogger("recorder:screen-capture");

const FRAMERATE = "10";

/**
 * Build the `-f <fmt> -framerate N -i <input>` arguments for the configured
 * platform. On macOS this may run auto-detection against avfoundation's
 * device list; other platforms are purely config-driven.
 *
 * Called lazily (on first recording) so detection doesn't run until the user
 * has a chance to grant Screen Recording permission.
 */
async function resolveInputArgs(config: Config): Promise<string[]> {
  switch (config.platform) {
    case "darwin": {
      // User override always wins — they know what they want.
      if (config.captureInput) {
        return ["-f", "avfoundation", "-framerate", FRAMERATE, "-i", config.captureInput];
      }
      const detected = await detectScreenCaptureInput();
      if (detected) {
        return ["-f", "avfoundation", "-framerate", FRAMERATE, "-i", detected];
      }
      // Fallback if detection failed: assume screen is at index 1 (common
      // on Macs without Continuity Camera / external webcam).
      log.warn("screen device detection failed, falling back to '1:none'");
      return ["-f", "avfoundation", "-framerate", FRAMERATE, "-i", "1:none"];
    }
    case "win32":
      return [
        "-f",
        "gdigrab",
        "-framerate",
        FRAMERATE,
        "-i",
        config.captureInput || "desktop",
      ];
    case "linux":
      return [
        "-f",
        "x11grab",
        "-framerate",
        FRAMERATE,
        "-i",
        config.captureInput || process.env.DISPLAY || ":0.0",
      ];
  }
}

/** True if the ffmpeg stderr signals a missing / shifted avfoundation device. */
function isInvalidDeviceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /Invalid device index|Error opening input file/i.test(err.message);
}

export interface ScreenCapture {
  /** Record a clip of the given duration to outputPath. Resolves on success. */
  recordClip(outputPath: string, durationSec: number): Promise<void>;
  /** Capture a single still frame as raw bytes for hashing. */
  captureFrameBytes(): Promise<Buffer>;
}

export function createScreenCapture(config: Config): ScreenCapture {
  // Lazily resolved + cached. First call to either recordClip or
  // captureFrameBytes triggers resolution; later calls hit the cache.
  // `invalidate()` clears the cache so the next call re-detects — used when
  // ffmpeg reports an invalid device index mid-run (phone plugged/unplugged).
  let cachedInputArgs: string[] | null = null;

  async function getInputArgs(): Promise<string[]> {
    if (cachedInputArgs) return cachedInputArgs;
    cachedInputArgs = await resolveInputArgs(config);
    log.info("screen capture input resolved", { inputArgs: cachedInputArgs });
    return cachedInputArgs;
  }

  function invalidate(): void {
    cachedInputArgs = null;
  }

  /**
   * Run ffmpeg with the resolved input args and the caller's output args.
   * If the first attempt fails with "Invalid device index", re-detect the
   * device (which picks up any phone plug/unplug that happened since
   * startup) and retry once with the new input.
   */
  async function runWithRetry(
    buildArgs: (inputArgs: string[]) => string[],
    stderrTag: string
  ): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const inputArgs = await getInputArgs();
      const args = buildArgs(inputArgs);
      try {
        await runFfmpeg(args, { stderrTag });
        return;
      } catch (err) {
        if (attempt === 1 && isInvalidDeviceError(err)) {
          log.warn(
            "capture device index appears invalid — re-detecting avfoundation devices",
            { previous: inputArgs }
          );
          invalidate();
          continue;
        }
        throw err;
      }
    }
  }

  return {
    async recordClip(outputPath: string, durationSec: number): Promise<void> {
      // ffmpeg writes the MP4 incrementally over the full clip duration —
      // if the processor scans staging mid-recording it'll see a half-written
      // file with no moov atom and Fireworks will reject it. Write to a
      // .partial path so the processor's "*.mp4" filename matcher can't see
      // the file until ffmpeg has finished and we rename atomically.
      const partialPath = `${outputPath}.partial`;
      try {
        await runWithRetry(
          (inputArgs) => [
            ...inputArgs,
            "-t",
            String(durationSec),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "ultrafast",
            // Force the mp4 muxer explicitly. ffmpeg normally infers it from
            // the output filename extension, but our partial-write filename
            // ends in ".partial", which it doesn't recognize. Without -f mp4
            // it errors: "Unable to choose an output format for '...mp4.partial'".
            "-f",
            "mp4",
            "-y",
            partialPath,
          ],
          "record"
        );
        await fs.rename(partialPath, outputPath);
      } catch (err) {
        // Best-effort cleanup of the partial file on failure so it doesn't
        // accumulate. The processor would ignore it anyway, but tidy up.
        await fs.unlink(partialPath).catch(() => {
          /* ignore */
        });
        throw err;
      }
    },

    async captureFrameBytes(): Promise<Buffer> {
      const tmpFile = path.join(
        os.tmpdir(),
        `screen-memory-frame-${process.pid}-${Date.now()}.png`
      );
      try {
        await runWithRetry(
          (inputArgs) => [
            ...inputArgs,
            "-frames:v",
            "1",
            "-f",
            "image2",
            "-y",
            tmpFile,
          ],
          "frame"
        );
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
        // ffmpeg is verbose; only include the tail of stderr in logs and the
        // error message. The error message needs enough context for the
        // caller to pattern-match error classes (e.g. "Invalid device index").
        const tail = stderr.split("\n").slice(-5).join("\n");
        log.warn("ffmpeg exited non-zero", { tag: opts.stderrTag, code, tail });
        reject(
          new Error(
            `ffmpeg exited with code ${code} (${opts.stderrTag}): ${tail}`
          )
        );
      }
    });
  });
}
