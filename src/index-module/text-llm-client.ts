// text_llm_client capability — HTTP I/O to Fireworks for the two text-only
// summarization calls (session close + day summary). Same OpenAI-compatible
// chat completions endpoint as the VLM client, but text-in / text-out.
//
// Retry policy: backoff on transient failures, give up after 3 attempts and
// throw. The caller decides what to do (typically: log and accept that the
// session description / map line is missing — deltas are still on disk and
// can be regenerated later).

// text_llm_client capability — HTTP I/O to Fireworks for session-close and
// day-summary calls. Uses the same OpenAI-compatible chat completions
// endpoint as the VLM client but with text-only input.
//
// Like the VLM client, we stream. qwen3p6-plus is a reasoning model, and
// without streaming + a large max_tokens budget, the thinking trace for
// day-summary (which has to digest the whole day's session descriptions)
// reliably eats the entire non-streaming 4096 cap and returns empty content.
//
// Retry policy: 3 attempts with exponential backoff. The caller decides
// what to do if we still fail — typically log + accept that the session
// description / map line is missing; the deltas are on disk regardless.

import type { Config } from "../config.js";
import { createLogger } from "../logging.js";
import type { WallClockDelta } from "../types.js";
import { consumeChatStream } from "./chat-stream.js";
import {
  buildDaySummaryPrompt,
  buildSessionClosePrompt,
} from "./prompts.js";

const log = createLogger("index:text-llm");

export interface TextLlmClient {
  /** Generate a one-line session description from accumulated deltas. */
  summarizeSession(
    startHHMM: string,
    endHHMM: string,
    deltas: readonly WallClockDelta[]
  ): Promise<string>;

  /** Generate a one-line day summary from session description lines. */
  summarizeDay(ymd: string, sessionLines: readonly string[]): Promise<string>;
}

const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 500;

export function createTextLlmClient(config: Config): TextLlmClient {
  async function callChat(prompt: string, label: string): Promise<string> {
    // Match the validated single-user-message format used by the VLM client.
    // qwen3p6-plus returns empty content when given a separate system role.
    //
    // Streaming + a generous max_tokens budget. The model emits chain-of-
    // thought to delta.reasoning_content first, then the final summary to
    // delta.content. We accumulate both via the shared SSE helper and use
    // delta.content as the answer.
    const body = {
      model: config.fireworksTextModel,
      max_tokens: 16384,
      temperature: 0.3,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    };
    const url = `${config.fireworksBaseUrl}/chat/completions`;

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.fireworksApiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          if (response.status === 404) {
            throw new Error(
              `text LLM model not found on Fireworks: '${config.fireworksTextModel}'. ` +
                `Set FIREWORKS_TEXT_MODEL to a model id your account can access. ` +
                `(raw: ${text.slice(0, 200)})`
            );
          }
          throw new Error(
            `text LLM HTTP ${response.status}: ${text.slice(0, 300) || "(no body)"}`
          );
        }
        if (!response.body) {
          throw new Error("text LLM streaming response had no body");
        }

        const result = await consumeChatStream(response.body);
        if (!result.content.trim()) {
          throw new Error(
            `text LLM returned empty content via stream (finish_reason=${result.finishReason ?? "unknown"}, ` +
              `reasoning_content=${result.reasoningChars} chars). ` +
              `max_tokens (currently 16384) may still be too low, or the stream was cut short.`
          );
        }
        return firstLine(result.content.trim());
      } catch (err) {
        lastErr = err as Error;
        if (attempt < MAX_ATTEMPTS) {
          const delay = INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
          log.warn("text LLM call failed, retrying", {
            label,
            attempt,
            delay,
            error: lastErr.message,
          });
          await sleep(delay);
        }
      }
    }
    throw new Error(
      `text LLM ${label} failed after ${MAX_ATTEMPTS} attempts: ${lastErr?.message}`
    );
  }

  return {
    async summarizeSession(startHHMM, endHHMM, deltas): Promise<string> {
      const prompt = buildSessionClosePrompt(startHHMM, endHHMM, deltas);
      return callChat(prompt, "session-close");
    },
    async summarizeDay(ymd, sessionLines): Promise<string> {
      const prompt = buildDaySummaryPrompt(ymd, sessionLines);
      return callChat(prompt, "day-summary");
    },
  };
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return idx === -1 ? s : s.slice(0, idx);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
