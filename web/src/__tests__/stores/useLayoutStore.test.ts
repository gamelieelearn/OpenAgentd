import { beforeEach, describe, expect, it } from 'bun:test'

import { LAYOUT_STORAGE_KEY, useLayoutStore } from '@/stores/useLayoutStore'
import { DOCK_DEFAULT_RATIO } from '@/lib/workbench-layout'

beforeEach(() => {
  localStorage.clear()
  useLayoutStore.setState({ sidebarCollapsed: null, sidebarWidth: 264, dockRatio: DOCK_DEFAULT_RATIO, dockMaximized: false })
})

function persisted(): Record<string, unknown> {
  const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
  return raw ? (JSON.parse(raw).state as Record<string, unknown>) : {}
}

describe('useLayoutStore', () => {
  it('resolves functional collapse updates from the fallback until the user chooses', () => {
    useLayoutStore.getState().setSidebarCollapsed((prev) => !prev, false)
    expect(useLayoutStore.getState().sidebarCollapsed).toBe(true)
    useLayoutStore.getState().setSidebarCollapsed((prev) => !prev, true)
    expect(useLayoutStore.getState().sidebarCollapsed).toBe(false)
  })

  it('persists sidebar and dock geometry but never the maximized flag', () => {
    const store = useLayoutStore.getState()
    store.setSidebarWidth(300.4)
    store.setDockRatio(0.6)
    store.setDockMaximized(true)
    const saved = persisted()
    expect(saved.sidebarWidth).toBe(300)
    expect(saved.dockRatio).toBe(0.6)
    expect('dockMaximized' in saved).toBe(false)
    expect(useLayoutStore.getState().dockMaximized).toBe(true)
  })

  it('ignores out-of-range dock ratios and resets to the default', () => {
    const store = useLayoutStore.getState()
    store.setDockRatio(1.5)
    expect(useLayoutStore.getState().dockRatio).toBe(DOCK_DEFAULT_RATIO)
    store.setDockRatio(0.3)
    store.resetDockRatio()
    expect(useLayoutStore.getState().dockRatio).toBe(DOCK_DEFAULT_RATIO)
  })

  it('toggles maximize', () => {
    useLayoutStore.getState().toggleDockMaximized()
    expect(useLayoutStore.getState().dockMaximized).toBe(true)
    useLayoutStore.getState().toggleDockMaximized()
    expect(useLayoutStore.getState().dockMaximized).toBe(false)
  })
})
