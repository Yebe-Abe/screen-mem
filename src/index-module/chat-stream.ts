// Shared helper for consuming OpenAI-compatible Server-Sent Events chat
// completion streams. Used by both the VLM client and the text LLM client —
// both send streaming chat completion requests to Fireworks and need to
// accumulate the response the same way.
//
// qwen3p6-plus on Fireworks is a reasoning model that emits its chain-of-
// thought to a separate `reasoning_content` field before producing the
// final `content`. Without streaming + a large max_tokens budget, the
// thinking trace eats the entire budget and `content` comes back null.
// Streaming removes the non-streaming 4096 token cap; we track the
// reasoning size only for error diagnostics.

/** One Server-Sent Events chunk from a streaming chat completion. */
export interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
}

export interface StreamResult {
  /** Accumulated final answer text. This is what the caller uses. */
  content: string;
  /** Total chars of chain-of-thought the model emitted — for error reporting only. */
  reasoningChars: number;
  /** Whatever finish_reason the last chunk carried (stop, length, etc.). */
  finishReason: string | null;
}

/**
 * Consume an OpenAI-compatible Server-Sent Events stream and accumulate the
 * content text. Tolerates the optional `reasoning_content` field used by
 * Qwen reasoning models on Fireworks. Returns once the stream ends or
 * `data: [DONE]` is received.
 *
 * The parser is conservative: it skips SSE comments (`: ...`), tolerates
 * missing fields, and continues past individual malformed chunks so one
 * bad chunk doesn't poison the whole stream. Mid-stream `error` fields in
 * a chunk throw after the current iteration — we don't trust the partial
 * content that preceded it.
 */
export async function consumeChatStream(
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
          // Malformed chunk — skip; the rest of the stream may still be valid.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (streamError) {
    throw new Error(`chat stream error: ${streamError}`);
  }
  return { content, reasoningChars, finishReason };
}
