/**
 * Pure derivations for the telemetry overview: labels, per-day series, and
 * the handful of headline numbers. Kept out of the components so they are
 * easy to test and every view agrees on the definitions.
 */
import type { ObservabilitySummary, SessionUsage, SpanDetail } from '@/api/client'
import { isChatWorkspacePath } from '@/queries/useChatWorkspace'
import { pathBasename } from '@/utils/workspace'

/** Label for a workspace root; ``null`` is a turn recorded before v3.0.0. */
export function workspaceName(path: string | null): string {
  if (path === null) return 'Not recorded'
  if (isChatWorkspacePath(path)) return 'Chat'
  return pathBasename(path)
}

/** ``provider:model`` → the model part (provider shows in the tooltip). */
export function modelName(providerModel: string): string {
  const index = providerModel.indexOf(':')
  return index >= 0 ? providerModel.slice(index + 1) : providerModel
}

/** Display name for a ``by_session`` row: its title, else what it was. */
export function sessionName(row: Pick<SessionUsage, 'title' | 'deleted' | 'parent_session_id' | 'agent_name'>): string {
  if (row.title) return row.title
  if (row.deleted) return 'Deleted session'
  if (row.parent_session_id) return row.agent_name ? `${row.agent_name} sub-agent` : 'Sub-agent'
  return 'Untitled session'
}

export interface DayPoint {
  /** ``YYYY-MM-DD`` (UTC, matching the backend buckets). */
  day: string
  turns: number
  failed: number
  cost: number
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * One point per UTC day from the window start to its end, zero-filled so the
 * chart's x-axis is continuous even on quiet days.
 */
export function dailySeries(summary: ObservabilitySummary): DayPoint[] {
  const byDay = new Map(summary.daily_turns.map((d) => [d.day, d]))
  const start = new Date(summary.window_start)
  const end = new Date(summary.window_end)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return summary.daily_turns.map((d) => ({ day: d.day, turns: d.turns, failed: d.errors, cost: d.estimated_cost_usd ?? 0 }))
  }
  const points: DayPoint[] = []
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
  const last = utcDay(end)
  // Bounded by the 90-day API maximum; the guard only protects bad input.
  for (let i = 0; i < 400; i += 1) {
    const day = utcDay(cursor)
    const d = byDay.get(day)
    points.push({ day, turns: d?.turns ?? 0, failed: d?.errors ?? 0, cost: d?.estimated_cost_usd ?? 0 })
    if (day >= last) break
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return points
}

export interface Headline {
  spend: number
  spendPerTurn: number
  turns: number
  failedTurns: number
  turnP50: number
  turnP95: number
  inputTokens: number
  outputTokens: number
  cachePercent: number
  cachedTokens: number
}

export function headline(summary: ObservabilitySummary): Headline {
  const { totals, latency_ms: latency } = summary
  const failedTurns = summary.daily_turns.reduce((sum, d) => sum + d.errors, 0)
  return {
    spend: totals.estimated_cost_usd,
    spendPerTurn: totals.turns > 0 ? totals.estimated_cost_usd / totals.turns : 0,
    turns: totals.turns,
    failedTurns,
    turnP50: latency.turn_p50,
    turnP95: latency.turn_p95,
    inputTokens: totals.input_tokens,
    outputTokens: totals.output_tokens,
    cachePercent: totals.cache_percent,
    cachedTokens: totals.cached_tokens,
  }
}

/** Share of ``part`` in ``total`` as a 0–100 width, never NaN. */
export function sharePct(part: number, total: number): number {
  if (!(total > 0) || !(part > 0)) return 0
  return Math.min(100, (part / total) * 100)
}

/** Conversation id the backend records for runs outside a session. */
const NO_SESSION = 'no-session'
/** Mirrors the backend's ``WORKSPACE_ATTR`` on ``agent_run`` spans. */
const WORKSPACE_ATTR = 'openagentd.workspace'

function attrString(attrs: Record<string, unknown>, key: string): string | null {
  const value = attrs[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function attrNumber(attrs: Record<string, unknown>, key: string): number {
  const raw = attrs[key]
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : 0
}

export interface TraceSummary {
  startMs: number
  durationMs: number
  agentName: string | null
  /** ``undefined`` when the trace has no turn span; ``null`` when unrecorded. */
  workspace: string | null | undefined
  providerModel: string | null
  sessionId: string | null
  inputTokens: number
  outputTokens: number
  cost: number
  failed: boolean
}

/**
 * Header facts for one trace, computed from its spans with the same rules
 * as the backend's trace list: the ``agent_run`` span names the turn, and
 * usage sums over every other span (LLM calls, summarization, titles).
 */
export function traceSummary(spans: SpanDetail[]): TraceSummary {
  const run = spans.find((s) => s.name.startsWith('agent_run'))
  let startMs = Infinity
  let endMs = -Infinity
  let inputTokens = 0
  let outputTokens = 0
  let cost = 0
  for (const span of spans) {
    startMs = Math.min(startMs, span.start_ms)
    endMs = Math.max(endMs, span.end_ms)
    if (span === run) continue
    inputTokens += attrNumber(span.attributes, 'gen_ai.usage.input_tokens')
    outputTokens += attrNumber(span.attributes, 'gen_ai.usage.output_tokens')
    cost += attrNumber(span.attributes, 'gen_ai.usage.estimated_cost_usd')
  }
  const attrs = run?.attributes ?? {}
  const provider = attrString(attrs, 'gen_ai.provider.name')
  const model = attrString(attrs, 'gen_ai.request.model')
  const conversation = attrString(attrs, 'gen_ai.conversation.id')
  return {
    startMs: Number.isFinite(startMs) ? startMs : 0,
    durationMs: run ? run.duration_ms : Math.max(0, endMs - startMs),
    agentName: attrString(attrs, 'gen_ai.agent.name'),
    workspace: run ? attrString(attrs, WORKSPACE_ATTR) : undefined,
    providerModel: provider && model ? `${provider}:${model}` : model,
    sessionId: conversation && conversation !== NO_SESSION ? conversation : null,
    inputTokens,
    outputTokens,
    cost,
    failed: run ? run.status === 'ERROR' : spans.some((s) => s.status === 'ERROR'),
  }
}
