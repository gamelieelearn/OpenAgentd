/**
 * OpenAgentd API client — observability group: /observability + traces.
 */

import { apiBaseUrl } from '../base-url'

/**
 * Optional narrowing for summary and trace-list requests. Filters apply per
 * turn on the backend: a span counts toward the workspace and model of the
 * turn (``agent_run`` span) it belongs to.
 */
export interface ObservabilityFilters {
  /** Workspace root as recorded on spans (see ``facets.workspaces``). */
  workspace?: string | null
  /** ``provider:model`` (see ``facets.models``). */
  model?: string | null
  /** Session id (see ``by_session``); the backend adds its sub-agent sessions. */
  session?: string | null
}

function filterParams(params: URLSearchParams, filters: ObservabilityFilters | undefined): URLSearchParams {
  if (filters?.workspace) params.set('workspace', filters.workspace)
  if (filters?.model) params.set('model', filters.model)
  if (filters?.session) params.set('session', filters.session)
  return params
}

/** One session in ``by_session`` (top 100 by spend). */
export interface SessionUsage {
  session_id: string
  /** Workspace, model, and agent of the session's latest turn. */
  workspace: string | null
  model: string | null
  agent_name: string | null
  turns: number
  errors: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  cache_percent: number
  estimated_cost_usd: number
  last_active_ms: number
  /** From the database at request time; ``null`` when untitled or deleted. */
  title?: string | null
  parent_session_id?: string | null
  /** The session no longer exists (its spans outlive it). */
  deleted?: boolean
}

export interface ObservabilitySummary {
  window_start: string
  window_end: string
  sample_ratio: number
  totals: {
    turns: number
    llm_calls: number
    tool_calls: number
    input_tokens: number
    output_tokens: number
    cached_tokens: number
    cache_write_tokens: number
    cache_percent: number
    estimated_cost_usd: number
    errors: number
  }
  latency_ms: {
    turn_p50: number
    turn_p95: number
    llm_p50: number
    llm_p95: number
  }
  daily_turns: Array<{
    day: string
    turns: number
    errors: number
    /** Absent on backends older than v3.0.0. */
    estimated_cost_usd?: number
  }>
  by_model: Array<{
    provider: string
    model: string
    provider_model: string
    calls: number
    input_tokens: number
    output_tokens: number
    cached_tokens: number
    cache_write_tokens: number
    cache_percent: number
    estimated_cost_usd: number
    p95_ms: number
  }>
  cache_by_step: Array<{
    step: string
    provider: string
    model: string
    provider_model: string
    calls: number
    input_tokens: number
    cached_tokens: number
    cache_write_tokens: number
    miss_tokens: number
    cache_percent: number
    estimated_cost_usd: number
  }>
  by_tool: Array<{ tool: string; calls: number; errors: number; p95_ms: number }>
  /**
   * Spend and turns per workspace; ``workspace: null`` collects turns recorded
   * before spans carried a workspace. Absent on backends older than v3.0.0.
   */
  by_workspace?: Array<{
    workspace: string | null
    turns: number
    errors: number
    input_tokens: number
    output_tokens: number
    estimated_cost_usd: number
  }>
  /** Spend and usage per session, most expensive first. Absent before v3.0.0. */
  by_session?: SessionUsage[]
  /** Filter options for the whole window, most-used first. */
  facets?: { workspaces: string[]; models: string[] }
}

export async function getObservabilitySummary(
  days: number,
  filters?: ObservabilityFilters,
): Promise<ObservabilitySummary> {
  const params = filterParams(new URLSearchParams({ days: String(days) }), filters)
  const res = await fetch(`${apiBaseUrl()}/observability/summary?${params}`)
  if (!res.ok) throw new Error(`GET /observability/summary failed: ${res.status}`)
  return res.json()
}

// ── /observability/traces ────────────────────────────────────────────────────

/** One turn in the traces-list view — shape mirrors backend `TraceListItem`. */
export interface TraceListItem {
  trace_id: string
  span_id: string
  run_id: string | null
  session_id: string | null
  agent_name: string | null
  /** Absent on backends older than v3.0.0; ``null`` for unrecorded turns. */
  workspace?: string | null
  provider: string | null
  model: string | null
  provider_model: string | null
  start_ms: number
  end_ms: number
  duration_ms: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  estimated_cost_usd: number
  llm_calls: number
  tool_calls: number
  error: boolean
}

export interface TracesListResponse {
  traces: TraceListItem[]
  limit: number
  offset: number
  total: number
  has_next: boolean
}

/** One span inside a trace — shape mirrors backend `SpanDetail`. */
export interface SpanDetail {
  span_id: string
  parent_span_id: string | null
  trace_id: string
  name: string
  kind: string
  start_ms: number
  end_ms: number
  duration_ms: number
  status: string
  attributes: Record<string, unknown>
}

export interface TraceDetailResponse {
  trace_id: string
  spans: SpanDetail[]
}

export async function listTraces(
  days: number,
  limit = 50,
  offset = 0,
  filters?: ObservabilityFilters & { errorsOnly?: boolean },
): Promise<TracesListResponse> {
  const params = filterParams(
    new URLSearchParams({ days: String(days), limit: String(limit), offset: String(offset) }),
    filters,
  )
  if (filters?.errorsOnly) params.set('status', 'error')
  const res = await fetch(`${apiBaseUrl()}/observability/traces?${params}`)
  if (!res.ok) throw new Error(`GET /observability/traces failed: ${res.status}`)
  return res.json()
}

/**
 * Fetch every span for a given trace id.  Returns `null` when the trace
 * was not found (404 — expired by retention or typo).
 */
export async function getTraceDetail(
  traceId: string,
  days = 30,
): Promise<TraceDetailResponse | null> {
  const res = await fetch(
    `${apiBaseUrl()}/observability/traces/${encodeURIComponent(traceId)}?days=${days}`,
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET /observability/traces/:id failed: ${res.status}`)
  return res.json()
}
