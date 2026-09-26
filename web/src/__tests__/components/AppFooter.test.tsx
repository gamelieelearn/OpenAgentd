import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppFooter } from '@/components/AppFooter'
import { useTelemetryStore } from '@/stores/useTelemetryStore'
import { useUIStore } from '@/stores/useUIStore'

const navigate = mock(() => Promise.resolve())
mock.module('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
const mockOpenSettings = mock(() => {})

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

mock.module('@/queries/useHealthQuery', () => ({
  useHealthQuery: () => ({ isSuccess: true, isError: false, isLoading: false }),
  useBackendStatusQuery: () => ({
    data: {
      mode: 'bundled',
      base_url: 'http://127.0.0.1:4082',
      sidecar_running: true,
      external: false,
      supports_bundled: true,
      servers: [],
    },
    isSuccess: true,
  }),
}))

const statusProbes: string[] = []
let statusExtras: Record<string, unknown> = {}
mock.module('@/api/client', () => ({
  getCodingWorkspaceStatus: async (workspace: string) => {
    statusProbes.push(workspace)
    return {
      workspace: '/path/to/project',
      name: 'project',
      is_git_repo: true,
      branch: 'main',
      dirty: { staged: 1, unstaged: 2, untracked: 0 },
      ...statusExtras,
    }
  },
}))

function renderWithQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('AppFooter', () => {
  beforeEach(() => {
    mockOpenSettings.mockClear()
    statusProbes.length = 0
    statusExtras = {}
  })

  it('renders backend status indicator', () => {
    renderWithQueryClient(<AppFooter />)
    expect(screen.getByRole('status', { name: 'Application status' })).toBeTruthy()
    expect(screen.queryByText('local')).toBeNull()
    expect(screen.getByText('builtin')).toBeTruthy()
  })

  it('shows the git branch for a coding workspace', async () => {
    renderWithQueryClient(<AppFooter workspace="/path/to/project" />)

    expect(await screen.findByText('main')).toBeTruthy()
    expect(statusProbes).toEqual(['/path/to/project'])
  })

  it('shows ahead/behind sync counts beside the branch', async () => {
    statusExtras = { commits_ahead: 2, commits_behind: 1, upstream: 'origin/main' }
    renderWithQueryClient(<AppFooter workspace="/path/to/project" />)

    expect(await screen.findByLabelText('2 commits to push')).toBeTruthy()
    expect(screen.getByLabelText('1 commits to pull')).toBeTruthy()
    expect(screen.getByText('*3')).toBeTruthy()
  })

  it('skips the git branch and its probe for the chat workspace', () => {
    renderWithQueryClient(<AppFooter workspace="/Users/name" chatWorkspace />)

    expect(screen.getByRole('status', { name: 'Application status' })).toBeTruthy()
    expect(screen.queryByText('main')).toBeNull()
    expect(statusProbes).toEqual([])
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


  it('renders scheduler and settings utilities; the palette entry moved to the header', () => {
    const onToggleScheduler = mock(() => {})

    renderWithQueryClient(
      <AppFooter
        onToggleScheduler={onToggleScheduler}
      />
    )

    const schedulerBtn = screen.getByLabelText('Scheduler')
    fireEvent.click(schedulerBtn)
    expect(onToggleScheduler).toHaveBeenCalledTimes(1)

    expect(screen.queryByLabelText('Help and shortcuts')).toBeNull()

    const settingsBtn = screen.getByLabelText('Settings')
    fireEvent.click(settingsBtn)
    expect(mockOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('marks the scheduler pressed while its dock tab or overlay is showing', () => {
    const { rerender } = renderWithQueryClient(<AppFooter onToggleScheduler={() => {}} />)
    expect(screen.getByLabelText('Scheduler').getAttribute('aria-pressed')).toBe('false')

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <AppFooter onToggleScheduler={() => {}} schedulerActive />
      </QueryClientProvider>,
    )
    expect(screen.getByLabelText('Scheduler').getAttribute('aria-pressed')).toBe('true')
  })

  it('opens the telemetry overlay from the utility cluster', () => {
    useTelemetryStore.setState({ traceId: 'stale-trace' })
    renderWithQueryClient(<AppFooter />)
    const button = screen.getByRole('button', { name: 'Telemetry' })
    expect(button.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button)
    expect(useUIStore.getState().telemetryOpen).toBe(true)
    // Entry points land on the overview, not the last trace.
    expect(useTelemetryStore.getState().traceId).toBeNull()
    expect(button.getAttribute('aria-pressed')).toBe('true')
    useUIStore.getState().closeTelemetry()
  })
})
