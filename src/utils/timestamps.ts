// Pure functions for time formatting, filename parsing, and the
// MM:SS → HH:MM conversion that bridges the VLM (clip-relative) and the
// agent-facing index (wall-clock). No I/O. Fully testable.

import type { ClipOffset, StagingItem } from "../types.js";

export function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export function pad3(n: number): string {
  return n.toString().padStart(3, "0");
}

/** Format a Date's wall-clock time as "HH:MM" in local time. */
export function formatHHMM(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Format a Date as "YYYY-MM-DD" in local time. */
export function formatYMD(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Format a clip filename for a given hour/minute: "clip-09-00.mp4". */
export function formatClipFilename(hour: number, minute: number): string {
  return `clip-${pad2(hour)}-${pad2(minute)}.mp4`;
}

/** Format an idle marker filename for a given hour/minute: "idle-09-03". */
export function formatIdleFilename(hour: number, minute: number): string {
  return `idle-${pad2(hour)}-${pad2(minute)}`;
}

/**
 * Parse a staging filename into kind + hour + minute. Returns null if the
 * filename doesn't match the expected format. Tolerates extra files in
 * staging (caller can ignore nulls).
 */
export function parseStagingFilename(
  filename: string
): { kind: "clip" | "idle"; hour: number; minute: number } | null {
  const clip = filename.match(/^clip-(\d{2})-(\d{2})\.mp4$/);
  if (clip) {
    return {
      kind: "clip",
      hour: Number(clip[1]),
      minute: Number(clip[2]),
    };
  }
  const idle = filename.match(/^idle-(\d{2})-(\d{2})$/);
  if (idle) {
    return {
      kind: "idle",
      hour: Number(idle[1]),
      minute: Number(idle[2]),
    };
  }
  return null;
}

/**
 * Comparator for staging items in chronological order (hour, then minute).
 * Note: assumes items are from the same day. The recorder/processor are
 * single-process and reset state at midnight rollover.
 */
export function compareStagingItems(a: StagingItem, b: StagingItem): number {
  if (a.hour !== b.hour) return a.hour - b.hour;
  return a.minute - b.minute;
}

/**
 * Parse "[MM:SS]" from a VLM response into a ClipOffset. Returns null on
 * malformed input — the parser is forgiving so a single bad delta doesn't
 * crash a whole clip's processing.
 */
export function parseClipOffset(token: string): ClipOffset | null {
  const trimmed = token.trim();
  const m = trimmed.match(/^\[?(\d{1,3}):(\d{2})\]?$/);
  if (!m) return null;
  const mm = Number(m[1]);
  const ss = Number(m[2]);
  if (!Number.isFinite(mm) || !Number.isFinite(ss)) return null;
  if (ss >= 60) return null;
  return { mm, ss };
}

/**
 * Convert a clip-relative offset to a wall-clock "HH:MM" string, given the
 * clip's start hour/minute. The conversion is purely arithmetic — no Date
 * objects involved, so it's safe across DST transitions (which we don't
 * care about anyway since we're using local hour/minute fields directly).
 *
 * Wraps at 24:00 → 00:00. A clip that starts at 23:59 with an offset of
 * [02:00] resolves to 00:01 the next day; we don't track date carry-over
 * here because the index module organizes data by the clip's date, not by
 * the delta's date.
 */
export function offsetToWallClock(
  clipStartHour: number,
  clipStartMinute: number,
  offset: ClipOffset
): string {
  const totalMinutes =
    clipStartHour * 60 +
    clipStartMinute +
    offset.mm +
    Math.floor(offset.ss / 60);
  const hour = ((totalMinutes / 60) | 0) % 24;
  const minute = totalMinutes % 60;
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** Format a session number as a zero-padded 3-digit string: "session-001". */
export function formatSessionDirName(sessionNum: number): string {
  return `session-${pad3(sessionNum)}`;
}
