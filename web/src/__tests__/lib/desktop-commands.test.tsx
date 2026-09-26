import { afterEach, describe, expect, it, mock } from 'bun:test'
import { render, waitFor } from '@testing-library/react'

// The hook reads the router from context; supply a stub without mounting the
// route tree.
const navigate = mock(async () => {})
mock.module('@tanstack/react-router', () => ({ useRouter: () => ({ navigate }) }))

import { useDesktopCommands } from '@/lib/desktop-commands'
import { useUIStore } from '@/stores/useUIStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

let listener: ((event: { payload: unknown }) => void) | null = null
let notificationListener: ((event: { payload: unknown }) => void) | null = null
let unlistenCalls = 0

mock.module('@tauri-apps/api/event', () => ({
  listen: async (event: string, cb: (event: { payload: unknown }) => void) => {
    if (event === 'desktop-command') listener = cb
    else notificationListener = cb
    return () => {
      unlistenCalls += 1
      if (event === 'desktop-command') listener = null
      else notificationListener = null
    }
  },
}))

function Harness() {
  useDesktopCommands()
  return null
}

async function renderBridge() {
  const view = render(<Harness />)
  await waitFor(() => expect(listener).not.toBeNull())
  return view
}

function resetUIStore(): void {
  useUIStore.setState({
    schedulerOpen: false,
    agentCapabilitiesOpen: false,
    paletteOpen: false,
  })
  listener = null
  notificationListener = null
  unlistenCalls = 0
  navigate.mockClear()
}

afterEach(resetUIStore)

/** Collect synthetic shortcut keydowns while ``run`` executes. */
async function captureKeys(run: () => Promise<void>): Promise<KeyboardEvent[]> {
  const events: KeyboardEvent[] = []
  const onKeyDown = (event: KeyboardEvent) => events.push(event)
  window.addEventListener('keydown', onKeyDown)
  try {
    await run()
  } finally {
    window.removeEventListener('keydown', onKeyDown)
  }
  return events
}

describe('useDesktopCommands', () => {
  it('routes the scheduler through the in-app Ctrl+S shortcut so the shell picks dock tab or overlay', async () => {
    const events = await captureKeys(async () => {
      await renderBridge()
      listener?.({ payload: 'scheduler' })
    })

    expect(events.map((e) => [e.key, e.ctrlKey, e.metaKey])).toEqual([['s', true, false]])
    // The store flag is left to the shell's handler, not flipped directly.
    expect(useUIStore.getState().schedulerOpen).toBe(false)
  })

  it('toggles session settings through the shared UI store', async () => {
    await renderBridge()

    listener?.({ payload: 'agent_capabilities' })
    expect(useUIStore.getState().agentCapabilitiesOpen).toBe(true)
  })

  it('dispatches the same Ctrl+K keyboard event used by the in-app command palette shortcut', async () => {
    const events: KeyboardEvent[] = []
    const onKeyDown = (event: KeyboardEvent) => events.push(event)
    window.addEventListener('keydown', onKeyDown)
    try {
      await renderBridge()

      listener?.({ payload: 'command_palette' })

      expect(events).toHaveLength(1)
      expect(events[0].key).toBe('k')
      expect(events[0].ctrlKey).toBe(true)
      expect(events[0].metaKey).toBe(false)
      expect(events[0].shiftKey).toBe(false)
      expect(events[0].bubbles).toBe(true)
    } finally {
      window.removeEventListener('keydown', onKeyDown)
    }
  })

  it('deduplicates repeated native emits for the same command but allows a different command immediately', async () => {
    const originalNow = Date.now
    const times = [1_000, 1_100, 1_200]
    Date.now = mock(() => times.shift() ?? 1_200) as typeof Date.now
    try {
      const events = await captureKeys(async () => {
        await renderBridge()
        listener?.({ payload: 'scheduler' })
        listener?.({ payload: 'scheduler' })
      })
      expect(events.map((e) => e.key)).toEqual(['s'])

      listener?.({ payload: 'agent_capabilities' })
      expect(useUIStore.getState().agentCapabilitiesOpen).toBe(true)
    } finally {
      Date.now = originalNow
    }
  })

  it('allows the same command again after the duplicate-suppression window', async () => {
    const originalNow = Date.now
    const times = [2_000, 2_500]
    Date.now = mock(() => times.shift() ?? 2_500) as typeof Date.now
    try {
      const events = await captureKeys(async () => {
        await renderBridge()
        listener?.({ payload: 'scheduler' })
        listener?.({ payload: 'scheduler' })
      })
      expect(events.map((e) => e.key)).toEqual(['s', 's'])
    } finally {
      Date.now = originalNow
    }
  })

  it('ignores unknown payloads instead of mutating UI state or dispatching shortcuts', async () => {
    let keydownCount = 0
    const onKeyDown = () => { keydownCount += 1 }
    window.addEventListener('keydown', onKeyDown)
    try {
      await renderBridge()

      listener?.({ payload: 'not-a-command' })
      listener?.({ payload: null })

      expect(useUIStore.getState()).toMatchObject({
        schedulerOpen: false,
        agentCapabilitiesOpen: false,
      })
      expect(keydownCount).toBe(0)
    } finally {
      window.removeEventListener('keydown', onKeyDown)
    }
  })

  it('opens the Settings modal on the Providers tab for settings_providers', async () => {
    const originalOpenSettings = useSettingsStore.getState().openSettings
    const openSettings = mock(() => {})
    useSettingsStore.setState({ openSettings })
    try {
      await renderBridge()

      listener?.({ payload: 'settings_providers' })

      expect(openSettings).toHaveBeenCalledWith('providers')
    } finally {
      useSettingsStore.setState({ openSettings: originalOpenSettings })
    }
  })

  it('navigates to /coding when the coding command is emitted', async () => {
    await renderBridge()

    listener?.({ payload: 'coding' })

    expect(navigate).toHaveBeenCalledWith({ to: '/coding' })
  })

  it('unsubscribes from the Tauri event bus when the root unmounts', async () => {
    const view = await renderBridge()

    view.unmount()

    expect(unlistenCalls).toBe(2)
    expect(listener).toBeNull()
    expect(notificationListener).toBeNull()
  })
})
