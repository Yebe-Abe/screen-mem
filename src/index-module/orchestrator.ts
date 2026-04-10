// Index module orchestrator. Polls the staging directory, processes clips
// and idle markers in chronological order, manages the active session, and
// drives all of the index module's effects (VLM call, text LLM call, file
// writes, content dispatch).
//
// The orchestrator is the only place that knows the *sequencing* of those
// effects. Each capability does one thing; the orchestrator wires them
// together. This file is therefore where almost all of the index module's
// "interesting" code lives — everything else is plumbing.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config } from "../config.js";
import { createLogger } from "../logging.js";
import type {
  ContentDispatcher,
  KeyFrameWork,
  StagingItem,
  WallClockDelta,
} from "../types.js";
import { listDir } from "../utils/fs.js";
import {
  compareStagingItems,
  offsetToWallClock,
  pad2,
  parseStagingFilename,
} from "../utils/timestamps.js";
import { Session, type SessionDate } from "./session.js";
import { createSessionWriter, type SessionWriter } from "./session-writer.js";
import { createTextLlmClient, type TextLlmClient } from "./text-llm-client.js";
import { createVlmClient, type VlmClient } from "./vlm-client.js";
import { parseVlmResponse } from "./vlm-parser.js";

const log = createLogger("index");

const MAX_RETRIES_PER_CLIP = 3;

export interface IndexOrchestratorDeps {
  vlmClient?: VlmClient;
  textLlmClient?: TextLlmClient;
  sessionWriter?: SessionWriter;
  contentDispatcher: ContentDispatcher;
}

export interface IndexOrchestrator {
  start(): Promise<void>;
  stop(): void;
  /** Run a single poll cycle synchronously. Useful for tests + clean shutdown. */
  drainOnce(): Promise<void>;
}

export function createIndexOrchestrator(
  config: Config,
  deps: IndexOrchestratorDeps
): IndexOrchestrator {
  const vlm = deps.vlmClient ?? createVlmClient(config);
  const text = deps.textLlmClient ?? createTextLlmClient(config);
  const writer = deps.sessionWriter ?? createSessionWriter();
  const dispatcher = deps.contentDispatcher;

  let activeSession: Session | null = null;
  let activeSessionDir: string | null = null;
  let nextSessionId: number | null = null;
  let currentDate: SessionDate | null = null;

  const retryCounts = new Map<string, number>();
  let running = false;

  function todayDate(): SessionDate {
    const now = new Date();
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
    };
  }

  function sameDate(a: SessionDate, b: SessionDate): boolean {
    return a.year === b.year && a.month === b.month && a.day === b.day;
  }

  async function refreshDate(): Promise<void> {
    const today = todayDate();
    if (currentDate && sameDate(currentDate, today)) return;
    // Day rolled over while we were running. Close any active session and
    // reset the per-day counter.
    if (activeSession) {
      log.info("day rolled over, closing active session", { id: activeSession.id });
      await closeActiveSession();
    }
    currentDate = today;
    nextSessionId = await writer.findNextSessionId(config.contextDir, today);
    log.info("date refreshed", { date: today, nextSessionId });
  }

  async function closeActiveSession(): Promise<void> {
    if (!activeSession || !activeSessionDir) return;
    const session = activeSession;
    const sessionDir = activeSessionDir;

    // Determine end time: the time of the latest delta of any kind. If there
    // are no deltas (shouldn't happen — we never create a session without
    // initial deltas), fall back to start time.
    const lastDelta = session.deltas[session.deltas.length - 1];
    const [endHourStr, endMinStr] = (lastDelta?.time ?? session.startHHMM()).split(":");
    const endHour = Number(endHourStr);
    const endMinute = Number(endMinStr);

    let finalDescription: string;
    try {
      finalDescription = await text.summarizeSession(
        session.startHHMM(),
        `${pad2(endHour)}:${pad2(endMinute)}`,
        session.deltas
      );
    } catch (err) {
      log.error("session summary failed, using fallback", {
        id: session.id,
        error: (err as Error).message,
      });
      finalDescription = `[${session.startHHMM()}–${pad2(endHour)}:${pad2(endMinute)}] ${session.workingDescription}`;
    }

    // Strip a leading "[start-end] " bracket if the LLM included it — we want
    // to control the bracket format ourselves.
    const cleaned = stripLeadingBracket(finalDescription);

    session.close(cleaned, endHour, endMinute);
    await writer.writeMeta(sessionDir, session.toMeta());

    const sessionLine = `[${session.startHHMM()}–${session.endHHMM()}] ${cleaned}`;
    await writer.appendSessionLine(config.contextDir, session.date, sessionLine);

    // Day summary regeneration — the spec calls for this every time a session
    // closes so the map stays current.
    try {
      const sessionLines = await writer.readSessionLines(config.contextDir, session.date);
      const ymd = `${session.date.year}-${pad2(session.date.month)}-${pad2(session.date.day)}`;
      const daySummary = await text.summarizeDay(ymd, sessionLines);
      await writer.updateMonthMap(config.contextDir, session.date, daySummary);
    } catch (err) {
      log.error("day summary / map update failed", {
        id: session.id,
        error: (err as Error).message,
      });
    }

    log.info("session closed", {
      id: session.id,
      window: `${session.startHHMM()}-${session.endHHMM()}`,
      deltaCount: session.deltas.length,
    });

    activeSession = null;
    activeSessionDir = null;
  }

  async function processClip(item: StagingItem): Promise<void> {
    if (!currentDate || nextSessionId === null) {
      throw new Error("orchestrator state not initialized");
    }

    const workingDescription = activeSession?.workingDescription ?? null;
    const lastDeltas = activeSession?.lastDeltas() ?? [];

    const raw = await vlm.call(item.path, workingDescription, lastDeltas);
    const parsed = parseVlmResponse(raw);

    const wallClockDeltas: WallClockDelta[] = parsed.deltas.map((d) => ({
      time: offsetToWallClock(item.hour, item.minute, d.offset),
      text: d.text,
    }));

    // Continuity handling
    let effectiveContinuity = parsed.continuity;
    if (effectiveContinuity === "different") {
      if (activeSession) {
        await closeActiveSession();
      }
      effectiveContinuity = "new";
    }

    if (activeSession === null) {
      effectiveContinuity = "new";
    }

    if (effectiveContinuity === "new") {
      if (wallClockDeltas.length === 0) {
        log.warn("VLM returned no deltas for new session — skipping clip", {
          clipPath: item.path,
        });
        return;
      }
      const firstDelta = wallClockDeltas[0]!;
      const session = new Session(
        nextSessionId,
        currentDate,
        item.hour,
        item.minute,
        firstDelta.text,
        []
      );
      const sessionDir = await writer.ensureSessionDir(config.contextDir, session);
      session.appendDeltas(wallClockDeltas);
      for (const d of wallClockDeltas) {
        await writer.appendDelta(sessionDir, d);
      }
      await writer.writeMeta(sessionDir, session.toMeta());
      activeSession = session;
      activeSessionDir = sessionDir;
      nextSessionId += 1;
      log.info("new session opened", {
        id: session.id,
        startHHMM: session.startHHMM(),
        deltaCount: wallClockDeltas.length,
      });
    } else {
      // 'same' — append
      if (!activeSession || !activeSessionDir) {
        throw new Error("invariant violated: same continuity without active session");
      }
      activeSession.appendDeltas(wallClockDeltas);
      for (const d of wallClockDeltas) {
        await writer.appendDelta(activeSessionDir, d);
      }
      await writer.writeMeta(activeSessionDir, activeSession.toMeta());
      log.debug("session extended", {
        id: activeSession.id,
        added: wallClockDeltas.length,
      });
    }

    // Dispatch key frames if any
    if (parsed.keyFrames.length > 0 && activeSessionDir) {
      const work: KeyFrameWork = {
        clipPath: item.path,
        sessionDir: activeSessionDir,
        frames: parsed.keyFrames.map((offset) => ({
          offset,
          wallClock: offsetToWallClock(item.hour, item.minute, offset),
        })),
      };
      try {
        await dispatcher.dispatch(work);
      } catch (err) {
        // ContentDispatcher contract says it shouldn't throw, but defend
        // against bugs in the content module.
        log.warn("content dispatch threw — index unaffected", {
          error: (err as Error).message,
        });
      }
    }
  }

  async function processIdle(item: StagingItem): Promise<void> {
    if (!activeSession || !activeSessionDir) {
      // No active session to mark idle. Just discard the marker.
      return;
    }
    const delta = activeSession.markIdle(item.hour, item.minute);
    if (delta) {
      await writer.appendDelta(activeSessionDir, delta);
    }
    if (activeSession.shouldCloseForIdle(config.idleTimeoutClips)) {
      log.info("idle timeout reached, closing session", { id: activeSession.id });
      await closeActiveSession();
    }
  }

  async function processItem(item: StagingItem): Promise<void> {
    if (item.kind === "clip") {
      await processClip(item);
    } else {
      await processIdle(item);
    }
  }

  async function listStagingItems(): Promise<StagingItem[]> {
    const filenames = await listDir(config.stagingDir);
    const items: StagingItem[] = [];
    for (const filename of filenames) {
      const parsed = parseStagingFilename(filename);
      if (!parsed) continue;
      items.push({
        kind: parsed.kind,
        path: path.join(config.stagingDir, filename),
        filename,
        hour: parsed.hour,
        minute: parsed.minute,
      });
    }
    items.sort(compareStagingItems);
    return items;
  }

  async function deleteStagingItem(item: StagingItem): Promise<void> {
    try {
      await fs.unlink(item.path);
    } catch (err) {
      log.warn("failed to delete staging item", {
        path: item.path,
        error: (err as Error).message,
      });
    }
  }

  async function pollOnce(): Promise<void> {
    await refreshDate();
    const items = await listStagingItems();
    for (const item of items) {
      try {
        await processItem(item);
        await deleteStagingItem(item);
        retryCounts.delete(item.filename);
      } catch (err) {
        const count = (retryCounts.get(item.filename) ?? 0) + 1;
        retryCounts.set(item.filename, count);
        log.warn("processing failed", {
          filename: item.filename,
          attempt: count,
          error: (err as Error).message,
        });
        if (count >= MAX_RETRIES_PER_CLIP) {
          log.error("giving up on item after max retries", {
            filename: item.filename,
          });
          await deleteStagingItem(item);
          retryCounts.delete(item.filename);
        } else {
          // Stop processing this poll cycle so we don't spin on a broken item
          // — the next poll will retry from the same point.
          return;
        }
      }
    }
  }

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      log.info("index orchestrator started", {
        contextDir: config.contextDir,
        stagingDir: config.stagingDir,
        pollIntervalMs: config.pollIntervalMs,
      });
      while (running) {
        try {
          await pollOnce();
        } catch (err) {
          log.error("poll cycle failed", { error: (err as Error).message });
        }
        if (!running) break;
        await sleep(config.pollIntervalMs);
      }
      // Final drain attempt before exit
      try {
        await pollOnce();
      } catch {
        /* best effort */
      }
      // Close any still-open session on shutdown
      if (activeSession) {
        await closeActiveSession().catch((err) => {
          log.error("failed to close active session on shutdown", {
            error: (err as Error).message,
          });
        });
      }
      log.info("index orchestrator stopped");
    },

    stop(): void {
      running = false;
    },

    drainOnce: pollOnce,
  };
}

function stripLeadingBracket(s: string): string {
  // The session-close prompt instructs the LLM to use "[start–end] description"
  // format. We strip that bracket if present so we can rebuild it consistently
  // from session.startHHMM() / session.endHHMM().
  const m = s.match(/^\[\d{1,2}:\d{2}[–\-]\d{1,2}:\d{2}\]\s*(.+)$/);
  return m ? m[1]!.trim() : s.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
