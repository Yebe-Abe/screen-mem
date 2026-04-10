// Content module orchestrator — implements ContentDispatcher. Receives key
// frame work from the index module, extracts each frame from the source
// clip, runs OCR via the platform adapter, and stores both the image and
// the OCR text in the session's content/ directory.
//
// Failure handling: every step is wrapped so that one bad frame doesn't take
// down the rest of the work item, and one bad work item doesn't take down
// the index pipeline. The dispatcher contract says dispatch() must not throw.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../config.js";
import { createLogger } from "../logging.js";
import type { ContentDispatcher, KeyFrameWork } from "../types.js";
import { sessionContentDirPath } from "../utils/paths.js";
import { createFrameExtractor, type FrameExtractor } from "./frame-extractor.js";
import { createImageStore, type ImageStore } from "./image-store.js";
import { createOcrEngine, type OcrEngine } from "./ocr-engine.js";
import { createTextStore, type TextStore } from "./text-store.js";

const log = createLogger("content");

export interface ContentOrchestratorDeps {
  frameExtractor?: FrameExtractor;
  ocrEngine?: OcrEngine;
  textStore?: TextStore;
  imageStore?: ImageStore;
}

export function createContentDispatcher(
  config: Config,
  deps: ContentOrchestratorDeps = {}
): ContentDispatcher {
  const extractor = deps.frameExtractor ?? createFrameExtractor();
  const ocr = deps.ocrEngine ?? createOcrEngine(config);
  const textStore = deps.textStore ?? createTextStore();
  const imageStore = deps.imageStore ?? createImageStore();

  return {
    async dispatch(work: KeyFrameWork): Promise<void> {
      const contentDir = sessionContentDirPath(work.sessionDir);
      for (const frame of work.frames) {
        const tmpFile = path.join(
          os.tmpdir(),
          `screen-memory-keyframe-${process.pid}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}.jpg`
        );
        try {
          await extractor.extract(work.clipPath, frame.offset, tmpFile);

          // Image: write first so we always have a visual reference even if
          // OCR fails.
          try {
            const bytes = await fs.readFile(tmpFile);
            await imageStore.write(contentDir, frame.wallClock, bytes);
          } catch (err) {
            log.warn("image store failed for frame", {
              wallClock: frame.wallClock,
              error: (err as Error).message,
            });
          }

          // OCR text: best-effort.
          try {
            const text = await ocr.extract(tmpFile);
            if (text.trim()) {
              await textStore.write(contentDir, frame.wallClock, text);
            }
          } catch (err) {
            log.warn("OCR / text store failed for frame", {
              wallClock: frame.wallClock,
              error: (err as Error).message,
            });
          }
        } catch (err) {
          log.warn("frame extract failed, skipping", {
            wallClock: frame.wallClock,
            offset: frame.offset,
            error: (err as Error).message,
          });
        } finally {
          await fs.unlink(tmpFile).catch(() => {
            /* best effort */
          });
        }
      }
    },
  };
}
