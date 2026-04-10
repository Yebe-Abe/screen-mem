import { beforeEach, describe, expect, test } from "vitest";
import { Session, type SessionDate } from "./session.js";
import type { WallClockDelta } from "../types.js";

const DATE: SessionDate = { year: 2026, month: 4, day: 9 };

function delta(time: string, text: string): WallClockDelta {
  return { time, text };
}

describe("Session — construction", () => {
  test("rejects empty working description", () => {
    expect(
      () => new Session(1, DATE, 9, 0, "", [delta("09:00", "x")])
    ).toThrow(/workingDescription/);
  });

  test("rejects non-positive id", () => {
    expect(
      () => new Session(0, DATE, 9, 0, "x", [delta("09:00", "x")])
    ).toThrow(/positive/);
  });

  test("starts open with the initial deltas", () => {
    const s = new Session(1, DATE, 9, 0, "reading auth.py", [
      delta("09:00", "opened auth.py"),
    ]);
    expect(s.closed).toBe(false);
    expect(s.deltas).toHaveLength(1);
    expect(s.idleCounter).toBe(0);
    expect(s.workingDescription).toBe("reading auth.py");
    expect(s.startHHMM()).toBe("09:00");
  });
});

describe("Session — appending deltas", () => {
  let s: Session;
  beforeEach(() => {
    s = new Session(1, DATE, 9, 0, "x", [delta("09:00", "first")]);
  });

  test("appendDeltas adds and is observable in lastDeltas", () => {
    s.appendDeltas([delta("09:01", "second"), delta("09:02", "third")]);
    expect(s.deltas).toHaveLength(3);
    expect(s.lastDeltas(2).map((d) => d.text)).toEqual(["second", "third"]);
  });

  test("appendDeltas resets idle counter", () => {
    s.markIdle(9, 5);
    s.markIdle(9, 6);
    expect(s.idleCounter).toBe(2);
    s.appendDeltas([delta("09:07", "back to work")]);
    expect(s.idleCounter).toBe(0);
  });

  test("lastDeltas returns at most N", () => {
    s.appendDeltas([
      delta("09:01", "a"),
      delta("09:02", "b"),
      delta("09:03", "c"),
      delta("09:04", "d"),
    ]);
    expect(s.lastDeltas(3).map((d) => d.text)).toEqual(["b", "c", "d"]);
    expect(s.lastDeltas(10)).toHaveLength(5);
  });
});

describe("Session — idle counting", () => {
  let s: Session;
  beforeEach(() => {
    s = new Session(1, DATE, 9, 0, "x", [delta("09:00", "first")]);
  });

  test("first idle in a run produces an idle delta", () => {
    const result = s.markIdle(9, 5);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("idle");
    expect(result?.time).toBe("09:05");
    expect(s.idleCounter).toBe(1);
    expect(s.deltas[s.deltas.length - 1]?.text).toBe("idle");
  });

  test("subsequent idles return null and just bump the counter", () => {
    s.markIdle(9, 5);
    expect(s.markIdle(9, 6)).toBeNull();
    expect(s.markIdle(9, 7)).toBeNull();
    expect(s.idleCounter).toBe(3);
    // Only one idle delta added, not three
    expect(s.deltas.filter((d) => d.text === "idle")).toHaveLength(1);
  });

  test("shouldCloseForIdle triggers at the threshold", () => {
    expect(s.shouldCloseForIdle(5)).toBe(false);
    s.markIdle(9, 5);
    s.markIdle(9, 6);
    s.markIdle(9, 7);
    s.markIdle(9, 8);
    expect(s.shouldCloseForIdle(5)).toBe(false);
    s.markIdle(9, 9);
    expect(s.shouldCloseForIdle(5)).toBe(true);
  });
});

describe("Session — close", () => {
  let s: Session;
  beforeEach(() => {
    s = new Session(1, DATE, 9, 0, "x", [delta("09:00", "first")]);
  });

  test("close marks session closed and records final description", () => {
    s.close("[09:00–09:15] worked on stuff", 9, 15);
    expect(s.closed).toBe(true);
    expect(s.finalDescription).toBe("[09:00–09:15] worked on stuff");
    expect(s.endHHMM()).toBe("09:15");
  });

  test("rejects empty final description", () => {
    expect(() => s.close("", 9, 15)).toThrow();
  });

  test("subsequent mutations throw", () => {
    s.close("done", 9, 15);
    expect(() => s.appendDeltas([delta("09:16", "x")])).toThrow(/closed/);
    expect(() => s.markIdle(9, 16)).toThrow(/closed/);
    expect(() => s.close("done again", 9, 17)).toThrow(/closed/);
  });

  test("toMeta reflects state", () => {
    s.appendDeltas([delta("09:01", "a")]);
    s.close("done", 9, 5);
    const meta = s.toMeta();
    expect(meta.id).toBe(1);
    expect(meta.closed).toBe(true);
    expect(meta.deltaCount).toBe(2);
    expect(meta.endHour).toBe(9);
    expect(meta.endMinute).toBe(5);
  });
});
