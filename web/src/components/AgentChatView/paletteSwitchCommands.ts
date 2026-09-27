/**
 * Command palette entries that switch what the chat is pointed at: another
 * session, another workspace, another model, or the other interaction mode.
 *
 * Pure so the list is testable from plain query data; ``usePaletteSwitchCommands``
 * gathers the inputs and wires the handlers to the same code paths the
 * sidebar, Session Settings, and the composer's mode toggle use.
 */
import type {
  CodingWorkspaceTreeResponse,
  ModelCatalogEntry,
  SessionInteractionMode,
  SessionResponse,
} from '@/api/types'
import type { Command } from '../CommandPalette'
import { modelOverrideFor } from '@/lib/thinking-levels'
import { formatCompactRelative } from '@/utils/format'
import { sameWorkspacePath, workspaceLabel } from '@/utils/workspace'

export interface SwitchCommandsInput {
  currentSessionId: string | null
  currentWorkspace: string | null
  /** Top-level sessions across workspaces, as the sidebar lists them. */
  sessions: SessionResponse[]
  /** ``null`` until the workspace tree has loaded. */
  tree: CodingWorkspaceTreeResponse | null
  models: ModelCatalogEntry[]
  /** The lead agent's configured model. */
  defaultModel: string | null
  sessionModel: string | null
  sessionThinkingLevel: string | null
  /** Effective mode: a queued switch counts as already chosen. */
  interactionMode: SessionInteractionMode
  now?: Date
}

export interface SwitchCommandHandlers {
  openSession: (session: SessionResponse) => void
  openWorkspace: (path: string) => void
  setModel: (model: string | null, thinkingLevel: string | null) => void
  setInteractionMode: (mode: SessionInteractionMode) => void
}

const MODE_LABEL: Record<SessionInteractionMode, string> = { code: 'Code', plan: 'Plan' }

function sessionStatus(session: SessionResponse, now: Date): string {
  // ``needs_input`` implies ``running``, so it is checked first.
  if (session.needs_input) return 'Needs you'
  if (session.running) return 'Running'
  return formatCompactRelative(session.updated_at, now)
}

function byRecency(a: SessionResponse, b: SessionResponse): number {
  return (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
}

function sessionCommands(input: SwitchCommandsInput, handlers: SwitchCommandHandlers, now: Date): Command[] {
  const chat = input.tree?.chat ?? null
  return input.sessions
    .filter((s) => s.id !== input.currentSessionId && !s.parent_session_id)
    .sort(byRecency)
    .map((s) => ({
      id: `session:${s.id}`,
      label: s.title?.trim() || 'Untitled session',
      description: [s.workspace ? workspaceLabel(s.workspace, chat) : null, sessionStatus(s, now)]
        .filter(Boolean)
        .join(' · '),
      action: () => handlers.openSession(s),
    }))
}

function workspaceCommands(input: SwitchCommandsInput, handlers: SwitchCommandHandlers): Command[] {
  const tree = input.tree
  if (!tree) return []
  const rows: { path: string; label: string; description: string }[] = []
  if (tree.chat) rows.push({ path: tree.chat.path, label: tree.chat.name, description: 'Chat workspace' })
  for (const repo of tree.repositories) {
    rows.push({ path: repo.path, label: repo.name, description: repo.path })
    for (const wt of repo.worktrees) rows.push({ path: wt.path, label: wt.name, description: `Worktree of ${repo.name}` })
  }
  // The tree has no last-used time; the newest session in a workspace is the
  // best recency signal. Workspaces without sessions keep tree order.
  const lastActive = new Map<string, string>()
  for (const s of input.sessions) {
    const row = s.workspace ? rows.find((r) => sameWorkspacePath(r.path, s.workspace)) : undefined
    if (row && (s.updated_at ?? '') > (lastActive.get(row.path) ?? '')) lastActive.set(row.path, s.updated_at ?? '')
  }
  return rows
    .filter((r) => !sameWorkspacePath(r.path, input.currentWorkspace))
    .sort((a, b) => (lastActive.get(b.path) ?? '').localeCompare(lastActive.get(a.path) ?? ''))
    .map((r) => ({
      id: `workspace:${r.path}`,
      label: r.label,
      description: r.description,
      action: () => handlers.openWorkspace(r.path),
    }))
}

function modelCommands(input: SwitchCommandsInput, handlers: SwitchCommandHandlers): Command[] {
  const current = input.sessionModel ?? input.defaultModel
  // Same filter as Session Settings: image/video generators cannot chat.
  const chatModels = input.models.filter((m) => !m.output_image && !m.output_video)
  return chatModels.map((m) => ({
    id: `model:${m.id}`,
    group: m.provider,
    label: m.model,
    description: [m.id === input.defaultModel && 'Agent default', m.id === current && 'Current']
      .filter(Boolean)
      .join(' · ') || undefined,
    action: () => {
      const next = modelOverrideFor(m.id, chatModels, input.defaultModel, input.sessionThinkingLevel)
      handlers.setModel(next.model, next.thinkingLevel)
    },
  }))
}

export function buildSwitchCommands(input: SwitchCommandsInput, handlers: SwitchCommandHandlers): Command[] {
  const now = input.now ?? new Date()
  const commands: Command[] = []
  const noop = () => {}

  const sessions = sessionCommands(input, handlers, now)
  if (sessions.length > 0) {
    commands.push({
      id: 'switch-session',
      group: 'Session',
      label: 'Switch Session…',
      description: 'Jump to a recent session in any workspace',
      page: { placeholder: 'Search sessions…', commands: sessions },
      action: noop,
    })
  }

  const workspaces = workspaceCommands(input, handlers)
  if (workspaces.length > 0) {
    commands.push({
      id: 'switch-workspace',
      group: 'Session',
      label: 'Switch Workspace…',
      description: 'Continue in another repository, worktree, or Chat',
      page: { placeholder: 'Search workspaces…', commands: workspaces },
      action: noop,
    })
  }

  const models = modelCommands(input, handlers)
  if (models.length > 0) {
    commands.push({
      id: 'change-model',
      group: 'Session',
      label: 'Change Model…',
      description: 'Applies from your next message',
      page: { placeholder: 'Search models…', commands: models },
      action: noop,
    })
  }

  if (input.currentSessionId) {
    const next: SessionInteractionMode = input.interactionMode === 'plan' ? 'code' : 'plan'
    commands.push({
      id: 'toggle-interaction-mode',
      group: 'Session',
      label: `Switch to ${MODE_LABEL[next]} Mode`,
      description: `Currently ${MODE_LABEL[input.interactionMode]}; a running turn finishes first`,
      action: () => handlers.setInteractionMode(next),
    })
  }

  return commands
}
