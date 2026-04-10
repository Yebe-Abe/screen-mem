# screen-memory

A screen activity observer that watches your screen, understands what you're
doing, and stores it in a format any LLM agent can browse like a codebase.
The agent is the search engine it reads the index, navigates to what it
needs, and pulls full content on demand. Kind of like the way it would explore a codebase. 

Screen data is deeply undervalued and we are creating the infra to leverage it. This is v1. 

## Quick start

```bash
git clone https://github.com/Yebe-Abe/screen-mem.git && cd screen-mem
npm install                                                                                                                                                                                   
brew install ffmpeg                 # macOS — Linux: apt install ffmpeg
export FIREWORKS_API_KEY=fw_...     # add this to your shell rc

./bin/screen-mem.js start                     # foreground; Ctrl+C to stop
```

In another terminal at any time:

```bash
./bin/screen-mem.js stop                     # graceful shutdown via the PID file
```

On the first run on macOS, grant **Screen Recording** permission to your
terminal in *System Settings → Privacy & Security → Screen Recording*, then
fully quit the terminal app (Cmd+Q, not just close the window) and relaunch
before running `screen-mem` again — the permission only takes effect for new
processes.

### Find your screen capture device (if the default doesn't work)

`screen-mem` defaults to avfoundation device `1:none` on macOS, which is the
right index on most Macs but not all. If you see ffmpeg errors like
`Error opening input file 1:none` after granting Screen Recording permission,
list your actual devices:

```bash
ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep -E "AVFoundation|Capture"
```

Example output on a Mac with an iPhone connected via Continuity Camera:

```
[AVFoundation indev @ ...] AVFoundation video devices:
[AVFoundation indev @ ...] [0] FaceTime HD Camera
[AVFoundation indev @ ...] [1] iPhone Camera
[AVFoundation indev @ ...] [2] iPhone Desk View Camera
[AVFoundation indev @ ...] [3] Capture screen 0
```

The number in brackets next to "Capture screen 0" is what you want. In this
example the screen is at index 3, so:

```bash
export SCREEN_MEMORY_CAPTURE_INPUT="3:none"
screen-mem start
```

You can sanity-check that ffmpeg can actually capture (this also confirms the
Screen Recording permission is working):

```bash
ffmpeg -f avfoundation -framerate 10 -i 3:none -t 2 -y /tmp/test.mp4
open /tmp/test.mp4
```

If that produces a 2-second video of your screen, `screen-mem` will work too.

Recording is written to `~/context/`. Point any LLM agent at that directory
and let it read files — start with `~/context/<year>/<month>/map.txt`.

## Requirements

- Node 20+
- `ffmpeg` on PATH (for screen capture and frame extraction)
- macOS for OCR in V1 (Vision framework via a small Swift helper). Linux and
  Windows OCR adapters are V2.
- Screen Recording permission for the terminal you launch from (macOS).
- A Fireworks API key with access to a vision-language model and a text model.

## Configuration

Environment variables (sensible defaults for everything but the API key):

| Variable | Default |
|---|---|
| `FIREWORKS_API_KEY` | _required_ |
| `SCREEN_MEMORY_CONTEXT_DIR` | `~/context` |
| `SCREEN_MEMORY_STAGING_DIR` | `~/.screen-memory/staging` |
| `SCREEN_MEMORY_LOG_DIR` | `~/.screen-memory/logs` |
| `SCREEN_MEMORY_POLL_INTERVAL_MS` | `30000` |
| `SCREEN_MEMORY_IDLE_TIMEOUT_CLIPS` | `5` |
| `SCREEN_MEMORY_BACKLOG_CEILING` | `60` |
| `SCREEN_MEMORY_CAPTURE_INPUT` | `1:none` (macOS), `desktop` (Windows), `$DISPLAY` (Linux) |
| `FIREWORKS_VLM_MODEL` | `accounts/fireworks/models/qwen2p5-vl-32b-instruct` |
| `FIREWORKS_TEXT_MODEL` | `accounts/fireworks/models/qwen3-235b-a22b-instruct-2507` |
| `SCREEN_MEMORY_LOG_LEVEL` | `info` |

## Architecture

Two cooperating loops in one process, communicating through a staging
directory on disk:

```
recorder loop (every minute)              processor loop (every 30s)
  sample frame → hash → compare             list staging in time order
    same?  write idle marker                  clip → vlm → parse → session → write
    diff?  record 1-min mp4                   idle → mark idle → maybe close
                                              on close: text llm → sessions.txt → map.txt
                                              key frames → content dispatcher (ocr + store)
```

The recorder is responsible only for *whether to capture*. The index module
owns *understanding*. The content module owns *evidence* (OCR text + key
frame images). They talk via filesystem and a single in-process function
call (`ContentDispatcher.dispatch`).

## Code layout

```
src/
├── cli.ts                    ← entry point: start / stop
├── config.ts                 ← env-var Config + loader
├── types.ts                  ← shared cross-module types
├── logging.ts                ← stderr logger
├── utils/                    ← timestamps, paths, fs, hashing
├── recorder/                 ← orchestrator + 4 capabilities
├── index-module/             ← orchestrator + Session + VLM/text-LLM clients + writer
└── content/                  ← orchestrator + frame extractor + OCR + stores
```

## Tests

```bash
npm test
```

46 tests covering: timestamp/path helpers, the VLM response parser, the
Session data type's state transitions and invariants, and an integration
test that exercises the full index orchestrator pipeline against mocked
VLM/text-LLM/dispatcher.
