// Recorder orchestrator. The main loop: every minute, sample → hash → decide
// → record clip OR write idle marker. Stops when an external signal flips
// the running flag (the CLI installs a SIGINT handler that calls stop()).
//
// The loop is timer-driven by wall-clock minute boundaries: tick at the top
// of each minute, do work, sleep until the next minute. If a recording (~60s
// of ffmpeg) overruns the next minute boundary, we skip ahead — never queue
// up work that's already overdue.

import type { Config } from "../config.js";
import { createLogger } from "../logging.js";
import { createBacklogMonitor } from "./backlog-monitor.js";
import { createFrameHasher } from "./frame-hasher.js";
import { createScreenCapture } from "./screen-capture.js";
import { createStagingWriter } from "./staging-writer.js";

const log = createLogger("recorder");

export interface Recorder {
  start(): Promise<void>;
  stop(): void;
}

export function createRecorder(config: Config): Recorder {
  const capture = createScreenCapture(config);
  const hasher = createFrameHasher(capture);
  const writer = createStagingWriter(config.stagingDir);
  const backlog = createBacklogMonitor(
    config.stagingDir,
    config.backlogCeiling
  );

  let running = false;
  let halted = false;

  async function tick(now: Date): Promise<void> {
    if (await backlog.isOverCeiling()) {
      if (!halted) {
        halted = true;
        log.error(
          "backlog over ceiling — halting recording until processor catches up",
          { ceiling: config.backlogCeiling }
        );
      }
      return;
    }
    if (halted) {
      log.info("backlog drained — resuming recording");
      halted = false;
    }

    const hour = now.getHours();
    const minute = now.getMinutes();

    let idle: boolean;
    try {
      idle = await hasher.isIdle();
    } catch (err) {
      log.warn("frame hash failed — recording clip anyway", {
        error: (err as Error).message,
      });
      idle = false;
    }

    if (idle) {
      try {
        await writer.writeIdleMarker(hour, minute);
        log.debug("idle marker written", { hour, minute });
      } catch (err) {
        log.error("failed to write idle marker", {
          error: (err as Error).message,
        });
      }
      return;
    }

    let clipPath: string;
    try {
      clipPath = await writer.clipPath(hour, minute);
    } catch (err) {
      log.error("failed to reserve clip path", {
        error: (err as Error).message,
      });
      return;
    }

    try {
      await capture.recordClip(clipPath, config.clipDurationSec);
      log.info("clip recorded", { hour, minute, clipPath });
    } catch (err) {
      log.error("clip recording failed", {
        hour,
        minute,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Sleep until the start of the next clock minute. Returns the Date that
   * this loop iteration "belongs to" — i.e., the minute we just woke up at.
   */
  function sleepUntilNextMinute(): Promise<Date> {
    return new Promise((resolve) => {
      const now = new Date();
      const msToNextMinute = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());
      setTimeout(() => resolve(new Date()), Math.max(0, msToNextMinute));
    });
  }

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      log.info("recorder started", {
        stagingDir: config.stagingDir,
        clipDurationSec: config.clipDurationSec,
        platform: config.platform,
      });

      // First tick at the top of the *next* minute so all filenames align to
      // minute boundaries. This means a ~0–60s warm-up before the first clip.
      while (running) {
        const tickStart = await sleepUntilNextMinute();
        if (!running) break;
        await tick(tickStart);
      }

      log.info("recorder stopped");
    },

    stop(): void {
      running = false;
    },
  };
}
