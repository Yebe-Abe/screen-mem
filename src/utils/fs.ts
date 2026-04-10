// Thin filesystem helpers. Wraps node:fs/promises with a few patterns we
// reach for repeatedly. Keeps the rest of the codebase free of try/catch
// boilerplate around ENOENT.

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Create a directory and any missing parents. No-op if it already exists. */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** True if the path exists (any kind), false otherwise. Swallows errors. */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Read a UTF-8 file or return null if it doesn't exist. */
export async function readFileIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Atomic-ish write: write to a temp file in the same directory, then rename.
 * Avoids leaving partial files visible to readers (recorder + processor are
 * separate processes scanning the same filesystem).
 */
export async function writeFileAtomic(
  filePath: string,
  contents: Buffer | string
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, contents);
  await fs.rename(tmp, filePath);
}

/** Append a line to a file, creating it (and parent dirs) if missing. */
export async function appendLine(
  filePath: string,
  line: string
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const text = line.endsWith("\n") ? line : line + "\n";
  await fs.appendFile(filePath, text);
}

/** List file names in a directory, returning [] if the directory is missing. */
export async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
