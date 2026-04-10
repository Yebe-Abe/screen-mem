// ocr_engine — the adapter interface for OCR. The index module and content
// orchestrator depend on `OcrEngine`, never on a concrete adapter. V1 ships
// the Mac adapter (Vision framework via a Swift helper); Windows and Linux
// adapters are V2 work.
//
// Calling `createOcrEngine` on an unsupported platform returns an engine
// whose `extract()` throws. The content orchestrator catches that and skips
// the text snapshot — the index pipeline is unaffected.

import type { Config } from "../config.js";
import { createMacOcrEngine } from "./ocr-mac.js";

export interface OcrEngine {
  /** Extract text from an image file. Throws on adapter or runtime failure. */
  extract(imagePath: string): Promise<string>;
}

export function createOcrEngine(config: Config): OcrEngine {
  switch (config.platform) {
    case "darwin":
      return createMacOcrEngine();
    case "win32":
    case "linux":
      return createNoopOcrEngine(config.platform);
  }
}

function createNoopOcrEngine(platform: string): OcrEngine {
  return {
    async extract(): Promise<string> {
      throw new Error(
        `OCR not yet implemented for platform '${platform}' — V1 ships only the Mac adapter`
      );
    },
  };
}
