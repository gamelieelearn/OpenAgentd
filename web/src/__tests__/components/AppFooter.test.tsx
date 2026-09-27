import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppFooter } from '@/components/AppFooter'
import { useTelemetryStore } from '@/stores/useTelemetryStore'
import { useUIStore } from '@/stores/useUIStore'
import { queryKeys } from '@/queries/keys'

const navigate = mock(() => Promise.resolve())
mock.module('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
const mockOpenSettings = mock(() => {})
const mockPreloadSettings = mock(() => {})
const mockPreloadTelemetry = mock(() => {})
mock.module('@/components/settings/page-loaders', () => ({ preloadSettings: mockPreloadSettings }))
mock.module('@/components/Telemetry/telemetry-loader', () => ({ preloadTelemetryView: mockPreloadTelemetry }))

// ``getState`` too: opening telemetry closes Settings through the UI store,
// which calls back into this module.
mock.module('@/stores/useSettingsStore', () => {
  const state = { openSettings: mockOpenSettings, closeSettings: () => {} }
  return {
    useSettingsStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  }
})

let healthError = false
let backendExternal = false
mock.module('@/queries/useHealthQuery', () => ({
  useHealthQuery: () => ({ isSuccess: !healthError, isError: healthError, isLoading: false }),
  useBackendStatusQuery: () => ({
    data: {
      mode: backendExternal ? 'external' : 'bundled',
      base_url: backendExternal ? 'https://agents.example.com' : 'http://127.0.0.1:4082',
      sidecar_running: true,
      external: backendExternal,
      supports_bundled: true,
      servers: [],
    },
    isSuccess: true,
  }),
}))

function renderWithQueryClient(ui: React.ReactElement, spendUsd?: number) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  if (spendUsd !== undefined) {
    client.setQueryData(queryKeys.observability.summary(1, { workspace: null, model: null, session: null }), {
      totals: { estimated_cost_usd: spendUsd },
    })
  }
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('AppFooter', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    mockOpenSettings.mockClear()
    mockPreloadSettings.mockClear()
    mockPreloadTelemetry.mockClear()
    healthError = false
    backendExternal = false
    // The spend summary stays pending unless a test seeds it.
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('starts loading the Settings and Telemetry chunks on pointer or focus intent', () => {
    renderWithQueryClient(<AppFooter />, 1.5)

    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Settings' }))
    expect(mockPreloadSettings).toHaveBeenCalledTimes(1)
    fireEvent.focus(screen.getByRole('button', { name: /Spend in the last 24 hours/ }))
    expect(mockPreloadTelemetry).toHaveBeenCalledTimes(1)
  })

  it('leaves a healthy bundled backend out of the status bar', () => {
    renderWithQueryClient(<AppFooter />)
    expect(screen.getByRole('status', { name: 'Application status' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Change backend connection/ })).toBeNull()
  })

  it('shows the backend indicator for an external server', () => {
    backendExternal = true
    renderWithQueryClient(<AppFooter />)
    expect(screen.getByRole('button', { name: /Connected\. Change backend connection/ })).toBeTruthy()
  })

  it('shows the backend indicator when the backend is unhealthy', () => {
    healthError = true
    renderWithQueryClient(<AppFooter />)
    expect(screen.getByRole('button', { name: /Backend error\. Change backend connection/ })).toBeTruthy()
  })

  it('renders model name and thinking level when provided and triggers session settings', async () => {
    const user = userEvent.setup()
    const onToggleSessionSettings = mock(() => {})
    renderWithQueryClient(
      <AppFooter
        sessionModel="anthropic/claude-3-7-sonnet"
        sessionThinkingLevel="high"
        onToggleSessionSettings={onToggleSessionSettings}
      />
    )
    const modelButton = screen.getByRole('button', { name: /anthropic\/claude-3-7-sonnet/i })
    expect(modelButton).toBeTruthy()
    expect(screen.getByText('anthropic/claude-3-7-sonnet')).toBeTruthy()
    expect(screen.getByText('(high)')).toBeTruthy()

    await user.hover(modelButton)
    expect((await screen.findByRole('tooltip')).textContent).toMatch(/Active Model: anthropic\/claude-3-7-sonnet/i)

    fireEvent.click(modelButton)
    expect(onToggleSessionSettings).toHaveBeenCalledTimes(1)
  })

  it('renders fast mode pill when fast mode is enabled', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(
      <AppFooter sessionFastMode={true} />
    )
    expect(screen.getByText('fast')).toBeTruthy()
    await user.hover(screen.getByText('fast'))
    expect((await screen.findByRole('tooltip')).textContent).toBe('Fast mode active')
  })


  it('keeps only the settings gear among the utilities', () => {
    renderWithQueryClient(<AppFooter />)

    for (const gone of ['Scheduled tasks', 'Telemetry', 'Help and shortcuts']) {
      expect(screen.queryByLabelText(gone)).toBeNull()
    }
    expect(screen.queryByRole('button', { name: /^Theme:/ })).toBeNull()

    fireEvent.click(screen.getByLabelText('Settings'))
    expect(mockOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('shows the last 24 hours of spend and opens Telemetry on that range', () => {
    useTelemetryStore.setState({ traceId: 'stale-trace' })
    renderWithQueryClient(<AppFooter />, 1.234)
    const button = screen.getByRole('button', { name: 'Spend in the last 24 hours: $1.23' })
    expect(button.textContent).toContain('$1.23')
    expect(button.textContent).toContain('24h')

    fireEvent.click(button)
    expect(useUIStore.getState().telemetryOpen).toBe(true)
    // Entry points land on the overview, not the last trace.
    expect(useTelemetryStore.getState().traceId).toBeNull()
    expect(useTelemetryStore.getState().days).toBe(1)
    useUIStore.getState().closeTelemetry()
  })

  it('leaves the spend out until the summary loads', () => {
    renderWithQueryClient(<AppFooter />)
    expect(screen.queryByRole('button', { name: /Spend in the last 24 hours/ })).toBeNull()
  })
})
