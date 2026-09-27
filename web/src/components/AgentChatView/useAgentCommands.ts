/**
 * useAgentCommands — assembles the Command Palette command list for
 * the agent chat view.
 *
 * The palette commands are pure data, but they close over a lot of
 * parent-owned state and callbacks (the various toggle/cycle handlers).
 * Wrapping the assembly in a hook keeps
 * the parent's render body focused on layout while still threading the
 * closures naturally.
 *
 * Group conventions used by ``CommandPalette``:
 *   - ``Session``    — session lifecycle (new chat, …)
 *   - ``View``       — view-mode + panel toggles
 *   - ``Navigation`` — app-level surfaces (Settings, Telemetry)
 */
import { useMemo } from 'react'
import type { Command } from '../CommandPalette'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { openTelemetry } from '@/stores/useTelemetryStore'
import {
  DEFAULT_TRANSCRIPT_FONT_SIZE,
  TRANSCRIPT_DENSITIES,
  TRANSCRIPT_FONT_SIZES,
  useTranscriptStore,
  type TranscriptDensity,
} from '@/stores/useTranscriptStore'
import { usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS as KEYS, shortcutLabel } from '@/lib/app-shortcuts'
import { APP_EVENTS, dispatchAppEvent } from '@/lib/app-events'

interface UseAgentCommandsArgs {
  toggleAgentCapabilities: () => void
  /** Opens the task list (dock Tasks tab on desktop, popover otherwise). */
  toggleTasks: () => void
  /** Opens scheduled tasks (dock Schedule tab with a workspace, overlay otherwise). */
  toggleScheduler: () => void
  handleWorkspaceFiles: () => void
  handleCodingSidebarToggle: () => void

  // Session
  handleNewSession: () => void

  /** Coding mode with an attached workspace only — opens the terminal tab. */
  handleOpenTerminal: () => void
  handleFindInTranscript: () => void
  /** Opens the review dock if needed and toggles it over the chat column. */
  handleToggleDockMaximized?: () => void
}

/** Density and text size; each label follows the setting. */
function transcriptViewCommands(density: TranscriptDensity, fontSize: number): Command[] {
  const view = () => useTranscriptStore.getState()
  const sizes = TRANSCRIPT_FONT_SIZES as readonly number[]
  const densityLabel = TRANSCRIPT_DENSITIES.find((d) => d.value === density)?.label ?? density
  const commands: Command[] = [
    {
      id: 'transcript-density',
      group: 'View',
      label: 'Transcript Density…',
      description: `Currently ${densityLabel}`,
      page: {
        placeholder: 'Search densities…',
        commands: TRANSCRIPT_DENSITIES.map((d) => ({
          id: `transcript-density:${d.value}`,
          label: d.label,
          description: d.value === density ? 'Current' : undefined,
          action: () => view().setDensity(d.value),
        })),
      },
      action: () => {},
    },
  ]
  if (fontSize < sizes[sizes.length - 1]) {
    commands.push({ id: 'transcript-text-larger', group: 'View', label: 'Larger Transcript Text', description: `Now ${fontSize}px`, action: () => view().stepFontSize(1) })
  }
  if (fontSize > sizes[0]) {
    commands.push({ id: 'transcript-text-smaller', group: 'View', label: 'Smaller Transcript Text', description: `Now ${fontSize}px`, action: () => view().stepFontSize(-1) })
  }
  if (fontSize !== DEFAULT_TRANSCRIPT_FONT_SIZE) {
    commands.push({ id: 'transcript-text-reset', group: 'View', label: 'Reset Transcript Text Size', description: `Back to ${DEFAULT_TRANSCRIPT_FONT_SIZE}px`, action: () => view().resetFontSize() })
  }
  return commands
}

export function useAgentCommands({
  toggleAgentCapabilities,
  toggleTasks,
  toggleScheduler,
  handleWorkspaceFiles,
  handleCodingSidebarToggle,
  handleNewSession,
  handleOpenTerminal,
  handleFindInTranscript,
  handleToggleDockMaximized,
}: UseAgentCommandsArgs): Command[] {
  const openSettings = useSettingsStore((s) => s.openSettings)
  const density = useTranscriptStore((s) => s.density)
  const fontSize = useTranscriptStore((s) => s.fontSize)
  const { os, isTauri } = usePlatform()
  return useMemo<Command[]>(() => [
    { id: 'new-chat', group: 'Session', label: 'New Session', description: 'Start a fresh conversation', shortcut: shortcutLabel(KEYS.newSession, os), action: handleNewSession },
    { id: 'open-session-markdown', group: 'Session', label: 'Open Session as Markdown', description: 'The whole conversation as one document to read or download', action: () => dispatchAppEvent(APP_EVENTS.openSessionMarkdown) },
    { id: 'agent-info',       group: 'View',       label: 'Session Settings', description: 'Show session model settings and lead context', shortcut: shortcutLabel(KEYS.sessionSettings, os), action: toggleAgentCapabilities },
    { id: 'todos',            group: 'View',       label: 'Task List',          description: 'View agent todos and progress', shortcut: shortcutLabel(KEYS.tasks, os), action: toggleTasks },
    { id: 'find-transcript',  group: 'View',       label: 'Find in Transcript', description: 'Search user and assistant text in this session', shortcut: shortcutLabel(KEYS.findInTranscript, os), action: handleFindInTranscript },
    ...transcriptViewCommands(density, fontSize),
    { id: 'workspace-files',  group: 'View',       label: 'Open Changed & Files', description: 'Browse changed files and workspace files', shortcut: shortcutLabel(KEYS.workspaceFiles, os), action: handleWorkspaceFiles },
    ...(handleToggleDockMaximized
      ? [{ id: 'maximize-dock', group: 'View' as const, label: 'Maximize Review Dock', description: 'Give the review dock the full width for diffs, files, and terminals', shortcut: shortcutLabel(KEYS.maximizeDock, os), action: handleToggleDockMaximized }]
      : []),
    { id: 'collapse-sidebar', group: 'View', label: 'Toggle Coding Sidebar', description: 'Collapse or expand workspaces and sessions', shortcut: shortcutLabel(KEYS.codingSidebar, os), action: handleCodingSidebarToggle },
    { id: 'scheduled-tasks',  group: 'View',       label: 'Scheduled Tasks',   description: 'Manage cron and scheduled agent tasks', action: toggleScheduler },
    { id: 'open-terminal', group: 'View' as const, label: 'Open Terminal', description: 'Interactive shell in the workspace (runs on the connected server)', shortcut: shortcutLabel(KEYS.terminal, os), action: handleOpenTerminal },
    { id: 'go-settings', group: 'Navigation', label: 'Open Settings',  description: 'Manage agents, skills, providers & more', shortcut: shortcutLabel(KEYS.settings, os), action: () => openSettings('agents') },
    { id: 'go-telemetry', group: 'Navigation', label: 'Open Telemetry', description: 'Spend, turns, and traces by workspace and model', action: () => openTelemetry() },
    // Desktop only: the native ⌘R accelerator was dropped so a stray key
    // press cannot wipe a live turn's UI state; browsers keep their own reload.
    ...(isTauri
      ? [{ id: 'reload-window', group: 'View', label: 'Reload Window', description: 'Reload the app UI (the server and running turns are unaffected)', action: () => window.location.reload() }]
      : []),
  ], [os, isTauri, density, fontSize, toggleAgentCapabilities, toggleTasks, toggleScheduler, handleFindInTranscript, handleWorkspaceFiles, handleToggleDockMaximized, handleCodingSidebarToggle, handleNewSession, handleOpenTerminal, openSettings])
}
