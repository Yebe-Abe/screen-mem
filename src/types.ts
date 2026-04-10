// Shared types used across modules. Keep this surface small — only types that
// cross module boundaries belong here. Module-internal types live with the
// modules themselves.

/**
 * The recorder writes one of two things to the staging directory: a clip
 * (1-min MP4) or an idle marker (zero-byte file). The index module reads
 * staging and processes items in timestamp order.
 *
 * The filename embeds the wall-clock time (HH:MM, local time) of when the
 * minute started. This is the only way the index module can recover wall-clock
 * time for VLM-produced deltas, which are clip-relative.
 */
export type StagingKind = "clip" | "idle";

export interface StagingItem {
  kind: StagingKind;
  /** Absolute path on disk. */
  path: string;
  /** Filename only (e.g. "clip-09-00.mp4" or "idle-09-03"). */
  filename: string;
  /**
   * Wall-clock start time encoded in the filename. This is hour-of-day and
   * minute-of-hour only — the recorder writes filenames in local time, and
   * the index module assumes the day from when it reads them.
   */
  hour: number;
  minute: number;
}

/**
 * The VLM continuity verdict — does this clip belong to the same activity as
 * the active session, a different one, or is there no active session?
 */
export type VlmContinuity = "same" | "different" | "new";

/**
 * A timestamp offset within a clip. The VLM produces these in [MM:SS] format
 * because it has no way to know wall-clock time from the video content. The
 * index module converts these to wall-clock time using the clip's filename.
 */
export interface ClipOffset {
  /** Minutes from clip start. Usually 0 (clips are ~1 min) but tolerate >0. */
  mm: number;
  /** Seconds within the minute. 0–59. */
  ss: number;
}

/**
 * One delta as parsed from the VLM response, before wall-clock conversion.
 */
export interface RawDelta {
  offset: ClipOffset;
  text: string;
}

/**
 * The VLM's full response after parsing. The vlm_parser produces this; the
 * index orchestrator consumes it.
 */
export interface ParsedVlmResponse {
  continuity: VlmContinuity;
  deltas: RawDelta[];
  keyFrames: ClipOffset[];
}

/**
 * One delta after wall-clock conversion. This is what gets written to
 * deltas.txt and shown to the agent.
 */
export interface WallClockDelta {
  /** "HH:MM" wall-clock time. */
  time: string;
  text: string;
}

/**
 * Work item handed from the index module to the content module. The content
 * module is responsible for extracting frames, running OCR, and storing the
 * results. The index module is unaware of any of that — it only knows that
 * "these timestamps in this clip should be captured into this session".
 */
export interface KeyFrameWork {
  /** Absolute path to the source clip. */
  clipPath: string;
  /**
   * Frames to extract. Each entry has both the clip-relative offset (used by
   * ffmpeg -ss) and the wall-clock time (used in the output filename).
   */
  frames: Array<{ offset: ClipOffset; wallClock: string }>;
  /**
   * Absolute path to the session directory where extracted content should be
   * stored (under the session's content/ subdirectory).
   */
  sessionDir: string;
}

/**
 * The contract the index module uses to hand work to the content module. The
 * content module implements this; the index module depends only on the
 * interface so the two modules can be developed and tested independently.
 *
 * Failures inside dispatch must not propagate — the content module logs and
 * skips on its own internal errors. The promise resolves either way.
 */
export interface ContentDispatcher {
  dispatch(work: KeyFrameWork): Promise<void>;
}
