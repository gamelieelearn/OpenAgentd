/**
 * useLayoutStore — persisted desktop workbench layout.
 *
 * Owns the geometry that used to be scattered across component state and
 * per-component localStorage keys: sidebar collapse + width and the review
 * dock's width ratio. ``dockMaximized`` is session-only (never persisted), so
 * a reload always lands with the chat visible.
 *
 * Geometry math lives in ``lib/workbench-layout.ts``; this store only keeps
 * the user's choices.
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { DOCK_DEFAULT_RATIO, SIDEBAR_DEFAULT_WIDTH } from '@/lib/workbench-layout'

export const LAYOUT_STORAGE_KEY = 'oa.layout.v1'
/** Pre-store sidebar width key, read once so existing widths survive. */
export const LEGACY_SIDEBAR_WIDTH_KEY = 'oa.codingSidebar.width'

type Updater<T> = T | ((prev: T) => T)

interface LayoutState {
  /** ``null`` until the user chooses; resolved by ``resolveSidebarCollapsed``. */
  sidebarCollapsed: boolean | null
  sidebarWidth: number
  dockRatio: number
  dockMaximized: boolean
  setSidebarCollapsed: (value: Updater<boolean>, fallback: boolean) => void
  setSidebarWidth: (width: number) => void
  setDockRatio: (ratio: number) => void
  resetDockRatio: () => void
  setDockMaximized: (value: boolean) => void
  toggleDockMaximized: () => void
}

function legacySidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH
  try {
    const parsed = Number(window.localStorage.getItem(LEGACY_SIDEBAR_WIDTH_KEY))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : SIDEBAR_DEFAULT_WIDTH
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: null,
      sidebarWidth: legacySidebarWidth(),
      dockRatio: DOCK_DEFAULT_RATIO,
      dockMaximized: false,
      setSidebarCollapsed: (value, fallback) => {
        const prev = get().sidebarCollapsed ?? fallback
        const next = typeof value === 'function' ? value(prev) : value
        set({ sidebarCollapsed: next })
      },
      setSidebarWidth: (width) => {
        if (Number.isFinite(width)) set({ sidebarWidth: Math.round(width) })
      },
      setDockRatio: (ratio) => {
        if (Number.isFinite(ratio) && ratio > 0 && ratio < 1) set({ dockRatio: ratio })
      },
      resetDockRatio: () => set({ dockRatio: DOCK_DEFAULT_RATIO }),
      setDockMaximized: (value) => {
        if (get().dockMaximized !== value) set({ dockMaximized: value })
      },
      toggleDockMaximized: () => set((state) => ({ dockMaximized: !state.dockMaximized })),
    }),
    {
      name: LAYOUT_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ sidebarCollapsed, sidebarWidth, dockRatio }) => ({ sidebarCollapsed, sidebarWidth, dockRatio }),
    },
  ),
)
