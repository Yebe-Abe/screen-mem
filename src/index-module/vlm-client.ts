// vlm_client capability — HTTP I/O to Fireworks for the per-clip VLM call.
// Reads the clip from disk, base64-encodes it as a data URL, and posts to
// the OpenAI-compatible chat completions endpoint. Returns the raw text the
// model produced (the parser handles structure).
//
// Retry policy: the orchestrator owns retry counts and decides when to give
// up. The client itself does no retries — a single failure throws and the
// orchestrator either re-queues or drops the clip.

import * as fs from "node:fs/promises";
import type { Config } from "../config.js";
import { createLogger } from "../logging.js";
import type { WallClockDelta } from "../types.js";
import {
  VLM_SYSTEM_PROMPT,
  buildVlmUserContext,
} from "./prompts.js";

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

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  error?: { message?: string };
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
      const userContext = buildVlmUserContext(workingDescription, lastDeltas);

      const body = {
        model: config.fireworksVlmModel,
        max_tokens: 2048,
        temperature: 0.2,
        messages: [
          { role: "system", content: VLM_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "video_url",
                video_url: { url: dataUrl },
              },
              {
                type: "text",
                text: userContext,
              },
            ],
          },
        ],
      };

      const url = `${config.fireworksBaseUrl}/chat/completions`;
      log.debug("calling VLM", {
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
            Accept: "application/json",
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

      const json = (await response.json()) as ChatCompletionResponse;
      if (json.error?.message) {
        throw new Error(`VLM API error: ${json.error.message}`);
      }
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("VLM returned empty content");
      }
      return content;
    },
  };
}
