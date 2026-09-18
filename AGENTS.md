# AGENTS.md — opencode-token-min

Guidance for agents working in this repo. Keep it public-safe (no personal
paths, tokens, or conversation data in commits).

## What this is
A cache-aware context-trimming plugin for opencode. The server plugin
(`plugins/token-min.ts`) trims/digests every step's context via
`experimental.chat.messages.transform`, tracks a per-task ledger of cost/tokens/
est-saved, and exposes a `cost` tool. The TUI plugin (`tui/token-min.tsx`)
renders the honest Context sidebar from that ledger. Goal per the awesome LLM
token-optimization guide: cut re-sent-context cost 80–99%.

## Commands
- `bun install` — pull the opencode plugin/sdk dev deps
- `bun build --target=bun plugins/token-min.ts --outdir /tmp/b` — syntax check server plugin (must be OK)
- `bun build --target=bun tui/token-min.tsx --outdir /tmp/b` — syntax check TUI plugin (must be OK)
- No test suite; verification is a live `opencode /tui --dev` against a long session

## Layout
- `plugins/token-min.ts` — server plugin (transform hook, ledger, `cost` tool)
- `tui/token-min.tsx` — sidebar plugin (reads `token-usage.jsonl`)
- `assets/token-min-overview.svg` — README illustration (re-render PNG via `magick`)

## Conventions (keep these synced)
- **These two files MUST stay in byte-sync with the live install:**
  `~/.config/opencode/plugins/token-min.ts` and `~/.config/opencode/tui/token-min.tsx`.
  Any edit here must be copied back; any fix made live must be copied here.
- Modes: `"watch"` (measure only) → `"trim"` (digest tool outputs) → `"cached"` (full budgets).
  Default stays conservative; README documents the mode ladder.
- Decimals:
  - `estSaved` = chars diff ÷ 4.15, rounded, floored at 0.
  - Cached-mode tool digest delta uses full char diff (rewritten output).
  - Per-step `estSaved` never underestimates; conservative is the point.
- Ledger format: JSONL one row per step-finish, keys
  `ts, sessionID, taskID, messageID, model, cost, tokens{input,output,reasoning,cacheRead,cacheWrite,estSaved}`.
  `taskID` = originating user message id, so "saved on the last task" is a real number.
- TUI box order (stable): Context heading → tokens → % used → $ spent → ~tokens
  saved → % saved → ~tokens saved · last task. Tests grep these in raw captures.
- Emoji policy: minimal, only in this repo's own copy (not in the plugin source).

## Publish hygiene (public repo)
- `node_modules/`, `*.jsonl`, `.env.local` are gitignored — never `git add -f`.
- Before committing: `git status --porcelain --ignored` and verify no runtime or
  personal data is staged.
- Do not commit the test fixtures used offline (session JSONL in /tmp).