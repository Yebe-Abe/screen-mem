---
name: screen-mem
description: "Pull recent screen activity from ~/context — a navigable filesystem index of what the user has been doing, organized as YYYY/MM/map.txt → DD/sessions.txt → session-NNN/{meta.json,deltas.txt,content/}. IMMEDIATE TRIGGER: when the user types 'ct' or 'cx' anywhere in a message, treat it as an explicit command to fetch context — do NOT ask clarifying questions first, just follow the zoom-in flow below. ALSO fires implicitly whenever the user asks something that needs recent activity to answer well: 'what was I doing', 'what did I work on', 'help me continue X', 'follow up with [person]', 'what was the error I hit', 'what did I decide about Y', 'pick up where I left off', or any request that references a person/project/bug/decision without giving enough context to answer. When in doubt about whether recent activity would materially improve the answer, fire."
---

# Context Trigger — `~/context` screen memory

## What this is

`~/context` is a navigable filesystem index of the user's screen activity, produced by an LLM watching short clips of the screen. It is plain files on disk — no MCP, no search engine. You browse it like a codebase: read the index, navigate to what you need, pull full content on demand. Use `Read`, `Bash` (ls/cat/rg), and `Grep`.

## Trigger rules

Fire this skill (without asking) when:

1. **Explicit shortcuts** — message contains `ct` or `cx` as a standalone token. No clarifying questions, just start.
2. **Direct queries about activity** — "what was I doing", "what did I work on yesterday", "pull my context", "what have I been up to".
3. **Continuation requests** — "help me continue / pick up / finish X", "where did I leave off", "keep going on Y".
4. **Person/project references without context** — "reply to [name]", "follow up on the [project] spec", "what did [name] say", "continue the [thing]". The user assumes you know who/what — go look it up instead of guessing.
5. **"What was the exact..." questions** — "what was the error I hit", "what did I type in that message", "what was in that terminal output". These require `content/` ground truth.

When in doubt: fire. The cost of a `map.txt` read is trivial; the cost of a wrong answer built on no context is high.

## Folder layout (memorize this)

```
~/context/
├── README.md
├── YYYY/
│   └── MM/
│       ├── map.txt                    ← month overview + TODAY's full deltas inlined
│       └── DD/
│           ├── sessions.txt           ← one line per session for that day
│           └── session-NNN/
│               ├── meta.json          ← id, start/end times, workingDescription, finalDescription, closed, deltaCount
│               ├── deltas.txt         ← timestamped one-liners, ~1-minute granularity
│               └── content/
│                   ├── base-HH-MM.txt ← OCR dump of the screen at that moment
│                   ├── frame-HH-MM.jpg← full screenshot (~600 KB each)
│                   └── .dedup/        ← NEVER read — empty sentinel files for deduplication bookkeeping
```

- **Times** are local wall-clock, formatted `HH:MM`.
- **Session windows** are `[HH:MM–HH:MM]`.
- **Deltas** are one-liners in compressed natural language.
- Sessions group related activity. A 2-minute interlude in the middle of a long work session becomes its own session — that's intentional, the index optimizes for navigability by activity, not by time.

## The zoom-in flow (default procedure)

Always start shallow, go deeper only when the shallow layer can't answer the question.

### Step 1 — Always read `map.txt` first

```bash
cat ~/context/YYYY/MM/map.txt
```

Use the current year/month. If you don't know the current date, run `date` first.

`map.txt` gives you:
- One line per previous day of the month (high-level summary)
- **All of today's session deltas inlined at the bottom** — so for "what have I been doing today" you're often done after this single file.

### Step 2 — Narrow to a day (only if needed)

If the question is about a specific past day, or if `map.txt`'s one-liner for that day isn't enough:

```bash
cat ~/context/YYYY/MM/DD/sessions.txt
```

This gives you every session of that day as a one-line `[HH:MM–HH:MM] description`.

### Step 3 — Narrow to a session (only if needed)

Pick the session(s) that match the question's topic/time, then:

```bash
cat ~/context/YYYY/MM/DD/session-NNN/deltas.txt
```

Deltas are ~1-minute granularity one-liners. This is usually enough for "what did I do in that stretch".

### Step 4 — Go to ground truth in `content/` (when it matters)

Read `content/base-HH-MM.txt` when the deltas are too vague for the question. Good reasons to descend:

- **Debugging** — "help me fix the error I was hitting" → grab the terminal OCR verbatim
- **Exact text recall** — "what did I actually type in that message", "what was the URL of that post"
- **Verification** — the delta says something unexpected and you need to confirm against source

```bash
ls ~/context/YYYY/MM/DD/session-NNN/content/
cat ~/context/YYYY/MM/DD/session-NNN/content/base-HH-MM.txt
```

Single session OCR is cheap (typically 1–15 KB). Reading it is fine when it materially helps.

### Step 5 — Frames (vision) — only for explicit visual questions

`frame-HH-MM.jpg` files are ~600 KB full screenshots. Only read one when the question is genuinely visual:

- "what did that chart look like"
- "show me the error dialog"
- "what was on screen when X happened" *and* the OCR isn't enough

**Never** load multiple frames unless the user explicitly asks for a visual walkthrough. One frame at a time.

## Grep is your friend

For topic/keyword searches across a day or the month, grep instead of reading file after file. It's free — matches return as lines, not full file contents.

```bash
# Across today's deltas
rg -n "keyword" ~/context/YYYY/MM/DD/session-*/deltas.txt

# Across today's OCR (catches exact strings the deltas may have paraphrased)
rg -n "keyword" ~/context/YYYY/MM/DD/session-*/content/base-*.txt

# Across the whole month
rg -n "project name" ~/context/YYYY/MM/
```

Use `rg -l` to just list matching files, then read the few that matter.

## Budget discipline (honest rules)

- **Text layers (`map.txt`, `sessions.txt`, `deltas.txt`, `meta.json`)** → read freely, they're tiny.
- **`rg` across anything** → free, use it eagerly.
- **One session's `content/base-*.txt`** → fine when the deltas are too vague. Do it for bug-fix / exact-text / verification cases.
- **Multiple sessions' `content/`** → only when the question genuinely spans them, and prefer `rg` over `cat`.
- **`frame-*.jpg`** → rare, explicit visual questions only, one frame at a time.
- **`.dedup/`** → never. Empty tombstones for the indexer, zero content.
- **Slurping a whole day's OCR** → don't. Grep instead.

The question to sit with before descending into `content/`: **"would ground-truth OCR/visual detail actually change my answer?"** If yes, go get it. If no, stop at deltas.

## `meta.json` quick reference

Each session's `meta.json` has:

- `id`, `date`, `startHour/Minute`, `endHour/Minute` — time window
- `workingDescription` — in-progress one-liner (present while the session is open)
- `finalDescription` — fuller summary (present once `closed: true`)
- `deltaCount` — how many one-liners are in `deltas.txt`
- `closed` — whether the session has ended

Useful when you want a quick summary of a specific session without reading all its deltas, or when filtering to closed vs still-in-progress sessions.

## Caveat

The index is generated by an LLM watching short video clips of the screen. Treat it like an attentive but imperfect note-taker: relations and entities are usually right, but specific quoted text should be verified against `content/base-HH-MM.txt` snapshots when accuracy matters.

## Do NOT

- Do NOT ask "what context do you want?" when the user typed `ct` or `cx` — just fetch.
- Do NOT read `.dedup/` — empty files.
- Do NOT load frames speculatively. One frame at a time, only on explicit visual need.
- Do NOT slurp a whole day's `content/` dir. Grep.
- Do NOT guess dates — run `date` if unsure.
- Do NOT report "I don't have access to what you were doing" — you do. Go read `~/context`.

## Examples

**User:** "ct"
→ Run `date`, `cat ~/context/YYYY/MM/map.txt` → summarize today's activity from the inlined deltas. Done.

**User:** "cx what was I doing yesterday"
→ `cat ~/context/YYYY/MM/DD/sessions.txt` for yesterday's date → give the day's arc. Drill into a session only if the user asks for more.

**User:** "help me reply to [person]"
→ Implicit trigger. `rg -n "[person]" ~/context/YYYY/MM/*/session-*/deltas.txt` → find the recent mentions, read the most relevant session's deltas, then check its `content/base-*.txt` if you need the exact message text.

**User:** "what was that error I hit"
→ Implicit trigger. Grep for the relevant keyword in deltas → identify the session → read that session's `content/base-*.txt` for the verbatim terminal output.

**User:** "continue the [project] spec"
→ Implicit trigger. `rg -n "[project]" ~/context/YYYY/MM/` → find recent sessions that touched the spec → read deltas → optionally crack open content if you need the exact wording. Then help.

**User:** "what was on screen when I got that weird dialog at 5:15"
→ Drill to the relevant `session-NNN/deltas.txt` near 5:15, then read the matching `base-05-15.txt`, then (only if OCR is insufficient) load `frame-05-15.jpg`.
