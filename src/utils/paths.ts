// Filesystem path helpers — knows the on-disk layout under ~/context/ and
// the staging directory layout. The path layout is the contract between the
// recorder and the processor, so it lives here once instead of being
// duplicated across modules.

import * as path from "node:path";
import { formatSessionDirName, pad2 } from "./timestamps.js";

/** ~/context/2026/04 */
export function monthDirPath(
  contextDir: string,
  year: number,
  month: number
): string {
  return path.join(contextDir, String(year), pad2(month));
}

/** ~/context/2026/04/09 */
export function dayDirPath(
  contextDir: string,
  year: number,
  month: number,
  day: number
): string {
  return path.join(monthDirPath(contextDir, year, month), pad2(day));
}

/** ~/context/2026/04/09/session-001 */
export function sessionDirPath(
  contextDir: string,
  year: number,
  month: number,
  day: number,
  sessionNum: number
): string {
  return path.join(
    dayDirPath(contextDir, year, month, day),
    formatSessionDirName(sessionNum)
  );
}

/** ~/context/2026/04/09/session-001/content */
export function sessionContentDirPath(sessionDir: string): string {
  return path.join(sessionDir, "content");
}

/** ~/context/2026/04/09/sessions.txt */
export function sessionsFilePath(
  contextDir: string,
  year: number,
  month: number,
  day: number
): string {
  return path.join(dayDirPath(contextDir, year, month, day), "sessions.txt");
}

/** ~/context/2026/04/map.txt */
export function mapFilePath(
  contextDir: string,
  year: number,
  month: number
): string {
  return path.join(monthDirPath(contextDir, year, month), "map.txt");
}

/** ~/context/2026/04/09/session-001/deltas.txt */
export function deltasFilePath(sessionDir: string): string {
  return path.join(sessionDir, "deltas.txt");
}

/** ~/context/2026/04/09/session-001/meta.json */
export function metaFilePath(sessionDir: string): string {
  return path.join(sessionDir, "meta.json");
}

/** ~/context/README.md */
export function contextReadmePath(contextDir: string): string {
  return path.join(contextDir, "README.md");
}
