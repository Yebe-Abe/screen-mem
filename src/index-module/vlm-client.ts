// vlm_client capability — HTTP I/O to Fireworks for the per-clip VLM call.
// Reads the clip from disk, base64-encodes it as a data URL, and posts to
// the OpenAI-compatible chat completions endpoint as a streaming request.
// Returns the accumulated content text the model produced (the parser
// handles structure).
//
// Why streaming: qwen3p6-plus is a reasoning model whose chain-of-thought
// can run thousands of tokens per call. Fireworks caps non-streaming
// chat completions at max_tokens=4096 and we observed the model hitting
// that ceiling mid-thought (`finish_reason=length`, `content=null`,
// `reasoning_content` ~16k chars). Streaming removes the cap and lets us
// budget the full reasoning trace + final content.
//
// Retry policy: the orchestrator owns retry counts and decides when to
// give up. The client itself does no retries — a single failure throws
// and the orchestrator either re-queues or drops the clip.

import * as fs from "node:fs/promises";
import type { Config } from "../config.js";
import { createLogger } from "../logging.js";
import type { WallClockDelta } from "../types.js";
import { buildVlmPrompt } from "./prompts.js";

const log = createLogger("index:vlm-client");

export interface VlmClient {
  /**
   * Send a clip to the VLM. Returns the raw response text. Throws on any
   * HTTP failure or API error.
   */
  call(
    clipPath: string,
    workingDescription: string | null,
    lastDeltas: readonly WallClockDelta[]
  ): Promise<string>;
}

/** One Server-Sent Events chunk from a streaming chat completion. */
interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
}

interface StreamResult {
  content: string;
  reasoningChars: number;
  finishReason: string | null;
}

export function createVlmClient(config: Config): VlmClient {
  return {
    async call(
      clipPath: string,
      workingDescription: string | null,
      lastDeltas: readonly WallClockDelta[]
    ): Promise<string> {
      const bytes = await fs.readFile(clipPath);
      const base64 = bytes.toString("base64");
      const dataUrl = `data:video/mp4;base64,${base64}`;
      const prompt = buildVlmPrompt(workingDescription, lastDeltas);

      // Match the validated test_vlm.py request shape: single `user`
      // message containing [video_url, text]. qwen3p6-plus returns empty
      // content if a separate `system` role is used.
      //
      // Streaming + a generous max_tokens budget. The model emits its
      // chain-of-thought to delta.reasoning_content first, then the final
      // structured response to delta.content. We accumulate both and use
      // delta.content as the answer.
      const body = {
        model: config.fireworksVlmModel,
        max_tokens: 16384,
        temperature: 0.2,
        stream: true,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "video_url",
                video_url: { url: dataUrl },
              },
              {
                type: "text",
                text: prompt,
              },
            ],
          },
        ],
      };

      const url = `${config.fireworksBaseUrl}/chat/completions`;
      log.debug("calling VLM (streaming)", {
        clipPath,
        bytes: bytes.length,
        model: config.fireworksVlmModel,
      });

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.fireworksApiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new Error(`VLM HTTP error: ${(err as Error).message}`);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        if (response.status === 404) {
          throw new Error(
            `VLM model not found on Fireworks: '${config.fireworksVlmModel}'. ` +
              `Set FIREWORKS_VLM_MODEL to a model id your account can access. ` +
              `Run: curl -s https://api.fireworks.ai/inference/v1/models ` +
              `-H "Authorization: Bearer $FIREWORKS_API_KEY" | jq '.data[].id' ` +
              `to list available models. (raw: ${text.slice(0, 200)})`
          );
        }
        if (response.status === 401 || response.status === 403) {
          throw new Error(
            `VLM auth failed (HTTP ${response.status}) — check FIREWORKS_API_KEY. (raw: ${text.slice(0, 200)})`
          );
        }
        throw new Error(
          `VLM HTTP ${response.status}: ${text.slice(0, 500) || "(no body)"}`
        );
      }

      if (!response.body) {
        throw new Error("VLM streaming response had no body");
      }

      const result = await consumeChatStream(response.body);

      if (!result.content.trim()) {
        throw new Error(
          `VLM returned empty content via stream (finish_reason=${result.finishReason ?? "unknown"}, ` +
            `reasoning_content=${result.reasoningChars} chars). ` +
            `Either max_tokens (currently 16384) is still too low, the stream was cut short, ` +
            `or the model produced reasoning but no final answer.`
        );
      }
      return result.content;
    },
  };
}

/**
 * Consume an OpenAI-compatible Server-Sent Events stream and accumulate the
 * content text. Tolerates the optional `reasoning_content` field used by
 * Qwen reasoning models on Fireworks. Returns once the stream ends or
 * `data: [DONE]` is received.
 */
async function consumeChatStream(
  body: ReadableStream<Uint8Array>
): Promise<StreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningChars = 0;
  let finishReason: string | null = null;
  let streamError: string | null = null;
  let done = false;

  try {
    while (!done) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete lines from the SSE stream. Lines are terminated by
      // \n; data fields look like "data: {...}" or "data: [DONE]".
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const line = rawLine.replace(/\r$/, "").trim();
        if (!line) continue;
        if (line.startsWith(":")) continue; // SSE comment
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          done = true;
          break;
        }
        try {
          const chunk = JSON.parse(data) as ChatCompletionChunk;
          if (chunk.error?.message) {
            streamError = chunk.error.message;
            done = true;
            break;
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (typeof delta?.content === "string") {
            content += delta.content;
          }
          if (typeof delta?.reasoning_content === "string") {
            reasoningChars += delta.reasoning_content.length;
          }
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }
        } catch {
          // Malformed chunk — skip; the rest of the stream may still be valid
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (streamError) {
    throw new Error(`VLM stream error: ${streamError}`);
  }
  return { content, reasoningChars, finishReason };
}
