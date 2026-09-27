import type { ComponentProps } from 'react'
import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { AgentChatHeader } from '@/components/AgentChatView/AgentChatHeader'
import { queryKeys } from '@/queries/keys'
import type { SessionResponse, WorkspaceStatusResponse } from '@/api/types'

function renderHeader(
  overrides: Partial<ComponentProps<typeof AgentChatHeader>> = {},
  wrapper?: (props: { children: React.ReactNode }) => React.ReactNode,
) {
  const props: ComponentProps<typeof AgentChatHeader> = {
    dragHandlers: {},
    isMacOverlay: false,
    isMobile: true,
    workspace: '/Users/name/Workspace A',
    sessionTitle: 'Fix updater restart',
    onCodingSidebarToggle: () => undefined,
    headerTokens: undefined,
    sessionId: 'session-1',
    todos: [],
    onToggleTasks: () => undefined,
    tasksViewActive: false,
    codingPanel: null,
    onWorkspaceFiles: () => undefined,
    agentCapabilitiesOpen: false,
    onToggleAgentCapabilities: () => undefined,
    showMobileActions: false,
    setShowMobileActions: () => undefined,
    mobileActionsDragOffset: null,
    onToggleScheduler: () => undefined,
    onFindInTranscript: () => undefined,
    onOpenTerminal: () => undefined,
    onCloseMobileActionsMenu: () => undefined,
    ...overrides,
  }
  return render(<AgentChatHeader {...props} />, wrapper ? { wrapper } : undefined)
}

function withActiveSessions(rows: Partial<SessionResponse>[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session.sessions.active(), {
    pages: [{
      data: rows.map((row, index) => ({ id: `s${index}`, title: null, agent_name: 'lead', created_at: null, updated_at: null, workspace: '/w', ...row })),
      next_cursor: null,
      has_more: false,
    }],
    pageParams: [null],
  })
  return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function withGitStatus(workspace: string, status: Partial<WorkspaceStatusResponse>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.coding.status(workspace), {
    workspace, name: 'Workspace A', is_git_repo: true, branch: 'main', ...status,
  })
  return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('AgentChatHeader', () => {
  it('shows only the workspace title for mobile coding sessions', () => {
    renderHeader()

    expect(screen.getByText('Workspace A')).toBeInTheDocument()
    expect(screen.queryByText('Fix updater restart')).not.toBeInTheDocument()
  })

  it('keeps desktop coding sessions showing workspace and session title', () => {
    renderHeader({ isMobile: false })

    expect(screen.getByText('Workspace A')).toBeInTheDocument()
    expect(screen.getByText('Fix updater restart')).toBeInTheDocument()
  })

  it('renames the session from its title on desktop', async () => {
    const user = userEvent.setup()
    const onRenameSession = mock((..._args: unknown[]) => {})
    renderHeader({ isMobile: false, onRenameSession })

    await user.click(screen.getByRole('button', { name: 'Rename session Fix updater restart' }))
    const input = screen.getByLabelText('Session title')
    await user.clear(input)
    await user.type(input, 'Ship the updater{Enter}')

    expect(onRenameSession.mock.calls).toEqual([['session-1', 'Ship the updater']])
    expect(screen.queryByLabelText('Session title')).not.toBeInTheDocument()
  })

  it('sizes every mobile header action to the full header height on touch', () => {
    renderHeader({ isMobile: true })

    for (const name of ['Tasks', 'Workspace files', 'Session settings']) {
      expect(screen.getByRole('button', { name }).className).toContain('pointer-coarse:size-9')
    }
  })

  it('renders token meter on mobile when headerTokens has zero usage', () => {
    renderHeader({
      isMobile: true,
      headerTokens: { input: 0, output: 0, cached: 0 },
    })

    expect(screen.getByRole('button', { name: /Input: 0/i })).toBeInTheDocument()
  })

  it('hides token meter when headerTokens is undefined', () => {
    renderHeader({ headerTokens: undefined })
    expect(screen.queryByRole('button', { name: /Input:/i })).not.toBeInTheDocument()
  })

  it('runs mobile transcript and terminal actions before closing the drawer', async () => {
    const user = userEvent.setup()
    const onFindInTranscript = mock(() => {})
    const onOpenTerminal = mock(() => {})
    const onCloseMobileActionsMenu = mock(() => {})
    renderHeader({
      showMobileActions: true,
      onFindInTranscript,
      onOpenTerminal,
      onCloseMobileActionsMenu,
    })

    await user.click(screen.getByRole('button', { name: 'Find in transcript' }))
    await user.click(screen.getByRole('button', { name: 'Open terminal' }))

    expect(onFindInTranscript).toHaveBeenCalledTimes(1)
    expect(onOpenTerminal).toHaveBeenCalledTimes(1)
    expect(onCloseMobileActionsMenu).toHaveBeenCalledTimes(2)
  })

  it('labels the chat workspace "Chat" instead of its home-directory basename', () => {
    renderHeader({
      isMobile: false,
      workspace: '/Users/name',
      chatWorkspace: { path: '/Users/name', name: 'Chat' },
      sessionTitle: null,
    })

    expect(screen.getByText('Chat')).toBeInTheDocument()
    expect(screen.queryByText('name')).not.toBeInTheDocument()
  })

  it('keeps revealing the real path when hovering a coding workspace', async () => {
    const user = userEvent.setup()
    renderHeader({ isMobile: false, sessionTitle: null })

    await user.hover(screen.getByText('Workspace A'))

    expect(screen.getByRole('tooltip')).toHaveTextContent('/Users/name/Workspace A')
  })

  it('never leaks the home path into the chat workspace tooltip', async () => {
    const user = userEvent.setup()
    renderHeader({
      isMobile: false,
      workspace: '/Users/name',
      chatWorkspace: { path: '/Users/name', name: 'Chat' },
      sessionTitle: null,
    })

    await user.hover(screen.getByText('Chat'))

    expect(screen.getByRole('tooltip')).toHaveTextContent('Chat')
    expect(screen.queryByText('/Users/name')).not.toBeInTheDocument()
  })

  it('opens the command palette from the desktop command center', async () => {
    const user = userEvent.setup()
    const onOpenPalette = mock(() => {})
    renderHeader({ isMobile: false, onOpenPalette })

    await user.click(screen.getByRole('button', { name: /Search or run a command/ }))

    expect(onOpenPalette).toHaveBeenCalledTimes(1)
  })

  it('keeps the command center off the mobile header', () => {
    renderHeader({ isMobile: true, onOpenPalette: () => undefined })

    expect(screen.queryByRole('button', { name: /Search or run a command/ })).not.toBeInTheDocument()
  })

  it('reflects the review dock state on its toggle', () => {
    const { rerender } = renderHeader({ isMobile: false, codingPanel: null })
    expect(screen.getByRole('button', { name: 'Changed files and workspace files' })).toHaveAttribute('aria-pressed', 'false')

    rerender(
      <AgentChatHeader
        dragHandlers={{}}
        isMacOverlay={false}
        isMobile={false}
        workspace="/Users/name/Workspace A"
        sessionTitle={null}
        onCodingSidebarToggle={() => undefined}
        sessionId="session-1"
        todos={[]}
        onToggleTasks={() => undefined}
        tasksViewActive={false}
        codingPanel="changed"
        onWorkspaceFiles={() => undefined}
        agentCapabilitiesOpen={false}
        onToggleAgentCapabilities={() => undefined}
        showMobileActions={false}
        setShowMobileActions={() => undefined}
        onToggleScheduler={() => undefined}
        onFindInTranscript={() => undefined}
        onCloseMobileActionsMenu={() => undefined}
      />,
    )
    expect(screen.getByRole('button', { name: 'Changed files and workspace files' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('routes the desktop Tasks button through onToggleTasks with progress and pressed state', async () => {
    const user = userEvent.setup()
    const onToggleTasks = mock(() => {})
    renderHeader({
      isMobile: false,
      onToggleTasks,
      tasksViewActive: true,
      todos: [
        { task_id: '1', content: 'Plan', status: 'completed' },
        { task_id: '2', content: 'Build', status: 'in_progress' },
        { task_id: '3', content: 'Ship', status: 'pending' },
      ],
    })

    const button = screen.getByRole('button', { name: 'Task list' })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button).toHaveTextContent('1/3')
    await user.click(button)
    expect(onToggleTasks).toHaveBeenCalledTimes(1)
  })

  it('summarises running and waiting sessions on desktop and opens the sidebar on click', async () => {
    const user = userEvent.setup()
    const onOpenActiveSessions = mock(() => {})
    renderHeader({ isMobile: false, onOpenActiveSessions }, withActiveSessions([
      { running: true },
      { running: true },
      { running: true, needs_input: true },
    ]))

    const summary = screen.getByRole('button', { name: '2 running · 1 needs you' })
    await user.click(summary)
    expect(onOpenActiveSessions).toHaveBeenCalledTimes(1)
  })

  it('hides the session summary when nothing runs', () => {
    renderHeader({ isMobile: false, onOpenActiveSessions: () => {} }, withActiveSessions([{}]))
    expect(screen.queryByRole('button', { name: /running|needs you/ })).not.toBeInTheDocument()
  })

  it('drops the zero half of the summary', () => {
    renderHeader({ isMobile: false, onOpenActiveSessions: () => {} }, withActiveSessions([{ running: true, needs_input: true }]))
    expect(screen.getByRole('button', { name: '1 needs you' })).toBeInTheDocument()
  })

  it('shows the branch between the workspace and the title, opening Git changes on click', async () => {
    const user = userEvent.setup()
    const onOpenGitChanges = mock(() => {})
    renderHeader({ isMobile: false, onOpenGitChanges }, withGitStatus('/Users/name/Workspace A', {
      branch: 'feature/header',
      commits_ahead: 2,
      commits_behind: 1,
      dirty: { staged: 1, unstaged: 2, untracked: 0 },
    }))

    const branch = screen.getByRole('button', { name: /feature\/header/ })
    expect(screen.getByLabelText('2 commits to push')).toBeInTheDocument()
    expect(screen.getByLabelText('1 commits to pull')).toBeInTheDocument()
    expect(branch).toHaveTextContent('*3')
    expect(screen.getByRole('banner').textContent).toMatch(/Workspace A.*feature\/header.*Fix updater restart/)

    await user.click(branch)
    expect(onOpenGitChanges).toHaveBeenCalledTimes(1)
  })

  it('leaves the branch out for the chat workspace', () => {
    renderHeader({
      isMobile: false,
      workspace: '/Users/name',
      chatWorkspace: { path: '/Users/name', name: 'Chat' },
      onOpenGitChanges: () => {},
    }, withGitStatus('/Users/name', { branch: 'main' }))

    expect(screen.queryByText('main')).not.toBeInTheDocument()
  })

  it('disables the desktop Tasks button without a session', () => {
    renderHeader({ isMobile: false, sessionId: null })
    expect(screen.getByRole('button', { name: 'Task list' })).toBeDisabled()
  })

  it('toggles tasks from the mobile header through the same handler', async () => {
    const user = userEvent.setup()
    const onToggleTasks = mock(() => {})
    renderHeader({ isMobile: true, onToggleTasks })

    await user.click(screen.getByRole('button', { name: /Tasks/ }))
    expect(onToggleTasks).toHaveBeenCalledTimes(1)
  })
})
