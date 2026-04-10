// text_llm_client capability — HTTP I/O to Fireworks for the two text-only
// summarization calls (session close + day summary). Same OpenAI-compatible
// chat completions endpoint as the VLM client, but text-in / text-out.
//
// Retry policy: backoff on transient failures, give up after 3 attempts and
// throw. The caller decides what to do (typically: log and accept that the
// session description / map line is missing — deltas are still on disk and
// can be regenerated later).

import type { Config } from "../config.js";
import { createLogger } from "../logging.js";
import type { WallClockDelta } from "../types.js";
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

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  error?: { message?: string };
}

const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 500;

export function createTextLlmClient(config: Config): TextLlmClient {
  async function callChat(prompt: string, label: string): Promise<string> {
    // Match the validated single-user-message format used by the VLM client.
    // qwen3p6-plus returns empty content when given a separate system role.
    const body = {
      model: config.fireworksTextModel,
      max_tokens: 512,
      temperature: 0.3,
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
            Accept: "application/json",
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
        const json = (await response.json()) as ChatCompletionResponse;
        if (json.error?.message) {
          throw new Error(`text LLM API error: ${json.error.message}`);
        }
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
          throw new Error(
            `text LLM returned empty content. Full response: ${JSON.stringify(json).slice(0, 1000)}`
          );
        }
        return firstLine(content.trim());
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
