import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { tool } from "@opencode-ai/plugin"
import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"

const LOG = (process.env["TOKEN_MIN_LOG"] ?? "").toLowerCase() === "1" || (process.env["TOKEN_MIN_LOG"] ?? "").toLowerCase() === "true"

const num = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const MODE = (process.env["TOKEN_MIN_MODE"] ?? "auto").toLowerCase()

const MAX_USER = num("TOKEN_MIN_MAX_USER", 12)
const MAX_ASSISTANT = num("TOKEN_MIN_MAX_ASSISTANT", 12)
const MAX_TOOL = num("TOKEN_MIN_MAX_TOOL", 12)
const MAX_TOTAL = num("TOKEN_MIN_MAX_TOTAL", 30)
const MAX_TOTAL_CACHED = num("TOKEN_MIN_MAX_TOTAL_CACHED", 60)
const PRESERVE_FIRST = num("TOKEN_MIN_PRESERVE_FIRST", 3)
const MIN_KEEP = num("TOKEN_MIN_MIN_KEEP", 2)
const OLD_MULT = num("TOKEN_MIN_OLD_MULT", 2)
const CACHED_MULT = num("TOKEN_MIN_CACHED_MULT", Math.max(1, Math.round(MAX_TOTAL_CACHED / MAX_TOTAL)))
const CHARS_PER_TOKEN = num("TOKEN_MIN_CHARS_PER_TOKEN", 4)
const KEEP_TAIL_MSGS = num("TOKEN_MIN_KEEP_TAIL_MSGS", 4)
const TOOL_DIGEST_BYTES = num("TOKEN_MIN_TOOL_DIGEST_BYTES", 4000)
const TOOL_DIGEST_HEAD = num("TOKEN_MIN_TOOL_DIGEST_HEAD", 800)
const TOOL_DIGEST_TAIL = num("TOKEN_MIN_TOOL_DIGEST_TAIL", 800)

type CacheState = "unknown" | "cached" | "no-cache"

const sessionCache = new Map<string, { state: CacheState; steps: number; zeroSteps: number }>()
const pending = new Map<string, { beforeChars: number; afterChars: number; beforeMsgs: number; afterMsgs: number; shrunkTools: number }>()

function defaultDataDir(): string {
  const override = process.env["OPENCODE_DATA"]
  if (override) return override
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "opencode")
  if (process.platform === "win32") {
    const base = process.env["LOCALAPPDATA"] ?? process.env["APPDATA"] ?? path.join(os.homedir(), "AppData", "Local")
    return path.join(base, "opencode")
  }
  return path.join(process.env["XDG_DATA_HOME"] ?? path.join(os.homedir(), ".local", "share"), "opencode")
}

const dataDir = process.env["TOKEN_MIN_DIR"] ?? defaultDataDir()
const ledgerPath = path.join(dataDir, "token-usage.jsonl")

interface StepTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  estSaved: number
  beforeTok: number
  afterTok: number
}

interface StepRecord {
  ts: number
  sessionID: string
  taskID: string
  messageID: string
  model: string
  cost: number
  tokens: StepTokens
}

function ensureLedger() {
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  } catch (e) {
    console.log(`[token-min] ledger dir unavailable: ${(e as Error).message}`)
  }
}

function appendRecord(record: StepRecord) {
  ensureLedger()
  try {
    appendFileSync(ledgerPath, JSON.stringify(record) + "\n")
  } catch (e) {
    console.log(`[token-min] ledger append failed: ${(e as Error).message}`)
  }
}

function readLedger(): StepRecord[] {
  try {
    if (!existsSync(ledgerPath)) return []
    return readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as StepRecord
        } catch {
          return undefined
        }
      })
      .filter((x): x is StepRecord => !!x)
  } catch (e) {
    console.log(`[token-min] ledger read failed: ${(e as Error).message}`)
    return []
  }
}

function addTokens(a: StepTokens, b: StepTokens): StepTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    estSaved: a.estSaved + b.estSaved,
    beforeTok: a.beforeTok + b.beforeTok,
    afterTok: a.afterTok + b.afterTok,
  }
}

function formatTokens(t: StepTokens): string {
  return `${t.input.toLocaleString()}/${t.output.toLocaleString()} in/out (+${t.reasoning.toLocaleString()} reasoning, ${t.cacheRead.toLocaleString()} cached-in, ~${t.estSaved.toLocaleString()} saved)`
}

const sessionModels = new Map<string, string>()
const sessionTools = new Map<string, Set<string>>()
const sessionTotals = new Map<string, { cost: number; tokens: StepTokens }>()
const sessionTaskID = new Map<string, string | undefined>()

const zeroTokens = (): StepTokens => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, estSaved: 0, beforeTok: 0, afterTok: 0 })

function sessionTotal(sessionID: string) {
  return sessionTotals.get(sessionID) ?? { cost: 0, tokens: zeroTokens() }
}

function todayTotal() {
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  let cost = 0
  let tokens = zeroTokens()
  for (const rec of readLedger()) {
    if (rec.ts >= startOfDay.getTime()) {
      cost += rec.cost
      tokens = addTokens(tokens, rec.tokens)
    }
  }
  return { cost, tokens }
}

function allTimeTotal() {
  let cost = 0
  let tokens = zeroTokens()
  for (const rec of readLedger()) {
    cost += rec.cost
    tokens = addTokens(tokens, rec.tokens)
  }
  return { cost, tokens }
}

function trackCache(sessionID: string, cacheRead: number) {
  const cur = sessionCache.get(sessionID) ?? { state: "unknown" as CacheState, steps: 0, zeroSteps: 0 }
  cur.steps++
  if (cacheRead > 0) {
    cur.state = "cached"
    cur.zeroSteps = 0
  } else {
    cur.zeroSteps++
    if (cur.state !== "cached" && cur.zeroSteps >= 3) cur.state = "no-cache"
  }
  sessionCache.set(sessionID, cur)
}

function cacheState(sessionID: string): CacheState {
  return sessionCache.get(sessionID)?.state ?? "unknown"
}

function roughChars(messages: { info: { role: string }; parts: unknown[] }[]): number {
  let chars = 0
  for (const m of messages) {
    chars += 32
    for (const p of m.parts as { text?: string; reasoning?: string; state?: { completed?: { output?: string } } }[]) {
      if (typeof p.text === "string") chars += p.text.length
      else if (typeof p.reasoning === "string") chars += p.reasoning.length
      else if (p.state?.completed?.output) chars += p.state.completed.output.length
      else chars += 64
    }
  }
  return chars
}

interface DigestedPart {
  tool?: string
  state?: {
    status?: string
    output?: string
    metadata?: { outputPath?: string; title?: string }
  }
}

function digestOldToolOutputs(messages: { info: { role: string }; parts: DigestedPart[] }[], keepTail: number): number {
  let shrunk = 0
  if (messages.length > keepTail) {
    const cutoff = messages.length - keepTail
    for (let i = 0; i < cutoff; i++) {
      for (const p of messages[i].parts ?? []) {
        const s = p?.state
        if (p?.tool && s?.status === "completed" && typeof s.output === "string" && s.output.length > TOOL_DIGEST_BYTES) {
          const full = s.output
          const outPath = s.metadata?.outputPath
          const head = full.slice(0, TOOL_DIGEST_HEAD)
          const tail = full.slice(-TOOL_DIGEST_TAIL)
          const note = outPath
            ? `[token-min] truncated ${full.length} chars; full output saved at: ${outPath}`
            : `[token-min] truncated ${full.length} chars`
          s.output = `${head}\n\n[... ${note} ...]\n\n${tail}`
          shrunk++
        }
      }
    }
  }
  return shrunk
}

function trimMessages(sessionID: string, messages: { info: { role: string }; parts: unknown[] }[]) {
  if (!Array.isArray(messages)) return
  if (messages.length === 0) return
  for (const m of messages) {
    if (!m || typeof m !== "object" || !m.info || typeof m.info.role !== "string" || !Array.isArray(m.parts)) return
  }
  if (messages.length <= MIN_KEEP) return

  const beforeChars = roughChars(messages)
  const beforeMsgs = messages.length
  let shrunkTools = 0

  const state = cacheState(sessionID)

  if (MODE === "watch") {
    return
  }

  const cached = state === "cached" || MODE === "cached"
  const mult = cached ? CACHED_MULT : state === "unknown" ? OLD_MULT : 1
  const roles: Record<string, number> = {
    user: MAX_USER * mult,
    assistant: MAX_ASSISTANT * mult,
    tool: MAX_TOOL * mult,
  }
  const totalCap = cached ? MAX_TOTAL_CACHED : state === "unknown" ? MAX_TOTAL * OLD_MULT : MAX_TOTAL

  // Digest oversized tool outputs first: application code, captures, and build
  // logs balloon the context even when the message count stays small, so this
  // is where most real savings come from in warm-cache sessions. Always on.
  shrunkTools = digestOldToolOutputs(messages as unknown as { info: { role: string }; parts: DigestedPart[] }[], KEEP_TAIL_MSGS)

  const preserved = messages.slice(0, Math.min(PRESERVE_FIRST, messages.length))
  const keptTail: { info: { role: string }; parts: unknown[] }[] = []
  const counts = { user: 0, assistant: 0, tool: 0 }

  for (let i = messages.length - 1; i >= PRESERVE_FIRST; i--) {
    const role = messages[i].info.role
    const cap = roles[role] ?? Number.POSITIVE_INFINITY
    if (counts[role as keyof typeof counts] !== undefined && counts[role as keyof typeof counts] >= cap) continue
    if (keptTail.length + preserved.length >= totalCap) break
    if (counts[role as keyof typeof counts] !== undefined) counts[role as keyof typeof counts]++
    keptTail.unshift(messages[i])
  }

  const kept = [...preserved, ...keptTail]
  messages.splice(0, messages.length, ...kept)

  const afterChars = roughChars(messages)
  pending.set(sessionID, { beforeChars, afterChars, beforeMsgs, afterMsgs: messages.length, shrunkTools })
}

export async function plugin(_input: PluginInput, _options: PluginOptions): Promise<Hooks> {
  if (LOG) {
    console.log(`[token-min] mode=${MODE} user=${MAX_USER} assistant=${MAX_ASSISTANT} tool=${MAX_TOOL} total=${MAX_TOTAL} cached_total=${MAX_TOTAL_CACHED} preserve=${PRESERVE_FIRST} min=${MIN_KEEP} old_mult=${OLD_MULT} ingest_digest=${TOOL_DIGEST_BYTES}B`)
    console.log(`[token-min] ledger: ${ledgerPath}`)
  }

  for (const rec of readLedger()) {
    if (rec.model !== "unknown" && !sessionModels.has(rec.sessionID)) sessionModels.set(rec.sessionID, rec.model)
    const tools = sessionTools.get(rec.sessionID)
    if (tools) {
      tools.add(rec.messageID)
    } else {
      sessionTools.set(rec.sessionID, new Set([rec.messageID]))
    }
  }

  return {
    async "experimental.chat.messages.transform"(_input, output) {
      try {
        let sessionID = "unknown"
        const last = output.messages?.[output.messages.length - 1] as { info?: { sessionID?: string } } | undefined
        if (last?.info?.sessionID) sessionID = last.info.sessionID
        if (MODE !== "watch") trimMessages(sessionID, output.messages)
      } catch (e) {
        console.log(`[token-min] transform skipped: ${(e as Error).message}`)
      }
    },

    async event({ event }) {
      try {
        if (event.type === "message.updated") {
          const props = event.properties as { sessionID?: string; info?: { role?: string; modelID?: string; providerID?: string; id?: string } } | undefined
          const sessionID = props?.sessionID
          const info = props?.info
          if (sessionID && info && info.role === "assistant" && (info.providerID || info.modelID)) {
            sessionModels.set(sessionID, [info.providerID, info.modelID].filter(Boolean).join("/"))
          }
          if (sessionID && info && info.role === "user" && info.id) {
            sessionTaskID.set(sessionID, info.id)
          }
        } else if (event.type === "message.part.updated") {
          const part = (event.properties as { part?: { type?: string; sessionID?: string; messageID?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } } }).part
          if (part?.type === "step-finish") {
            const { sessionID, messageID } = part
            const cost = part.cost ?? 0
            const t = part.tokens ?? {}
            const cacheRead = t.cache?.read ?? 0
            const pend = pending.get(sessionID)
            let beforeTok = 0
            let afterTok = 0
            let estSaved = 0
            let savedPct = 0
            if (pend && pend.beforeChars > 0) {
              beforeTok = Math.max(0, Math.round(pend.beforeChars / CHARS_PER_TOKEN))
              afterTok = Math.max(0, Math.round(pend.afterChars / CHARS_PER_TOKEN))
              estSaved = beforeTok - afterTok
              if (estSaved > 0) savedPct = Math.round((estSaved / beforeTok) * 100)
            }
            const tokens: StepTokens = {
              input: t.input ?? 0,
              output: t.output ?? 0,
              reasoning: t.reasoning ?? 0,
              cacheRead,
              cacheWrite: t.cache?.write ?? 0,
              estSaved: Math.max(0, estSaved),
              beforeTok,
              afterTok,
            }

            trackCache(sessionID, cacheRead)
            pending.delete(sessionID)

            const prev = sessionTotals.get(sessionID)
            const next = prev
              ? { cost: prev.cost + cost, tokens: addTokens(prev.tokens, tokens) }
              : { cost, tokens }
            sessionTotals.set(sessionID, next)
            const rec: StepRecord = { ts: Date.now(), sessionID, taskID: sessionTaskID.get(sessionID) ?? messageID, messageID, model: sessionModels.get(sessionID) ?? "unknown", cost, tokens }
            appendRecord(rec)

            const mode = cacheState(sessionID)
            const model = sessionModels.get(sessionID)
            const savedParts: string[] = []
            if (pend) {
              if (estSaved > 0) savedParts.push(`trimmed ~${estSaved.toLocaleString()} tok (${savedPct}%)`)
              if (pend.beforeMsgs > pend.afterMsgs) savedParts.push(`${pend.beforeMsgs - pend.afterMsgs} msgs dropped`)
              if (pend.shrunkTools > 0) savedParts.push(`${pend.shrunkTools} tool outputs digested`)
            }
            if (cacheRead > 0) savedParts.push(`cache-read ${cacheRead.toLocaleString()} tok`)
            const savings = savedParts.length > 0 ? ` · ${savedParts.join(" · ")}` : ""
            const money = cost > 0 ? ` · $${cost.toFixed(4)}` : ""
            if (LOG) console.log(`[token-min] [${mode}] ${model ? model + " · " : ""}used ${tokens.input.toLocaleString()}/${tokens.output.toLocaleString()} in/out · session total ${next.tokens.input.toLocaleString()}/${next.tokens.output.toLocaleString()}${savings}${money}`)
          }
        }
      } catch (e) {
        console.log(`[token-min] event error: ${(e as Error).message}`)
      }
    },

    tool: {
      cost: tool({
        description:
          "Report accumulated token usage, cost, and estimated savings from the token-min plugin. Returns current session totals, today's totals across all sessions, and all-time totals.",
        args: {},
        async execute(_args, context) {
          const sessionId = context.sessionID
          const s = sessionTotal(sessionId)
          const today = todayTotal()
          const all = allTimeTotal()
          const recs = readLedger()
          const known = sessionModels.get(sessionId) ?? "unknown"
          const money = (cost: number) => (cost > 0 ? `$${cost.toFixed(4)}` : "n/a (cost not reported by provider)")
          return `Token usage (token-min plugin)
Session (${sessionId}) model=${known}:
  cost: ${money(s.cost)}
  tokens: ${formatTokens(s.tokens)}

Today (all sessions):
  cost: ${money(today.cost)}
  tokens: ${formatTokens(today.tokens)}

All-time:
  cost: ${money(all.cost)}
  tokens: ${formatTokens(all.tokens)}

Note: "saved" combines tool-output digests, message trimming, and on caching providers the estimated prefix reuse. Est. savings are approximate (chars/token heuristic).`
        },
      }),
    },

    async dispose() {
      console.log("[token-min] disposed")
    },
  }
}