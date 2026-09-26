import { describe, expect, it } from 'bun:test'

import {
  CHAT_MIN_WIDTH,
  DOCK_DEFAULT_RATIO,
  DOCK_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  ratioFromWidth,
  resolveDockLayout,
  resolveSidebarCollapsed,
} from '@/lib/workbench-layout'

describe('resolveSidebarCollapsed', () => {
  it('keeps an explicit user choice regardless of viewport', () => {
    expect(resolveSidebarCollapsed(true, 1920)).toBe(true)
    expect(resolveSidebarCollapsed(false, 820)).toBe(false)
  })

  it('defaults to expanded on wide windows and collapsed on narrow ones', () => {
    expect(resolveSidebarCollapsed(null, 1280)).toBe(false)
    expect(resolveSidebarCollapsed(null, 1279)).toBe(true)
    expect(resolveSidebarCollapsed(undefined, 820)).toBe(true)
  })
})

describe('clampSidebarWidth', () => {
  it('clamps into the min/max band on wide windows', () => {
    expect(clampSidebarWidth(100, 1920)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(900, 1920)).toBe(SIDEBAR_MAX_WIDTH)
    expect(clampSidebarWidth(300, 1920)).toBe(300)
  })

  it('never exceeds what leaves room for chat + dock, but never drops below the minimum', () => {
    expect(clampSidebarWidth(440, 1024)).toBe(1024 - CHAT_MIN_WIDTH - DOCK_MIN_WIDTH)
    expect(clampSidebarWidth(440, 820)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('falls back to the default for non-finite widths', () => {
    expect(clampSidebarWidth(Number.NaN, 1920)).toBe(264)
  })
})

describe('resolveDockLayout', () => {
  it('sizes the dock as a ratio of the center at common window widths', () => {
    expect(resolveDockLayout({ centerWidth: 1280 - 264, ratio: DOCK_DEFAULT_RATIO, maximized: false }))
      .toEqual({ mode: 'side', width: 457 })
    expect(resolveDockLayout({ centerWidth: 1280, ratio: DOCK_DEFAULT_RATIO, maximized: false }))
      .toEqual({ mode: 'side', width: 576 })
    expect(resolveDockLayout({ centerWidth: 1920 - 264, ratio: DOCK_DEFAULT_RATIO, maximized: false }))
      .toEqual({ mode: 'side', width: 745 })
  })

  it('keeps the chat at least CHAT_MIN wide and the dock at least DOCK_MIN wide', () => {
    const center = 1024 - 264
    expect(resolveDockLayout({ centerWidth: center, ratio: 0.95, maximized: false }).width).toBe(center - CHAT_MIN_WIDTH)
    expect(resolveDockLayout({ centerWidth: center, ratio: 0.05, maximized: false }).width).toBe(DOCK_MIN_WIDTH)
  })

  it('overlays the chat when maximized or when the center is too narrow for a split', () => {
    expect(resolveDockLayout({ centerWidth: 1016, ratio: 0.45, maximized: true })).toEqual({ mode: 'overlay', width: 1016 })
    expect(resolveDockLayout({ centerWidth: 820 - 264, ratio: 0.45, maximized: false })).toEqual({ mode: 'overlay', width: 556 })
    expect(resolveDockLayout({ centerWidth: CHAT_MIN_WIDTH + DOCK_MIN_WIDTH, ratio: 0.45, maximized: false }).mode).toBe('side')
  })

  it('treats an invalid ratio as the default', () => {
    expect(resolveDockLayout({ centerWidth: 1000, ratio: Number.NaN, maximized: false }).width).toBe(450)
  })
})

describe('ratioFromWidth', () => {
  it('converts a committed width back to a bounded ratio', () => {
    expect(ratioFromWidth(500, 1000)).toBe(0.5)
    expect(ratioFromWidth(5000, 1000)).toBe(0.95)
    expect(ratioFromWidth(500, 0)).toBe(DOCK_DEFAULT_RATIO)
  })
})
