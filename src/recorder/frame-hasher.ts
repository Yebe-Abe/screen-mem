// frame_hasher capability — owns the idle-detection policy. Captures a
// single frame, hashes it, and remembers the previous hash so the orchestrator
// can ask "is this the same frame as last time?".
//
// V1 policy: exact SHA-256 of the raw frame bytes. Conservative — favors
// recording over over-aggressive idle skipping. Anything that changes a single
// pixel will count as activity (cursor blink, clock tick). The 60-second
// granularity already smooths most of that out: if the clock ticks during the
// pre-record sample, we record a 1-min clip; the next sample after that clip
// will likely match and we'll write an idle marker.
//
// Future: a perceptual hash (pHash) would let us tolerate minor visual noise.
// The interface is shaped to accept that swap without changing the orchestrator.

import type { ScreenCapture } from "./screen-capture.js";
import { sha256 } from "../utils/hashing.js";

export interface FrameHasher {
  /**
   * Sample the screen, hash it, compare to the last sample. Returns whether
   * the screen is idle (true if same as last hash). Side effect: updates
   * the stored "last hash".
   *
   * The first call always returns false because there's no previous sample
   * to compare against — we record the first clip unconditionally so the
   * VLM can establish a working session description.
   */
  isIdle(): Promise<boolean>;
}

export function createFrameHasher(capture: ScreenCapture): FrameHasher {
  let lastHash: string | null = null;
  return {
    async isIdle(): Promise<boolean> {
      const bytes = await capture.captureFrameBytes();
      const hash = sha256(bytes);
      const idle = lastHash !== null && hash === lastHash;
      lastHash = hash;
      return idle;
    },
  };
}
