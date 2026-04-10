// backlog_monitor capability — counts unprocessed items in the staging
// directory and signals halt when the count exceeds the configured ceiling.
// This is the recorder's only protection against an unbounded queue when the
// processor is slow or down.

import { listDir } from "../utils/fs.js";
import { parseStagingFilename } from "../utils/timestamps.js";

export interface BacklogMonitor {
  /** Number of clips + idle markers currently waiting in staging. */
  count(): Promise<number>;
  /** True if the count is at or above the ceiling. */
  isOverCeiling(): Promise<boolean>;
}

export function createBacklogMonitor(
  stagingDir: string,
  ceiling: number
): BacklogMonitor {
  async function getCount(): Promise<number> {
    const files = await listDir(stagingDir);
    return files.filter((f) => parseStagingFilename(f) !== null).length;
  }

  return {
    count: getCount,
    async isOverCeiling(): Promise<boolean> {
      return (await getCount()) >= ceiling;
    },
  };
}
