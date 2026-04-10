// Integration test for the index orchestrator. Exercises the full pipeline
// (poll → VLM → parse → session → write → dispatch → close → text LLM →
// map update) using mock clients and a temp directory. The point is to
// catch wiring bugs that the per-capability unit tests can't see.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../config.js";
import type { ContentDispatcher, KeyFrameWork, WallClockDelta } from "../types.js";
import { pad2 } from "../utils/timestamps.js";
import { createIndexOrchestrator } from "./orchestrator.js";
import type { TextLlmClient } from "./text-llm-client.js";
import type { VlmClient } from "./vlm-client.js";

interface VlmCall {
  clipPath: string;
  workingDescription: string | null;
  lastDeltas: WallClockDelta[];
}

interface TextCall {
  kind: "session" | "day";
  arg: unknown;
}

let tmpDir: string;
let config: Config;
let vlmCalls: VlmCall[];
let textCalls: TextCall[];
let dispatchCalls: KeyFrameWork[];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "screen-memory-it-"));
  config = {
    contextDir: path.join(tmpDir, "context"),
    stagingDir: path.join(tmpDir, "staging"),
    logDir: path.join(tmpDir, "logs"),
    clipDurationSec: 60,
    pollIntervalMs: 100,
    idleTimeoutClips: 5,
    backlogCeiling: 60,
    platform: "linux",
    captureInput: "",
    fireworksApiKey: "test",
    fireworksBaseUrl: "https://test.invalid",
    fireworksVlmModel: "test-vlm",
    fireworksTextModel: "test-text",
  };
  await fs.mkdir(config.stagingDir, { recursive: true });
  await fs.mkdir(config.contextDir, { recursive: true });
  vlmCalls = [];
  textCalls = [];
  dispatchCalls = [];
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function mockVlm(responses: string[]): VlmClient {
  let idx = 0;
  return {
    async call(clipPath, workingDescription, lastDeltas) {
      vlmCalls.push({
        clipPath,
        workingDescription,
        lastDeltas: [...lastDeltas],
      });
      const r = responses[idx] ?? responses[responses.length - 1]!;
      idx++;
      return r;
    },
  };
}

function mockText(): TextLlmClient {
  return {
    async summarizeSession(start, end, deltas) {
      textCalls.push({
        kind: "session",
        arg: { start, end, count: deltas.length },
      });
      return `[${start}–${end}] mock summary of ${deltas.length} deltas`;
    },
    async summarizeDay(ymd, lines) {
      textCalls.push({ kind: "day", arg: { ymd, count: lines.length } });
      return `${ymd}: mock day summary [${lines.length} sessions]`;
    },
  };
}

function mockDispatcher(): ContentDispatcher {
  return {
    async dispatch(work) {
      dispatchCalls.push(work);
    },
  };
}

function todayPaths(config: Config): {
  dayDir: string;
  sessionDir: (n: number) => string;
  ymd: string;
} {
  const now = new Date();
  const y = now.getFullYear();
  const m = pad2(now.getMonth() + 1);
  const d = pad2(now.getDate());
  const dayDir = path.join(config.contextDir, String(y), m, d);
  return {
    dayDir,
    sessionDir: (n: number) =>
      path.join(dayDir, `session-${n.toString().padStart(3, "0")}`),
    ymd: `${y}-${m}-${d}`,
  };
}

async function writeFakeClip(name: string): Promise<void> {
  await fs.writeFile(path.join(config.stagingDir, name), "fake-mp4-bytes");
}

async function writeIdleMarker(name: string): Promise<void> {
  await fs.writeFile(path.join(config.stagingDir, name), "");
}

describe("index orchestrator — single clip → new session", () => {
  test("creates session, writes deltas, dispatches frames, deletes clip", async () => {
    await writeFakeClip("clip-09-00.mp4");

    const orch = createIndexOrchestrator(config, {
      vlmClient: mockVlm([
        `SESSION: new
DELTAS:
[00:05] opened auth.py and started reading
[00:30] scrolled to validate_api_key function
KEY_FRAMES: 00:05`,
      ]),
      textLlmClient: mockText(),
      contentDispatcher: mockDispatcher(),
    });

    await orch.drainOnce();

    expect(vlmCalls).toHaveLength(1);
    expect(vlmCalls[0]?.workingDescription).toBeNull();

    const { sessionDir } = todayPaths(config);
    const dir = sessionDir(1);
    await expect(fs.stat(dir)).resolves.toBeDefined();

    const deltas = await fs.readFile(path.join(dir, "deltas.txt"), "utf8");
    expect(deltas).toContain("[09:00] opened auth.py and started reading");
    expect(deltas).toContain("[09:00] scrolled to validate_api_key function");

    const meta = JSON.parse(
      await fs.readFile(path.join(dir, "meta.json"), "utf8")
    ) as { id: number; closed: boolean; deltaCount: number };
    expect(meta.id).toBe(1);
    expect(meta.closed).toBe(false);
    expect(meta.deltaCount).toBe(2);

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]?.frames).toHaveLength(1);
    expect(dispatchCalls[0]?.frames[0]?.wallClock).toBe("09:00");

    // Clip removed from staging
    const remaining = await fs.readdir(config.stagingDir);
    expect(remaining).not.toContain("clip-09-00.mp4");
  });
});

describe("index orchestrator — different continuity closes + opens", () => {
  test("closes session-001, opens session-002, writes sessions.txt + map.txt", async () => {
    await writeFakeClip("clip-09-00.mp4");
    await writeFakeClip("clip-09-01.mp4");

    const orch = createIndexOrchestrator(config, {
      vlmClient: mockVlm([
        `SESSION: new
DELTAS:
[00:01] coding in VS Code on auth refactor
KEY_FRAMES: none`,
        `SESSION: different
DELTAS:
[00:01] opened Gmail to read Caleb's message
KEY_FRAMES: none`,
      ]),
      textLlmClient: mockText(),
      contentDispatcher: mockDispatcher(),
    });

    await orch.drainOnce();

    const { dayDir, sessionDir } = todayPaths(config);
    const dayContents = await fs.readdir(dayDir);
    expect(dayContents).toContain("session-001");
    expect(dayContents).toContain("session-002");
    expect(dayContents).toContain("sessions.txt");

    const sessionsTxt = await fs.readFile(
      path.join(dayDir, "sessions.txt"),
      "utf8"
    );
    expect(sessionsTxt).toMatch(/^\[09:00–09:00\] /);
    expect(sessionsTxt).toContain("mock summary of 1 deltas");

    // session-001 should be closed in its meta
    const meta1 = JSON.parse(
      await fs.readFile(path.join(sessionDir(1), "meta.json"), "utf8")
    ) as { closed: boolean };
    expect(meta1.closed).toBe(true);

    // session-002 should be open
    const meta2 = JSON.parse(
      await fs.readFile(path.join(sessionDir(2), "meta.json"), "utf8")
    ) as { closed: boolean };
    expect(meta2.closed).toBe(false);

    // map.txt should exist with today's day-summary line
    const monthDir = path.dirname(dayDir);
    const mapTxt = await fs.readFile(path.join(monthDir, "map.txt"), "utf8");
    const { ymd } = todayPaths(config);
    expect(mapTxt).toContain(`${ymd}:`);
    expect(mapTxt).toContain("--- today:");

    // text LLM called: 1 session-close + 1 day-summary
    expect(textCalls.filter((c) => c.kind === "session")).toHaveLength(1);
    expect(textCalls.filter((c) => c.kind === "day")).toHaveLength(1);
  });
});

describe("index orchestrator — idle timeout", () => {
  test("5 consecutive idle markers close the session", async () => {
    await writeFakeClip("clip-09-00.mp4");
    for (let m = 1; m <= 5; m++) {
      await writeIdleMarker(`idle-09-${pad2(m)}`);
    }

    const orch = createIndexOrchestrator(config, {
      vlmClient: mockVlm([
        `SESSION: new
DELTAS:
[00:01] working in editor
KEY_FRAMES: none`,
      ]),
      textLlmClient: mockText(),
      contentDispatcher: mockDispatcher(),
    });

    await orch.drainOnce();

    expect(textCalls.filter((c) => c.kind === "session")).toHaveLength(1);

    const { sessionDir } = todayPaths(config);
    const meta = JSON.parse(
      await fs.readFile(path.join(sessionDir(1), "meta.json"), "utf8")
    ) as { closed: boolean; deltaCount: number };
    expect(meta.closed).toBe(true);
    // 1 initial delta + 1 idle delta (only the first idle in a run)
    expect(meta.deltaCount).toBe(2);

    // All staging items consumed
    expect(await fs.readdir(config.stagingDir)).toHaveLength(0);
  });

  test("idle counter resets when activity resumes", async () => {
    await writeFakeClip("clip-09-00.mp4");
    await writeIdleMarker("idle-09-01");
    await writeIdleMarker("idle-09-02");
    await writeFakeClip("clip-09-03.mp4");
    await writeIdleMarker("idle-09-04");
    await writeIdleMarker("idle-09-05");
    await writeIdleMarker("idle-09-06");
    await writeIdleMarker("idle-09-07");

    const orch = createIndexOrchestrator(config, {
      vlmClient: mockVlm([
        `SESSION: new
DELTAS:
[00:01] working
KEY_FRAMES: none`,
        `SESSION: same
DELTAS:
[00:01] still working
KEY_FRAMES: none`,
      ]),
      textLlmClient: mockText(),
      contentDispatcher: mockDispatcher(),
    });

    await orch.drainOnce();

    // Session should still be open (only 4 idles after the second clip)
    expect(textCalls.filter((c) => c.kind === "session")).toHaveLength(0);

    const { sessionDir } = todayPaths(config);
    const meta = JSON.parse(
      await fs.readFile(path.join(sessionDir(1), "meta.json"), "utf8")
    ) as { closed: boolean };
    expect(meta.closed).toBe(false);
  });
});

describe("index orchestrator — VLM context", () => {
  test("second 'same' clip receives the working description and last deltas", async () => {
    await writeFakeClip("clip-09-00.mp4");
    await writeFakeClip("clip-09-01.mp4");

    const orch = createIndexOrchestrator(config, {
      vlmClient: mockVlm([
        `SESSION: new
DELTAS:
[00:05] opened auth.py
[00:20] reading validate_api_key
KEY_FRAMES: none`,
        `SESSION: same
DELTAS:
[00:10] replaced validate_api_key with oauth_token_exchange
KEY_FRAMES: none`,
      ]),
      textLlmClient: mockText(),
      contentDispatcher: mockDispatcher(),
    });

    await orch.drainOnce();

    expect(vlmCalls).toHaveLength(2);
    expect(vlmCalls[0]?.workingDescription).toBeNull();
    expect(vlmCalls[0]?.lastDeltas).toEqual([]);
    // Second call should see the working description and last deltas
    expect(vlmCalls[1]?.workingDescription).toBe("opened auth.py");
    expect(vlmCalls[1]?.lastDeltas.map((d) => d.text)).toEqual([
      "opened auth.py",
      "reading validate_api_key",
    ]);
  });
});
