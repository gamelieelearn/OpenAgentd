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
import { usePlatform } from '@/hooks/use-platform'
import { useThemePreference } from '@/hooks/useThemePreference'
import { APP_SHORTCUTS as KEYS, shortcutLabel } from '@/lib/app-shortcuts'
import { THEME_OPTIONS } from '@/components/ThemeToggle'

interface UseAgentCommandsArgs {
  toggleAgentCapabilities: () => void
  /** Opens the task list (dock Tasks tab on desktop, popover otherwise). */
  toggleTasks: () => void
  /** Opens scheduled tasks (dock Schedule tab with a workspace, overlay otherwise). */
  toggleScheduler: () => void
  handleWorkspaceFiles: () => void
  handleSidebarToggle: () => void

  // Session
  handleNewSession: () => void

  /** Coding mode with an attached workspace only — opens the terminal tab. */
  handleOpenTerminal: () => void
  handleFindInTranscript: () => void
  /** Opens the review dock if needed and toggles it over the chat column. */
  handleToggleDockMaximized?: () => void
}

export function useAgentCommands({
  toggleAgentCapabilities,
  toggleTasks,
  toggleScheduler,
  handleWorkspaceFiles,
  handleSidebarToggle,
  handleNewSession,
  handleOpenTerminal,
  handleFindInTranscript,
  handleToggleDockMaximized,
}: UseAgentCommandsArgs): Command[] {
  const openSettings = useSettingsStore((s) => s.openSettings)
  const { setPreference: setTheme } = useThemePreference()
  const { os, isTauri } = usePlatform()
  return useMemo<Command[]>(() => [
    { id: 'new-chat', group: 'Session', label: 'New Session', description: 'Start a fresh conversation', shortcut: shortcutLabel(KEYS.newSession, os), action: handleNewSession },
    { id: 'agent-info',       group: 'View',       label: 'Session Settings', description: 'Show session model settings and lead context', shortcut: shortcutLabel(KEYS.sessionSettings, os), action: toggleAgentCapabilities },
    { id: 'todos',            group: 'View',       label: 'Task List',          description: 'View agent todos and progress', shortcut: shortcutLabel(KEYS.tasks, os), action: toggleTasks },
    { id: 'find-transcript',  group: 'View',       label: 'Find in Transcript', description: 'Search user and assistant text in this session', shortcut: shortcutLabel(KEYS.findInTranscript, os), action: handleFindInTranscript },
    { id: 'workspace-files',  group: 'View',       label: 'Open Changed & Files', description: 'Browse changed files and workspace files', shortcut: shortcutLabel(KEYS.workspaceFiles, os), action: handleWorkspaceFiles },
    ...(handleToggleDockMaximized
      ? [{ id: 'maximize-dock', group: 'View' as const, label: 'Maximize Review Dock', description: 'Give the review dock the full width for diffs, files, and terminals', shortcut: shortcutLabel(KEYS.maximizeDock, os), action: handleToggleDockMaximized }]
      : []),
    { id: 'collapse-sidebar', group: 'View', label: 'Toggle Sidebar', description: 'Collapse or expand workspaces and sessions', shortcut: shortcutLabel(KEYS.sidebar, os), action: handleSidebarToggle },
    { id: 'scheduled-tasks',  group: 'View',       label: 'Scheduled Tasks',   description: 'Manage cron and scheduled agent tasks', action: toggleScheduler },
    { id: 'open-terminal', group: 'View' as const, label: 'Open Terminal', description: 'Interactive shell in the workspace (runs on the connected server)', shortcut: shortcutLabel(KEYS.terminal, os), action: handleOpenTerminal },
    { id: 'go-settings', group: 'Navigation', label: 'Open Settings',  description: 'Manage agents, skills, providers & more', shortcut: shortcutLabel(KEYS.settings, os), action: () => openSettings('agents') },
    { id: 'go-telemetry', group: 'Navigation', label: 'Open Telemetry', description: 'Spend, turns, and traces by workspace and model', action: () => openTelemetry() },
    ...THEME_OPTIONS.map(({ value, label }) => ({
      id: `theme-${value}`, group: 'View' as const, label: `Theme: ${label}`, description: value === 'system' ? 'Follow the system appearance' : `Use the ${value} theme`, action: () => setTheme(value),
    })),
    // Desktop only: the native ⌘R accelerator was dropped so a stray key
    // press cannot wipe a live turn's UI state; browsers keep their own reload.
    ...(isTauri
      ? [{ id: 'reload-window', group: 'View', label: 'Reload Window', description: 'Reload the app UI (the server and running turns are unaffected)', action: () => window.location.reload() }]
      : []),
  ], [os, isTauri, toggleAgentCapabilities, toggleTasks, toggleScheduler, handleFindInTranscript, handleWorkspaceFiles, handleToggleDockMaximized, handleSidebarToggle, handleNewSession, handleOpenTerminal, openSettings, setTheme])
}
