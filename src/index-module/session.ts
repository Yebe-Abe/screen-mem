// The Session data type — the central abstraction of the index module.
//
// A Session represents a bounded, described unit of activity. It accumulates
// deltas, tracks consecutive idle markers, and enforces invariants about
// state transitions:
//
// - Once closed, a session cannot accept new deltas or idle marks.
// - The idle counter resets to zero whenever a non-idle delta is appended.
// - Only the first idle marker in a run produces a "[HH:MM] idle" delta;
//   subsequent ones increment the counter silently.
// - The working description is set at construction and is not mutated by
//   later deltas (that's how the VLM gets a stable session anchor).
//
// All time fields are stored as numbers (hour 0-23, minute 0-59) rather than
// Date objects to make the type easy to serialize and to keep the conversion
// logic out of the data type. The orchestrator owns Date → hour/minute
// conversion at the edges.

import type { WallClockDelta } from "../types.js";
import { pad2 } from "../utils/timestamps.js";

export interface SessionDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export interface SessionMeta {
  id: number;
  date: SessionDate;
  startHour: number;
  startMinute: number;
  endHour: number | null;
  endMinute: number | null;
  workingDescription: string;
  finalDescription: string | null;
  closed: boolean;
  deltaCount: number;
}

export class Session {
  readonly id: number;
  readonly date: SessionDate;
  readonly startHour: number;
  readonly startMinute: number;
  readonly workingDescription: string;

  private _deltas: WallClockDelta[];
  private _idleCounter: number;
  private _closed: boolean;
  private _endHour: number | null;
  private _endMinute: number | null;
  private _finalDescription: string | null;

  constructor(
    id: number,
    date: SessionDate,
    startHour: number,
    startMinute: number,
    workingDescription: string,
    initialDeltas: readonly WallClockDelta[]
  ) {
    if (id < 1) throw new Error("Session id must be positive");
    if (!workingDescription.trim()) {
      throw new Error("workingDescription must not be empty");
    }
    this.id = id;
    this.date = date;
    this.startHour = startHour;
    this.startMinute = startMinute;
    this.workingDescription = workingDescription;
    this._deltas = [...initialDeltas];
    this._idleCounter = 0;
    this._closed = false;
    this._endHour = null;
    this._endMinute = null;
    this._finalDescription = null;
  }

  get closed(): boolean {
    return this._closed;
  }
  get deltas(): readonly WallClockDelta[] {
    return this._deltas;
  }
  get idleCounter(): number {
    return this._idleCounter;
  }
  get finalDescription(): string | null {
    return this._finalDescription;
  }
  get endHour(): number | null {
    return this._endHour;
  }
  get endMinute(): number | null {
    return this._endMinute;
  }

  /** Last N deltas, used as VLM context for the next clip. */
  lastDeltas(n: number = 3): WallClockDelta[] {
    return this._deltas.slice(-n);
  }

  /**
   * Append deltas from a "same" clip. Resets the idle counter — any run of
   * idle markers is broken by the arrival of activity.
   */
  appendDeltas(newDeltas: readonly WallClockDelta[]): void {
    this.assertOpen();
    this._deltas.push(...newDeltas);
    this._idleCounter = 0;
  }

  /**
   * Record an idle marker. Returns the "[HH:MM] idle" delta to write to
   * deltas.txt only on the first idle marker in a run; subsequent markers
   * return null and silently increment the counter.
   */
  markIdle(hour: number, minute: number): WallClockDelta | null {
    this.assertOpen();
    this._idleCounter += 1;
    if (this._idleCounter === 1) {
      const delta: WallClockDelta = {
        time: `${pad2(hour)}:${pad2(minute)}`,
        text: "idle",
      };
      this._deltas.push(delta);
      return delta;
    }
    return null;
  }

  /** True if the session has accumulated enough consecutive idles to close. */
  shouldCloseForIdle(idleTimeoutClips: number): boolean {
    return this._idleCounter >= idleTimeoutClips;
  }

  /**
   * Mark the session closed with a final description and end time. Subsequent
   * mutations throw. Idempotent guard against double-close.
   */
  close(
    finalDescription: string,
    endHour: number,
    endMinute: number
  ): void {
    this.assertOpen();
    if (!finalDescription.trim()) {
      throw new Error("finalDescription must not be empty");
    }
    this._closed = true;
    this._finalDescription = finalDescription.trim();
    this._endHour = endHour;
    this._endMinute = endMinute;
  }

  /** Wall-clock start of the session formatted as "HH:MM". */
  startHHMM(): string {
    return `${pad2(this.startHour)}:${pad2(this.startMinute)}`;
  }

  /**
   * Wall-clock end of the session, formatted "HH:MM". Falls back to the
   * latest delta time if not explicitly set (for sessions in the middle of
   * an idle close, the orchestrator computes end from the last activity).
   */
  endHHMM(): string {
    if (this._endHour !== null && this._endMinute !== null) {
      return `${pad2(this._endHour)}:${pad2(this._endMinute)}`;
    }
    const last = this._deltas[this._deltas.length - 1];
    return last ? last.time : this.startHHMM();
  }

  /** Snapshot suitable for meta.json. */
  toMeta(): SessionMeta {
    return {
      id: this.id,
      date: this.date,
      startHour: this.startHour,
      startMinute: this.startMinute,
      endHour: this._endHour,
      endMinute: this._endMinute,
      workingDescription: this.workingDescription,
      finalDescription: this._finalDescription,
      closed: this._closed,
      deltaCount: this._deltas.length,
    };
  }

  private assertOpen(): void {
    if (this._closed) {
      throw new Error(`Session ${this.id} is closed and cannot be mutated`);
    }
  }
}
