import { apiBaseUrl } from './base-url'
import { apiAuthHeaders } from './auth'
import { readSSE } from './sse'
import type { SSECallbacks } from './sse'

/**
 * Events on the app-lifetime feed (`/events/stream`). Must match
 * `global_stream` in `appv3/contract/sse_events.json` (enforced by
 * `sse-contract.test.ts`).
 */
export const GLOBAL_EVENT_TYPES = [
  'session_turn_started',
  'session_turn_completed',
  'title_update',
  'desktop_notification',
  'subagent_spawned',
  'subagent_status',
  'workspace_files_changed',
  'config_changed',
  'mcp_status_changed',
  'lsp_install_required',
] as const

export type GlobalEventType = (typeof GLOBAL_EVENT_TYPES)[number]

export interface GlobalEventCallbacks extends SSECallbacks {
  onOpen?: () => void
}

/** Open the app-lifetime event feed used by first-party clients. */
export function globalEventStream(callbacks: GlobalEventCallbacks, signal?: AbortSignal): void {
  const url = `${apiBaseUrl()}/events/stream`
  fetch(url, { signal, headers: apiAuthHeaders(url) })
    .then((res) => {
      if (!res.ok) throw new Error(`GET /events/stream failed: ${res.status}`)
      callbacks.onOpen?.()
      readSSE(res, callbacks)
    })
    .catch((err) => { if (err.name !== 'AbortError') callbacks.onError?.(err) })
}
