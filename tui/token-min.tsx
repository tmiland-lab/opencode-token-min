import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal } from "solid-js"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

const id = "token-min:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

interface LedgerRow {
  sessionID: string
  taskID?: string
  messageID: string
  tokens: { input?: number; output?: number; reasoning?: number; estSaved?: number }
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

function sessionSaved(sessionID: string): { saved: number; lastTask: number; latest?: LedgerRow } {
  try {
    const file = ledgerPath()
    if (!existsSync(file)) return { saved: 0, lastTask: 0 }
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
    for (const row of rows) saved += row.tokens.estSaved ?? 0
    const last = rows[rows.length - 1]
    const lastTaskID = last?.taskID ?? last?.messageID
    let lastTask = 0
    if (lastTaskID) {
      for (const row of rows) {
        if ((row.taskID ?? row.messageID) === lastTaskID) lastTask += row.tokens.estSaved ?? 0
      }
    }
    return { saved, lastTask, latest: last }
  } catch {
    return { saved: 0, lastTask: 0 }
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
        const msg = createMemo(() => api.state.session.messages(props.session_id))
        const session = createMemo(() => api.state.session.get(props.session_id))
        const cost = createMemo(() => session()?.cost ?? 0)

        const state = createMemo(() => {
          const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
          if (!last) {
            return { tokens: 0, percent: null }
          }
          const tokens =
            last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
          const model = api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
          return {
            tokens,
            percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
          }
        })

        const saved = createMemo(() => {
          version()
          return sessionSaved(props.session_id)
        })

        return (
          <box>
            <text fg={theme().text}>
              <b>Context</b>
            </text>
            <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
            <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
            <text fg={theme().textMuted}>{money.format(cost())} spent</text>
            {saved().saved > 0 ? (
              <text fg={theme().textMuted}>~{saved().saved.toLocaleString()} tokens saved</text>
            ) : null}
            {saved().saved > 0 && state().tokens > 0 ? (
              <text fg={theme().textMuted}>
                {Math.round((saved().saved / (saved().saved + state().tokens)) * 100)}% saved
              </text>
            ) : null}
            {saved().lastTask > 0 ? (
              <text fg={theme().textMuted}>~{saved().lastTask.toLocaleString()} tokens saved · last task</text>
            ) : null}
          </box>
        )
      },
    },
  })
}

const plugin: { id: string; tui: TuiPlugin } = { id, tui }

export default plugin