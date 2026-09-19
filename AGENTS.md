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
- `tui.json` — TUI plugin registration file (referenced by the README install step)
- `assets/token-min-overview.svg` — README illustration (re-render PNG via `magick`)

## Conventions (keep these synced)
- **These two files MUST stay in byte-sync with the live install:**
  `~/.config/opencode/plugins/token-min.ts` and `~/.config/opencode/tui/token-min.tsx`.
  Any edit here must be copied back; any fix made live must be copied here.
- Modes: `"auto"` (default; trims + digests) / `"watch"` (measure only, mutates
  nothing) / `"trim"` (same as auto) / `"cached"` (trims + widens budgets
  unconditionally). README documents the mode ladder.
- Decimals:
  - `estSaved` = `beforeTok - afterTok`, floored at 0. Each `*Tok` = chars ÷
    `CHARS_PER_TOKEN` (~4), rounded. Constrained by design (chars ≈ upper bound
    on tokens, never underestimates); conservative is the point.
  - Tool-digest delta uses full char diff (rewritten output). Digests are
    always on in auto/trim/cached; `watch` records chars only, mutates nothing.
- Ledger format: JSONL one row per step-finish, keys
  `ts, sessionID, taskID, messageID, model, cost, tokens{input,output,reasoning,cacheRead,cacheWrite,estSaved,beforeTok,afterTok}`.
  `taskID` = originating user message id, so "saved on the last task" is a real number.
- TUI box order (stable): Context heading → tokens → % used → $ spent → ~tokens
  saved → % saved → ~tokens saved · last task → % saved (last task). Tests grep
  these in raw captures.
- Emoji policy: minimal, only in this repo's own copy (not in the plugin source).

## Publish hygiene (public repo)
- `node_modules/`, `*.jsonl`, `.env.local` are gitignored — never `git add -f`.
- Before committing: `git status --porcelain --ignored` and verify no runtime or
  personal data is staged.
- Do not commit the test fixtures used offline (session JSONL in /tmp).