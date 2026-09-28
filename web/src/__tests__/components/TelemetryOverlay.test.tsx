/**
 * TelemetryOverlay — the root-mounted shell: open/close through the stores,
 * Escape steps out of a trace before closing, and "Open session" leaves the
 * overlay for the session route.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const navigate = mock(() => Promise.resolve())
mock.module('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import { TelemetryOverlay } from '@/components/Telemetry/TelemetryOverlay'
import { openTelemetry, useTelemetryStore } from '@/stores/useTelemetryStore'
import { useUIStore } from '@/stores/useUIStore'

const API = 'http://localhost/api/observability'
const server = setupServer(
  http.get(`${API}/summary`, () => HttpResponse.json({
    window_start: '2026-05-21T00:00:00Z',
    window_end: '2026-05-28T00:00:00Z',
    sample_ratio: 1,
    totals: { turns: 0, llm_calls: 0, tool_calls: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, cache_percent: 0, estimated_cost_usd: 0, errors: 0 },
    latency_ms: { turn_p50: 0, turn_p95: 0, llm_p50: 0, llm_p95: 0 },
    daily_turns: [],
    by_model: [],
    cache_by_step: [],
    by_tool: [],
  })),
  http.get(`${API}/traces`, () => HttpResponse.json({ traces: [], limit: 25, offset: 0, total: 0, has_next: false })),
  http.get(`${API}/traces/:id`, ({ params }) => HttpResponse.json({
    trace_id: params.id,
    spans: [{
      span_id: 'run',
      parent_span_id: null,
      trace_id: params.id,
      name: 'agent_run lead',
      kind: 'INTERNAL',
      start_ms: 1_700_000_000_000,
      end_ms: 1_700_000_001_000,
      duration_ms: 1000,
      status: 'OK',
      attributes: { 'gen_ai.conversation.id': 'sess-9' },
    }],
  })),
)
let originalFetch: typeof fetch | undefined

beforeEach(() => {
  server.listen({ onUnhandledRequest: 'error' })
  originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch?.(`http://localhost${input}`, init) ?? Promise.reject(new Error('fetch unavailable'))
    }
    return originalFetch?.(input, init) ?? Promise.reject(new Error('fetch unavailable'))
  }) as typeof fetch
  navigate.mockClear()
})

afterEach(() => {
  cleanup()
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
  useUIStore.setState({ telemetryOpen: false })
  useTelemetryStore.setState({ days: 7, workspace: null, model: null, session: null, errorsOnly: false, traceId: null })
  localStorage.removeItem('oa.telemetry.v1')
})

function renderOverlay() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TelemetryOverlay />
    </QueryClientProvider>,
  )
}

describe('TelemetryOverlay', () => {
  it('renders nothing until opened, then the overview', async () => {
    renderOverlay()
    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => openTelemetry())
    expect(screen.getByRole('dialog', { name: 'Telemetry' })).toBeTruthy()
    expect(await screen.findByText('No telemetry yet')).toBeTruthy()
  })

  it('Escape closes the overview', async () => {
    renderOverlay()
    act(() => openTelemetry())
    await screen.findByText('No telemetry yet')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useUIStore.getState().telemetryOpen).toBe(false)
  })

  it('Escape and Back leave a trace before closing', async () => {
    const user = userEvent.setup()
    renderOverlay()
    act(() => openTelemetry({ traceId: 'trace-9' }))
    expect(screen.getByRole('heading', { name: 'Turn trace' })).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useTelemetryStore.getState().traceId).toBeNull()
    expect(useUIStore.getState().telemetryOpen).toBe(true)

    act(() => useTelemetryStore.getState().openTrace('trace-9'))
    await user.click(screen.getByRole('button', { name: 'Back to overview' }))
    expect(useTelemetryStore.getState().traceId).toBeNull()
    expect(screen.getByRole('heading', { name: 'Telemetry' })).toBeTruthy()
  })

  it('the close button closes from any view', async () => {
    const user = userEvent.setup()
    renderOverlay()
    act(() => openTelemetry({ traceId: 'trace-9' }))
    await user.click(screen.getByRole('button', { name: 'Close telemetry' }))
    expect(useUIStore.getState().telemetryOpen).toBe(false)
  })

  it('"Open session" closes the overlay and routes to the session', async () => {
    const user = userEvent.setup()
    renderOverlay()
    act(() => openTelemetry({ traceId: 'trace-9' }))

    await user.click(await screen.findByRole('button', { name: 'Open session' }))
    expect(useUIStore.getState().telemetryOpen).toBe(false)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 'sess-9' } }))
  })
})
