// Mac OCR adapter. Wraps Apple's Vision framework via a small Swift script
// that we materialize on disk on first use. The Swift script reads an image
// path from argv, runs VNRecognizeTextRequest, and prints the recognized
// text to stdout.
//
// Why a script and not a precompiled binary: precompiling would require a
// build step in our package install, which fights the "simple CLI tool" V1
// constraint. Swift JIT-compiles fast enough that the overhead is acceptable
// for the few key frames we extract per clip. If this turns out to be a
// bottleneck, switch to `swiftc` ahead of time and cache the binary.

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomic } from "../utils/fs.js";
import type { OcrEngine } from "./ocr-engine.js";

const SWIFT_OCR_SOURCE = `import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write("usage: mac-ocr <image-path>\\n".data(using: .utf8)!)
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let url = URL(fileURLWithPath: imagePath)

guard let nsImage = NSImage(contentsOf: url),
      let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("failed to load image: \\(imagePath)\\n".data(using: .utf8)!)
    exit(2)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write("OCR failed: \\(error)\\n".data(using: .utf8)!)
    exit(3)
}

for obs in request.results ?? [] {
    if let text = obs.topCandidates(1).first?.string {
        print(text)
    }
}
`;

let scriptPathPromise: Promise<string> | null = null;

function getScriptPath(): Promise<string> {
  if (scriptPathPromise) return scriptPathPromise;
  scriptPathPromise = (async () => {
    const cacheDir = path.join(
      process.env.HOME ?? os.homedir(),
      ".screen-memory",
      "cache"
    );
    const scriptPath = path.join(cacheDir, "mac-ocr.swift");
    await writeFileAtomic(scriptPath, SWIFT_OCR_SOURCE);
    return scriptPath;
  })();
  return scriptPathPromise;
}

export function createMacOcrEngine(): OcrEngine {
  return {
    async extract(imagePath: string): Promise<string> {
      const scriptPath = await getScriptPath();
      // Verify the input exists before spawning swift, to give a clearer error
      try {
        await fs.access(imagePath);
      } catch {
        throw new Error(`OCR input image missing: ${imagePath}`);
      }
      return runSwiftScript(scriptPath, imagePath);
    },
  };
}

function runSwiftScript(scriptPath: string, imagePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("swift", [scriptPath, imagePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) =>
      reject(
        new Error(
          `swift not found or failed to spawn (Mac OCR requires Xcode CLT): ${err.message}`
        )
      )
    );
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(`mac-ocr exited ${code}: ${stderr.trim() || "(no stderr)"}`)
        );
      }
    });
  });
}
