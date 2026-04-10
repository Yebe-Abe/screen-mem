// Pure parser for the VLM's response format. Owns knowledge of the
// SESSION/DELTAS/KEY_FRAMES layout from the validated prompt. No I/O, no
// dependencies — fully unit-testable.
//
// The parser is forgiving: it tolerates extra whitespace, missing key frames
// (returns []), and a missing or unexpected SESSION value (returns "new" as
// the safest fallback so processing continues). Bad deltas are skipped
// individually rather than failing the whole parse.

import type {
  ClipOffset,
  ParsedVlmResponse,
  RawDelta,
  VlmContinuity,
} from "../types.js";
import { parseClipOffset } from "../utils/timestamps.js";

const SECTION_RE = /^(SESSION|DELTAS|KEY_FRAMES)\s*:\s*(.*)$/i;

type Section = "session" | "deltas" | "key_frames";

export function parseVlmResponse(raw: string): ParsedVlmResponse {
  const result: ParsedVlmResponse = {
    continuity: "new",
    deltas: [],
    keyFrames: [],
  };

  let section: Section | null = null;
  // Buffer the inline value of KEY_FRAMES (which is on the same line as the
  // header in the validated format).
  let keyFramesInline: string | null = null;

  const lines = raw.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const sectionMatch = line.match(SECTION_RE);
    if (sectionMatch) {
      const header = sectionMatch[1]!.toUpperCase();
      const inline = sectionMatch[2] ?? "";
      switch (header) {
        case "SESSION":
          section = "session";
          result.continuity = parseContinuity(inline) ?? "new";
          break;
        case "DELTAS":
          section = "deltas";
          // The DELTAS header is followed by per-line deltas; nothing inline.
          break;
        case "KEY_FRAMES":
          section = "key_frames";
          keyFramesInline = inline;
          break;
      }
      continue;
    }

    // Body lines belong to the current section
    if (section === "deltas") {
      const delta = parseDeltaLine(line);
      if (delta) result.deltas.push(delta);
    }
    // KEY_FRAMES is always inline in the validated prompt; we don't expect
    // body lines, but we accept them as a fallback.
    if (section === "key_frames" && keyFramesInline === null) {
      keyFramesInline = line;
    }
  }

  if (keyFramesInline !== null) {
    result.keyFrames = parseKeyFrames(keyFramesInline);
  }

  return result;
}

function parseContinuity(value: string): VlmContinuity | null {
  const v = value.trim().toLowerCase().replace(/[.,;].*$/, "");
  if (v === "same" || v === "different" || v === "new") return v;
  // Tolerate values like "same | different | new" if the model echoes the
  // template — pick the first matching token.
  const tokens = v.split(/[\s|]+/).filter(Boolean);
  for (const t of tokens) {
    if (t === "same" || t === "different" || t === "new") return t;
  }
  return null;
}

const DELTA_LINE_RE = /^\[(\d{1,3}):(\d{2})\]\s+(.+)$/;

function parseDeltaLine(line: string): RawDelta | null {
  const m = line.match(DELTA_LINE_RE);
  if (!m) return null;
  const offset = parseClipOffset(`[${m[1]}:${m[2]}]`);
  if (!offset) return null;
  const text = m[3]!.trim();
  if (!text) return null;
  return { offset, text };
}

function parseKeyFrames(value: string): ClipOffset[] {
  const v = value.trim().toLowerCase();
  if (!v || v === "none" || v === "(none)") return [];
  const tokens = value.split(/[,\s]+/).filter(Boolean);
  const offsets: ClipOffset[] = [];
  for (const t of tokens) {
    if (t.toLowerCase() === "none") continue;
    const o = parseClipOffset(t);
    if (o) offsets.push(o);
    if (offsets.length === 3) break; // VLM contract: 0-3 key frames
  }
  return offsets;
}
