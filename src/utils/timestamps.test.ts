import { describe, expect, test } from "vitest";
import {
  compareStagingItems,
  formatClipFilename,
  formatHHMM,
  formatIdleFilename,
  formatYMD,
  offsetToWallClock,
  pad2,
  pad3,
  parseClipOffset,
  parseStagingFilename,
} from "./timestamps.js";
import type { StagingItem } from "../types.js";

describe("padding", () => {
  test("pad2 zero-pads to two digits", () => {
    expect(pad2(0)).toBe("00");
    expect(pad2(5)).toBe("05");
    expect(pad2(9)).toBe("09");
    expect(pad2(10)).toBe("10");
    expect(pad2(99)).toBe("99");
  });

  test("pad3 zero-pads to three digits", () => {
    expect(pad3(1)).toBe("001");
    expect(pad3(42)).toBe("042");
    expect(pad3(999)).toBe("999");
  });
});

describe("formatHHMM / formatYMD", () => {
  test("formats local hour and minute", () => {
    const d = new Date();
    d.setHours(9, 5);
    expect(formatHHMM(d)).toBe("09:05");
  });

  test("formats local Y-M-D", () => {
    const d = new Date(2026, 3, 9); // April 9, 2026 (months are 0-indexed in Date)
    expect(formatYMD(d)).toBe("2026-04-09");
  });
});

describe("staging filename format", () => {
  test("formatClipFilename", () => {
    expect(formatClipFilename(9, 0)).toBe("clip-09-00.mp4");
    expect(formatClipFilename(23, 59)).toBe("clip-23-59.mp4");
  });

  test("formatIdleFilename", () => {
    expect(formatIdleFilename(9, 3)).toBe("idle-09-03");
  });

  test("parseStagingFilename for clip", () => {
    expect(parseStagingFilename("clip-09-00.mp4")).toEqual({
      kind: "clip",
      hour: 9,
      minute: 0,
    });
    expect(parseStagingFilename("clip-23-59.mp4")).toEqual({
      kind: "clip",
      hour: 23,
      minute: 59,
    });
  });

  test("parseStagingFilename for idle", () => {
    expect(parseStagingFilename("idle-09-03")).toEqual({
      kind: "idle",
      hour: 9,
      minute: 3,
    });
  });

  test("parseStagingFilename rejects unrelated files", () => {
    expect(parseStagingFilename("README.md")).toBeNull();
    expect(parseStagingFilename(".DS_Store")).toBeNull();
    expect(parseStagingFilename("clip-9-0.mp4")).toBeNull(); // not zero-padded
    expect(parseStagingFilename("clip-09-00.txt")).toBeNull();
  });
});

describe("compareStagingItems", () => {
  function item(
    kind: "clip" | "idle",
    hour: number,
    minute: number
  ): StagingItem {
    return { kind, hour, minute, path: "/x", filename: "x" };
  }
  test("orders by hour then minute", () => {
    const a = item("clip", 9, 0);
    const b = item("clip", 9, 5);
    const c = item("clip", 10, 0);
    expect(compareStagingItems(a, b)).toBeLessThan(0);
    expect(compareStagingItems(b, c)).toBeLessThan(0);
    expect(compareStagingItems(c, a)).toBeGreaterThan(0);
    expect(compareStagingItems(a, a)).toBe(0);
  });
});

describe("parseClipOffset", () => {
  test("standard bracketed format", () => {
    expect(parseClipOffset("[01:30]")).toEqual({ mm: 1, ss: 30 });
    expect(parseClipOffset("[00:00]")).toEqual({ mm: 0, ss: 0 });
    expect(parseClipOffset("[00:59]")).toEqual({ mm: 0, ss: 59 });
  });

  test("tolerates single-digit minute", () => {
    expect(parseClipOffset("[1:30]")).toEqual({ mm: 1, ss: 30 });
  });

  test("tolerates unbracketed input", () => {
    expect(parseClipOffset("01:30")).toEqual({ mm: 1, ss: 30 });
  });

  test("rejects invalid seconds", () => {
    expect(parseClipOffset("[01:60]")).toBeNull();
    expect(parseClipOffset("[01:99]")).toBeNull();
  });

  test("rejects garbage", () => {
    expect(parseClipOffset("hello")).toBeNull();
    expect(parseClipOffset("")).toBeNull();
    expect(parseClipOffset("[01]")).toBeNull();
  });
});

describe("offsetToWallClock", () => {
  test("zero offset returns clip start", () => {
    expect(offsetToWallClock(9, 0, { mm: 0, ss: 0 })).toBe("09:00");
  });

  test("seconds within the same minute", () => {
    expect(offsetToWallClock(9, 0, { mm: 0, ss: 35 })).toBe("09:00");
    expect(offsetToWallClock(9, 0, { mm: 0, ss: 59 })).toBe("09:00");
  });

  test("minute increments roll over", () => {
    expect(offsetToWallClock(9, 0, { mm: 1, ss: 0 })).toBe("09:01");
    expect(offsetToWallClock(9, 59, { mm: 0, ss: 0 })).toBe("09:59");
    expect(offsetToWallClock(9, 59, { mm: 1, ss: 0 })).toBe("10:00");
  });

  test("hour wraps past midnight", () => {
    expect(offsetToWallClock(23, 59, { mm: 1, ss: 0 })).toBe("00:00");
    expect(offsetToWallClock(23, 59, { mm: 2, ss: 0 })).toBe("00:01");
  });
});
