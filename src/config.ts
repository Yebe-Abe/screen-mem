// Configuration is environment variables + sane defaults. No config file in V1.
// FIREWORKS_API_KEY is the only required variable; everything else has a
// reasonable default and can be overridden.

import * as os from "node:os";
import * as path from "node:path";

export interface Config {
  // Filesystem locations
  contextDir: string; // where the agent-facing index is written
  stagingDir: string; // where the recorder hands clips to the processor
  logDir: string; // where component logs are written

  // Recording / processing cadence
  clipDurationSec: number; // length of one clip
  pollIntervalMs: number; // how often the index module polls staging
  idleTimeoutClips: number; // consecutive idle markers before session auto-close
  backlogCeiling: number; // halt recording if staging has more than this many items

  // Platform
  platform: "darwin" | "win32" | "linux";

  // Screen-capture input override. Empty string means "use the per-OS default":
  //   darwin → "1:none"      (avfoundation: device index 1, no audio)
  //   win32  → "desktop"     (gdigrab)
  //   linux  → $DISPLAY or ":0.0"  (x11grab)
  // Set this if `ffmpeg -f avfoundation -list_devices true -i ""` shows your
  // screen at a different index, or if you want to capture a specific display.
  captureInput: string;

  // Fireworks
  fireworksApiKey: string;
  fireworksBaseUrl: string;
  fireworksVlmModel: string;
  fireworksTextModel: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got '${raw}'`);
  }
  return parsed;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function detectPlatform(): "darwin" | "win32" | "linux" {
  const p = process.platform;
  if (p === "darwin" || p === "win32" || p === "linux") return p;
  throw new Error(`Unsupported platform: ${p}`);
}

export function loadConfig(): Config {
  const home = os.homedir();
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "FIREWORKS_API_KEY environment variable is required. " +
        "Get a key from https://fireworks.ai and export it before running."
    );
  }

  return {
    contextDir: envStr("SCREEN_MEMORY_CONTEXT_DIR", path.join(home, "context")),
    stagingDir: envStr(
      "SCREEN_MEMORY_STAGING_DIR",
      path.join(home, ".screen-memory", "staging")
    ),
    logDir: envStr(
      "SCREEN_MEMORY_LOG_DIR",
      path.join(home, ".screen-memory", "logs")
    ),
    clipDurationSec: envInt("SCREEN_MEMORY_CLIP_DURATION_SEC", 60),
    pollIntervalMs: envInt("SCREEN_MEMORY_POLL_INTERVAL_MS", 30_000),
    idleTimeoutClips: envInt("SCREEN_MEMORY_IDLE_TIMEOUT_CLIPS", 5),
    backlogCeiling: envInt("SCREEN_MEMORY_BACKLOG_CEILING", 60),
    platform: detectPlatform(),
    captureInput: envStr("SCREEN_MEMORY_CAPTURE_INPUT", ""),
    fireworksApiKey: apiKey,
    fireworksBaseUrl: envStr(
      "FIREWORKS_BASE_URL",
      "https://api.fireworks.ai/inference/v1"
    ),
    fireworksVlmModel: envStr(
      "FIREWORKS_VLM_MODEL",
      "accounts/fireworks/models/qwen2p5-vl-32b-instruct"
    ),
    fireworksTextModel: envStr(
      "FIREWORKS_TEXT_MODEL",
      "accounts/fireworks/models/qwen3-235b-a22b-instruct-2507"
    ),
  };
}
