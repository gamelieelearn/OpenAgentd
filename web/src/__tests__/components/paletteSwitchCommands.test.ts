/**
 * Palette "switch" commands — Switch Session…, Switch Workspace…,
 * and the Plan/Code toggle — built from query data.
 */
import { describe, expect, it, mock } from 'bun:test'
import type { CodingWorkspaceTreeResponse, SessionResponse } from '@/api/types'
import type { Command } from '@/components/CommandPalette'
import {
  buildSwitchCommands,
  type SwitchCommandHandlers,
  type SwitchCommandsInput,
} from '@/components/AgentChatView/paletteSwitchCommands'

const NOW = new Date('2026-05-01T12:00:00Z')

function session(id: string, overrides: Partial<SessionResponse> = {}): SessionResponse {
  return { id, title: id, agent_name: null, created_at: null, updated_at: '2026-05-01T11:00:00Z', workspace: '/repo/app', ...overrides }
}

const tree: CodingWorkspaceTreeResponse = {
  chat: { path: '/home/me', name: 'Chat' },
  repositories: [
    { path: '/repo/app', name: 'app', worktrees: [{ path: '/repo/app-wt', name: 'app-wt', managed: true }] },
    { path: '/repo/docs', name: 'docs', worktrees: [] },
  ],
}

function build(overrides: Partial<SwitchCommandsInput> = {}) {
  const handlers: SwitchCommandHandlers = {
    openSession: mock(() => {}),
    openWorkspace: mock(() => {}),
    setInteractionMode: mock(() => {}),
  }
  const input: SwitchCommandsInput = {
    currentSessionId: 'current',
    currentWorkspace: '/repo/app',
    sessions: [],
    tree,
    interactionMode: 'code',
    now: NOW,
    ...overrides,
  }
  return { handlers, commands: buildSwitchCommands(input, handlers) }
}

function byId(commands: Command[], id: string): Command {
  const cmd = commands.find((c) => c.id === id)
  if (!cmd) throw new Error(`missing ${id}: ${commands.map((c) => c.id).join(', ')}`)
  return cmd
}

describe('Switch Session…', () => {
  it('lists other top-level sessions with workspace and status', () => {
    const { commands, handlers } = build({
      sessions: [
        session('current'),
        session('busy', { title: 'Fix login', running: true }),
        session('asking', { title: 'Plan release', running: true, needs_input: true, workspace: '/home/me' }),
        session('idle', { title: null, updated_at: '2026-05-01T09:00:00Z', workspace: '/repo/docs' }),
        session('child', { parent_session_id: 'busy' }),
      ],
    })

    const page = byId(commands, 'switch-session').page!
    expect(page.commands.map((c) => [c.label, c.description])).toEqual([
      ['Fix login', 'app · Running'],
      ['Plan release', 'Chat · Needs you'],
      ['Untitled session', 'docs · 3h'],
    ])

    page.commands[0].action()
    expect(handlers.openSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'busy' }))
  })

  it('is omitted when there is nowhere else to go', () => {
    const { commands } = build({ sessions: [session('current')] })
    expect(commands.find((c) => c.id === 'switch-session')).toBeUndefined()
  })
})

describe('Switch Workspace…', () => {
  it('lists every other workspace, most recently active first', () => {
    const { commands, handlers } = build({
      sessions: [
        session('a', { workspace: '/repo/docs', updated_at: '2026-05-01T10:00:00Z' }),
        session('b', { workspace: '/home/me', updated_at: '2026-05-01T11:30:00Z' }),
      ],
    })

    const page = byId(commands, 'switch-workspace').page!
    expect(page.commands.map((c) => [c.label, c.description])).toEqual([
      ['Chat', 'Chat workspace'],
      ['docs', '/repo/docs'],
      ['app-wt', 'Worktree of app'],
    ])

    page.commands[1].action()
    expect(handlers.openWorkspace).toHaveBeenCalledWith('/repo/docs')
  })

  it('is omitted before the workspace tree has loaded', () => {
    const { commands } = build({ tree: null })
    expect(commands.find((c) => c.id === 'switch-workspace')).toBeUndefined()
  })
})

describe('Plan / Code toggle', () => {
  it('offers the other mode and switches to it', () => {
    const { commands, handlers } = build({ interactionMode: 'code' })

    const cmd = byId(commands, 'toggle-interaction-mode')
    expect(cmd.label).toBe('Switch to Plan Mode')
    cmd.action()
    expect(handlers.setInteractionMode).toHaveBeenCalledWith('plan')

    expect(byId(build({ interactionMode: 'plan' }).commands, 'toggle-interaction-mode').label).toBe('Switch to Code Mode')
  })

  it('needs a session to switch', () => {
    const { commands } = build({ currentSessionId: null })
    expect(commands.find((c) => c.id === 'toggle-interaction-mode')).toBeUndefined()
  })
})
