import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal } from "solid-js"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

const id = "tmiland-lab/opencode-token-min"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

interface LedgerRow {
  sessionID: string
  taskID?: string
  messageID: string
  tokens: { input?: number; output?: number; reasoning?: number; estSaved?: number; beforeTok?: number; afterTok?: number }
}

function ledgerPath(): string {
  const override = process.env["TOKEN_MIN_DIR"]
  if (override) return path.join(override, "token-usage.jsonl")
  const base =
    process.env["OPENCODE_DATA"] ??
    (process.platform === "darwin"
      ? path.join(process.env["HOME"] ?? "", "Library", "Application Support", "opencode")
      : process.platform === "win32"
        ? path.join(process.env["LOCALAPPDATA"] ?? "", "opencode")
        : path.join(process.env["XDG_DATA_HOME"] ?? path.join(process.env["HOME"] ?? "", ".local", "share"), "opencode"))
  return path.join(base, "token-usage.jsonl")
}

function sessionSaved(sessionID: string): { saved: number; before: number; after: number; lastTask: number; lastBefore: number; rows: number } {
  try {
    const file = ledgerPath()
    if (!existsSync(file)) return { saved: 0, before: 0, after: 0, lastTask: 0, lastBefore: 0, rows: 0 }
    const rows = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as LedgerRow
        } catch {
          return undefined
        }
      })
      .filter((x): x is LedgerRow => !!x && x.sessionID === sessionID)
    let saved = 0
    let before = 0
    let after = 0
    for (const row of rows) {
      saved += row.tokens.estSaved ?? 0
      before += row.tokens.beforeTok ?? 0
      after += row.tokens.afterTok ?? 0
    }
    const last = rows[rows.length - 1]
    const lastTaskID = last?.taskID ?? last?.messageID
    let lastTask = 0
    let lastBefore = 0
    if (lastTaskID) {
      for (const row of rows) {
        if ((row.taskID ?? row.messageID) === lastTaskID) {
          lastTask += row.tokens.estSaved ?? 0
          lastBefore += row.tokens.beforeTok ?? 0
        }
      }
    }
    return { saved, before, after, lastTask, lastBefore, rows: rows.length }
  } catch {
    return { saved: 0, before: 0, after: 0, lastTask: 0, lastBefore: 0, rows: 0 }
  }
}

const [version, setVersion] = createSignal(0)

const tui: TuiPlugin = async (api) => {
  api.event.on("message.part.updated", () => setVersion((value) => value + 1))
  api.event.on("message.updated", () => setVersion((value) => value + 1))

  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        const theme = () => api.theme.current
        const session = createMemo(() => api.state.session.get(props.session_id))
        const cost = createMemo(() => session()?.cost ?? 0)

        const saved = createMemo(() => {
          version()
          return sessionSaved(props.session_id)
        })

        const pct = (savedVal: number, before: number) =>
          before > 0 ? Math.min(100, Math.round((savedVal / before) * 100)) : 0

        return (
          <box>
          <text fg={theme().text}>
            <b>Savings</b>
          </text>
            <text fg={theme().textMuted}>~{saved().saved.toLocaleString()} tokens saved</text>
            <text fg={theme().textMuted}>
              {pct(saved().saved, saved().before)}% saved
            </text>
            <text fg={theme().textMuted}>
              ~{saved().lastTask.toLocaleString()} tokens saved · last task
            </text>
            <text fg={theme().textMuted}>
              {pct(saved().lastTask, saved().lastBefore)}% saved
            </text>
          </box>
        )
      },
    },
  })
}

const plugin: { id: string; tui: TuiPlugin } = { id, tui }

export default plugin