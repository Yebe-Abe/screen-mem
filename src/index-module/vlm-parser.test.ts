import { describe, expect, test } from "vitest";
import { parseVlmResponse } from "./vlm-parser.js";

describe("parseVlmResponse", () => {
  test("parses a complete standard response", () => {
    const raw = `SESSION: same
DELTAS:
[00:15] added OAuth client_id + client_secret entries to config.yaml
[00:22] wrote integration test for token exchange in auth_test.py
[00:35] ran tests: 3 failures on integration endpoint
KEY_FRAMES: 00:15, 00:35`;

    const r = parseVlmResponse(raw);
    expect(r.continuity).toBe("same");
    expect(r.deltas).toHaveLength(3);
    expect(r.deltas[0]).toEqual({
      offset: { mm: 0, ss: 15 },
      text: "added OAuth client_id + client_secret entries to config.yaml",
    });
    expect(r.deltas[2]?.offset).toEqual({ mm: 0, ss: 35 });
    expect(r.keyFrames).toHaveLength(2);
    expect(r.keyFrames[0]).toEqual({ mm: 0, ss: 15 });
  });

  test("handles KEY_FRAMES: none", () => {
    const raw = `SESSION: same
DELTAS:
[00:10] reading code
KEY_FRAMES: none`;
    const r = parseVlmResponse(raw);
    expect(r.keyFrames).toEqual([]);
  });

  test("handles different continuity", () => {
    const raw = `SESSION: different
DELTAS:
[00:05] switched to email client
KEY_FRAMES: none`;
    expect(parseVlmResponse(raw).continuity).toBe("different");
  });

  test("handles new continuity", () => {
    const raw = `SESSION: new
DELTAS:
[00:01] opened terminal
KEY_FRAMES: none`;
    expect(parseVlmResponse(raw).continuity).toBe("new");
  });

  test("defaults missing SESSION to new", () => {
    const raw = `DELTAS:
[00:01] something
KEY_FRAMES: none`;
    expect(parseVlmResponse(raw).continuity).toBe("new");
  });

  test("skips malformed delta lines but keeps the rest", () => {
    const raw = `SESSION: same
DELTAS:
[00:10] valid delta one
this line has no bracket and should be skipped
[00:20] valid delta two
KEY_FRAMES: none`;
    const r = parseVlmResponse(raw);
    expect(r.deltas).toHaveLength(2);
    expect(r.deltas[1]?.text).toBe("valid delta two");
  });

  test("caps key frames at 3", () => {
    const raw = `SESSION: same
DELTAS:
[00:01] x
KEY_FRAMES: 00:01, 00:10, 00:20, 00:30, 00:40`;
    expect(parseVlmResponse(raw).keyFrames).toHaveLength(3);
  });

  test("tolerates extra whitespace and casing", () => {
    const raw = `session: SAME

DELTAS:

[00:05]   leading spaces in description

KEY_FRAMES:00:05`;
    const r = parseVlmResponse(raw);
    expect(r.continuity).toBe("same");
    expect(r.deltas).toHaveLength(1);
    expect(r.deltas[0]?.text).toBe("leading spaces in description");
    expect(r.keyFrames).toEqual([{ mm: 0, ss: 5 }]);
  });

  test("tolerates the prompt-template echo on the SESSION line", () => {
    const raw = `SESSION: same | different | new

Wait, the actual answer is:

SESSION: different
DELTAS:
[00:01] something
KEY_FRAMES: none`;
    // Last SESSION header wins because we re-read it on each header line.
    expect(parseVlmResponse(raw).continuity).toBe("different");
  });
});
