// device_detect capability — runs `ffmpeg -f avfoundation -list_devices true`,
// parses the video device list out of the stderr output, and finds the
// "Capture screen 0" entry. The avfoundation device index is not stable: it
// shifts when you connect/disconnect a Continuity Camera, a USB webcam, or
// another display. Hardcoding the index (or setting it once via env) breaks
// whenever that happens, so the recorder calls this on startup and again
// any time ffmpeg reports "Invalid device index".
//
// The user can still override via SCREEN_MEMORY_CAPTURE_INPUT — screen-capture
// skips auto-detection entirely if that env var is set.

import { spawn } from "node:child_process";
import { createLogger } from "../logging.js";

const log = createLogger("recorder:device-detect");

export interface AvfoundationDevice {
  index: number;
  name: string;
}

/**
 * Find the avfoundation input string for the primary screen capture device
 * (e.g. "1:none"). Returns null if ffmpeg is missing, the list can't be
 * parsed, or no screen-capture device is present in the list.
 */
export async function detectScreenCaptureInput(): Promise<string | null> {
  let stderr: string;
  try {
    stderr = await runListDevices();
  } catch (err) {
    log.warn("ffmpeg -list_devices failed", {
      error: (err as Error).message,
    });
    return null;
  }

  const videoDevices = parseVideoDevices(stderr);
  if (videoDevices.length === 0) {
    log.warn("no avfoundation video devices parsed from ffmpeg output");
    return null;
  }

  // Prefer "Capture screen 0" exact match, fall back to any device whose
  // name starts with "Capture screen" (multi-display Macs have "Capture
  // screen 1", "Capture screen 2", etc.; pick the first).
  const primary =
    videoDevices.find((d) => /^Capture screen 0$/i.test(d.name)) ??
    videoDevices.find((d) => /^Capture screen\b/i.test(d.name));

  if (!primary) {
    log.warn("no 'Capture screen' device found in avfoundation list", {
      available: videoDevices.map((d) => `[${d.index}] ${d.name}`),
    });
    return null;
  }

  log.info("detected screen capture device", {
    index: primary.index,
    name: primary.name,
  });
  return `${primary.index}:none`;
}

/**
 * Invoke `ffmpeg -f avfoundation -list_devices true -i ""` and return the
 * stderr output. ffmpeg exits non-zero because the empty input path is
 * technically an error; that's expected — we only care about stderr.
 */
function runListDevices(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-f", "avfoundation", "-list_devices", "true", "-i", ""],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });
    child.on("close", () => {
      // Always resolve with whatever stderr we captured — non-zero exit is
      // expected when listing devices.
      resolve(stderr);
    });
  });
}

const DEVICE_LINE_RE =
  /^\[AVFoundation indev @ [^\]]+\]\s+\[(\d+)\]\s+(.+)$/;
const VIDEO_HEADER_RE = /AVFoundation video devices:/i;
const AUDIO_HEADER_RE = /AVFoundation audio devices:/i;

/**
 * Parse the video device section of ffmpeg -list_devices stderr output.
 * The format looks like:
 *
 *   [AVFoundation indev @ 0x...] AVFoundation video devices:
 *   [AVFoundation indev @ 0x...] [0] FaceTime HD Camera
 *   [AVFoundation indev @ 0x...] [1] Capture screen 0
 *   [AVFoundation indev @ 0x...] AVFoundation audio devices:
 *   [AVFoundation indev @ 0x...] [0] Built-in Microphone
 *
 * We walk the lines, flip into "video" mode at the video header, flip out
 * at the audio header, and collect `[N] name` entries in between.
 */
export function parseVideoDevices(stderr: string): AvfoundationDevice[] {
  const devices: AvfoundationDevice[] = [];
  let inVideo = false;
  for (const rawLine of stderr.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (VIDEO_HEADER_RE.test(line)) {
      inVideo = true;
      continue;
    }
    if (AUDIO_HEADER_RE.test(line)) {
      inVideo = false;
      continue;
    }
    if (!inVideo) continue;
    const match = line.match(DEVICE_LINE_RE);
    if (match) {
      devices.push({
        index: Number(match[1]),
        name: match[2]!.trim(),
      });
    }
  }
  return devices;
}
