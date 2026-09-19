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
- `bun run check` — the npm-entry syntax checks (`src/server.ts` + `tui/token-min.tsx`)
- `npm pack --dry-run` — verify tarball contents before publishing
- `npm publish` — publish `opencode-token-min` (unscoped ⇒ public)
- No test suite; verification is a live `opencode /tui --dev` against a long session

## Layout
- `plugins/token-min.ts` — server plugin (transform hook, ledger, `cost` tool)
- `tui/token-min.tsx` — sidebar plugin (reads `token-usage.jsonl`)
- `src/server.ts` — npm entry wrapper: `export default { id, server: plugin }`,
  the `./server` / `"."` / `./tui` exports target this + `tui/token-min.tsx`
- `tui.json` — TUI plugin registration file (referenced by the README install step)
- `assets/token-min-overview.svg` — README illustration (re-render PNG via `magick`)

## Conventions (keep these synced)
- **These two files MUST stay in byte-sync with the live install:**
  `~/.config/opencode/plugins/token-min.ts` and `~/.config/opencode/tui/token-min.tsx`.
  Any edit here must be copied back; any fix made live must be copied here.
- npm shape: `plugin` for the npm `./server` entry MUST remain the default-export
  object `{ id, server }` in `src/server.ts` — the live-install
  `plugins/token-min.ts` keeps exporting the bare function, and the wrapper maps
  it. Only touches the wrapper; the synced files stay as they are.
- Modes: `"auto"` (default; trims + digests) / `"watch"` (measure only, mutates
  nothing) / `"trim"` (same as auto) / `"cached"` (trims + widens budgets
  unconditionally). README documents the mode ladder.
- Decimals:
  - `estSaved` = `beforeTok - afterTok`, floored at 0. Each `*Tok` = chars ÷
    `CHARS_PER_TOKEN` (~4), rounded. Constrained by design (chars ≈ upper bound
    on tokens, never underestimates); conservative is the point.
  - TUI `% saved` = `ΣestSaved / ΣbeforeTok` (summed over the session's ledger
    rows; same shape for the last-task line). Never `estSaved / (estSaved +
    live-message tokens)` — that conflates trimmed context with the last
    message's usage and inflates toward 100%.
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

## Publish procedure (npm)
- Install path users run: `opencode plugin opencode-token-min --global`.
  Verified against opencode 1.18.31: the loader resolves `exports["./server"]`
  (default export `{ id, server }`) and `exports["./tui"]` (`{ id, tui }`) —
  install writes the bare package name into both `opencode.json` and `tui.json`.
- Pre-flight before publish: `npm pack --dry-run` (8 files: LICENSE, README,
  assets ×2, package.json, plugins/, src/, tui/) then `git status
  --porcelain --ignored` clean.
- Publish with `npm publish` (unscoped → public, no `--access`).
- After publishing, sanity-check the freshly installed plugin in a throwaway
  project (`opencode plugin opencode-token-min` in /tmp) before neatening up.