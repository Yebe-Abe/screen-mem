// session_writer capability — file I/O for the index module's outputs.
//
// Owns the on-disk format of:
//   - deltas.txt (one delta per line, appended)
//   - meta.json (session metadata, full overwrite)
//   - sessions.txt (one session line per day, appended on close)
//   - map.txt (per-month index, regenerated on each session close)
//
// The map.txt format is the only one with non-trivial structure: it has a
// section of one-line-per-day summaries followed by a "--- today: YYYY-MM-DD ---"
// marker and the full session lines for today. We parse it on read so we can
// preserve historical day summaries while updating today's.

import {
  appendLine,
  ensureDir,
  readFileIfExists,
  writeFileAtomic,
} from "../utils/fs.js";
import {
  dayDirPath,
  deltasFilePath,
  mapFilePath,
  metaFilePath,
  sessionContentDirPath,
  sessionDirPath,
  sessionsFilePath,
} from "../utils/paths.js";
import { listDir } from "../utils/fs.js";
import { pad2 } from "../utils/timestamps.js";
import type { WallClockDelta } from "../types.js";
import type { Session, SessionDate, SessionMeta } from "./session.js";

export interface SessionWriter {
  /** Create the session directory + content/ subdirectory. Returns its path. */
  ensureSessionDir(contextDir: string, session: Session): Promise<string>;
  /** Append one delta line to deltas.txt. */
  appendDelta(sessionDir: string, delta: WallClockDelta): Promise<void>;
  /** Write meta.json (full overwrite, atomic). */
  writeMeta(sessionDir: string, meta: SessionMeta): Promise<void>;
  /** Append a single session description line to today's sessions.txt. */
  appendSessionLine(
    contextDir: string,
    date: SessionDate,
    line: string
  ): Promise<void>;
  /** Read all session description lines for a day. Empty array if none. */
  readSessionLines(
    contextDir: string,
    date: SessionDate
  ): Promise<string[]>;
  /**
   * Regenerate map.txt for the given month, replacing today's day-summary
   * line and today's session block. Preserves all historical day summaries.
   */
  updateMonthMap(
    contextDir: string,
    date: SessionDate,
    todayDaySummary: string
  ): Promise<void>;
  /**
   * Scan today's directory for existing session-XXX folders and return the
   * next available session id (max + 1, or 1 if none exist).
   */
  findNextSessionId(contextDir: string, date: SessionDate): Promise<number>;
}

export function createSessionWriter(): SessionWriter {
  return {
    async ensureSessionDir(contextDir, session): Promise<string> {
      const dir = sessionDirPath(
        contextDir,
        session.date.year,
        session.date.month,
        session.date.day,
        session.id
      );
      await ensureDir(dir);
      await ensureDir(sessionContentDirPath(dir));
      return dir;
    },

    async appendDelta(sessionDir, delta): Promise<void> {
      const line = `[${delta.time}] ${delta.text}`;
      await appendLine(deltasFilePath(sessionDir), line);
    },

    async writeMeta(sessionDir, meta): Promise<void> {
      await writeFileAtomic(metaFilePath(sessionDir), JSON.stringify(meta, null, 2));
    },

    async appendSessionLine(contextDir, date, line): Promise<void> {
      const filepath = sessionsFilePath(
        contextDir,
        date.year,
        date.month,
        date.day
      );
      await appendLine(filepath, line);
    },

    async readSessionLines(contextDir, date): Promise<string[]> {
      const filepath = sessionsFilePath(
        contextDir,
        date.year,
        date.month,
        date.day
      );
      const text = await readFileIfExists(filepath);
      if (!text) return [];
      return text.split("\n").filter((l) => l.trim().length > 0);
    },

    async updateMonthMap(contextDir, date, todayDaySummary): Promise<void> {
      const mapPath = mapFilePath(contextDir, date.year, date.month);
      const existing = await readFileIfExists(mapPath);
      const { daySummaries } = parseMap(existing ?? "");

      const todayKey = formatYMD(date);
      // Use the LLM-produced line as-is. The prompt instructs the LLM to
      // start with "YYYY-MM-DD: ..." so we don't enforce that here.
      daySummaries.set(todayKey, todayDaySummary);

      // Read today's full sessions to embed in the today section
      const todaySessions = await this.readSessionLines(contextDir, date);

      // Build the new map: day summaries (descending date order), blank line,
      // today marker, today's session lines.
      const sortedDays = Array.from(daySummaries.entries()).sort((a, b) =>
        b[0].localeCompare(a[0])
      );
      const out: string[] = [];
      for (const [, line] of sortedDays) out.push(line);
      out.push("");
      out.push(`--- today: ${todayKey} ---`);
      for (const sess of todaySessions) out.push(sess);

      await writeFileAtomic(mapPath, out.join("\n") + "\n");
    },

    async findNextSessionId(contextDir, date): Promise<number> {
      const dayDir = dayDirPath(
        contextDir,
        date.year,
        date.month,
        date.day
      );
      const entries = await listDir(dayDir);
      let max = 0;
      for (const name of entries) {
        const m = name.match(/^session-(\d{3})$/);
        if (m) {
          const n = Number(m[1]);
          if (n > max) max = n;
        }
      }
      return max + 1;
    },
  };
}

interface ParsedMap {
  daySummaries: Map<string, string>;
}

/** Parse map.txt into day-summary lines, ignoring the today section. */
function parseMap(text: string): ParsedMap {
  const daySummaries = new Map<string, string>();
  let inTodaySection = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed) continue;

    const todayMatch = trimmed.match(
      /^---\s*today:\s*(\d{4}-\d{2}-\d{2})\s*---$/
    );
    if (todayMatch) {
      inTodaySection = true;
      continue;
    }

    if (inTodaySection) continue;

    const dayMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2}):/);
    if (dayMatch) {
      daySummaries.set(dayMatch[1]!, trimmed);
    }
  }

  return { daySummaries };
}

function formatYMD(date: SessionDate): string {
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
}
