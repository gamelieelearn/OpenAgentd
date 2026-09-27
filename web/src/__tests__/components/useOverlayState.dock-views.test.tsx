/**
 * useOverlayState — dock views (Tasks / Schedule).
 *
 * On desktop with a workspace, Tasks / Scheduled Tasks open review-dock tabs; a second press
 * while that tab is focused hides the dock. Phones with a workspace open the
 * scheduler in the dock sheet too but keep the Tasks popover; without a
 * workspace both fall back to the popover / overlay.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useOverlayState, type UseOverlayStateArgs } from '@/components/AgentChatView/useOverlayState'
import { useUIStore } from '@/stores/useUIStore'
import { useGitPanelStore } from '@/stores/useGitPanelStore'

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

function renderOverlay(overrides: Partial<UseOverlayStateArgs> = {}) {
  const args: UseOverlayStateArgs = {
    isMobile: false,
    workspace: '/repo/project',
    toggleScheduler: mock(() => useUIStore.getState().toggleScheduler()),
    toggleAgentCapabilities: mock(() => {}),
    togglePalette: mock(() => {}),
    toggleQuickOpen: mock(() => {}),
    ...overrides,
  }
  return { args, ...renderHook(() => useOverlayState(args), { wrapper }) }
}

beforeEach(() => {
  useUIStore.setState({ schedulerOpen: false, agentCapabilitiesOpen: false, paletteOpen: false, quickOpenOpen: false })
})
afterEach(cleanup)

describe('useOverlayState dock views', () => {
  it('opens the dock with a tasks request on desktop instead of the popover', () => {
    const { result } = renderOverlay()
    expect(result.current.dockViewsEnabled).toBe(true)

    act(() => result.current.handleToggleTasks())

    expect(result.current.codingPanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'tasks', key: 1 })
    expect(result.current.showTodos).toBe(false)
  })

  it('hides the dock on a second press while that view is focused', () => {
    const { result } = renderOverlay()
    act(() => result.current.handleToggleTasks())
    // The mounted dock reports its focused view back.
    act(() => result.current.setDockActiveView('tasks'))

    act(() => result.current.handleToggleTasks())
    expect(result.current.codingPanel).toBeNull()
  })

  it('switches views without hiding when another view is focused', () => {
    const { result } = renderOverlay()
    act(() => result.current.handleToggleTasks())
    act(() => result.current.setDockActiveView('tasks'))

    act(() => result.current.handleToggleScheduler())
    expect(result.current.codingPanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'schedule', key: 2 })
    expect(useUIStore.getState().schedulerOpen).toBe(false)
  })

  it('keeps the tasks popover on mobile but opens the scheduler in the dock sheet', () => {
    const { result, args } = renderOverlay({ isMobile: true })
    expect(result.current.dockViewsEnabled).toBe(false)
    expect(result.current.schedulerInDock).toBe(true)

    act(() => result.current.handleToggleTasks())
    expect(result.current.showTodos).toBe(true)
    expect(result.current.dockViewRequest).toBeNull()

    act(() => result.current.handleToggleScheduler())
    expect(args.toggleScheduler).not.toHaveBeenCalled()
    expect(useUIStore.getState().schedulerOpen).toBe(false)
    expect(result.current.codingPanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'schedule', key: 1 })
    // Opening the sheet closes the tasks popover (single-overlay rule).
    expect(result.current.showTodos).toBe(false)

    act(() => result.current.setDockActiveView('schedule'))
    act(() => result.current.handleToggleScheduler())
    expect(result.current.codingPanel).toBeNull()
  })

  it('keeps the scheduler overlay on mobile without a workspace', () => {
    const { result, args } = renderOverlay({ isMobile: true, workspace: null })
    expect(result.current.schedulerInDock).toBe(false)

    act(() => result.current.handleToggleScheduler())
    expect(args.toggleScheduler).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().schedulerOpen).toBe(true)
  })

  it('falls back to the popover and overlay on desktop without a workspace', () => {
    const { result, args } = renderOverlay({ workspace: null })

    act(() => result.current.handleToggleTasks())
    expect(result.current.showTodos).toBe(true)

    act(() => result.current.handleToggleScheduler())
    expect(args.toggleScheduler).toHaveBeenCalledTimes(1)
    expect(result.current.codingPanel).toBeNull()
  })

  it('opens the Git changes for review, and never hides an open dock', () => {
    useGitPanelStore.getState().setSubTab('/repo/project', 'commits')
    const { result } = renderOverlay()

    act(() => result.current.handleReviewChanges())
    expect(result.current.codingPanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'review', key: 1 })
    expect(useGitPanelStore.getState().workspaces['/repo/project']?.subTab).toBe('changes')

    act(() => result.current.handleReviewChanges())
    expect(result.current.codingPanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'review', key: 2 })
  })
})
