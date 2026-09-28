import { beforeEach, describe, expect, it, mock } from 'bun:test'

let isTauri = true
let focused = false
let visible = true
let minimized = false
let permissionGranted = true
let permissionResult: 'granted' | 'denied' = 'granted'
let os = 'macos'
const mockRequestPermission = mock(async () => permissionResult)
const mockNotify = mock(async () => undefined)
const mockPlay = mock(async () => undefined)
type TapEvent = { actionId?: unknown; notification?: { id?: unknown } }
let actionListener: ((event: TapEvent) => void) | null = null

mock.module('@/hooks/use-platform', () => ({
  getPlatform: () => ({ isTauri, os, isMacOverlay: isTauri && os === 'macos' }),
}))

mock.module('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isFocused: async () => focused,
    isVisible: async () => visible,
    isMinimized: async () => minimized,
  }),
}))

mock.module('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => permissionGranted,
  requestPermission: mockRequestPermission,
  onAction: async (cb: (event: TapEvent) => void) => {
    actionListener = cb
    return { unregister: async () => { actionListener = null } }
  },
}))

mock.module('@tauri-apps/api/core', () => ({
  invoke: mockNotify,
}))

import { listenForNotificationTaps, sendDesktopNotification } from '../../lib/desktop-notifications'

const payload = {
  kind: 'assistant_done' as const,
  sessionId: 'session-123',
  mode: 'coding' as const,
  title: 'Session completed - openagentd',
  body: 'Fix notification wording',
}

beforeEach(() => {
  window.localStorage.clear()
  isTauri = true
  focused = false
  visible = true
  minimized = false
  permissionGranted = true
  permissionResult = 'granted'
  os = 'macos'
  actionListener = null
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  mockRequestPermission.mockClear()
  mockNotify.mockClear()
  mockPlay.mockClear()
  globalThis.Audio = mock(() => ({ play: mockPlay })) as unknown as typeof Audio
})

describe('desktop notification worker', () => {
  it('unfocused native send', async () => {
    const result = await sendDesktopNotification(payload)

    expect(result.status).toBe('sent')
    expect(mockNotify).toHaveBeenCalledWith('show_desktop_notification', {
      payload: {
        kind: 'assistant_done',
        sessionId: 'session-123',
        title: 'Session completed - openagentd',
        body: 'Fix notification wording',
      },
    })
    expect(mockPlay).not.toHaveBeenCalled()
  })

  it('focused skip and forced send', async () => {
    focused = true

    expect((await sendDesktopNotification(payload)).status).toBe('disabled')
    expect(mockNotify).not.toHaveBeenCalled()
    expect(mockPlay).not.toHaveBeenCalled()

    expect((await sendDesktopNotification(payload, { force: true })).status).toBe('sent')
    expect(mockNotify).toHaveBeenCalledTimes(1)
    expect(mockPlay).not.toHaveBeenCalled()
  })

  it('mobile plugin send without desktop focus skip or in-app sound', async () => {
    os = 'ios'
    focused = true

    const result = await sendDesktopNotification(payload)

    // The mobile shell has no show_desktop_notification command; it sends
    // through the notification plugin itself.
    expect(result.status).toBe('sent')
    expect(mockNotify).toHaveBeenCalledWith('plugin:notification|notify', {
      options: {
        id: expect.any(Number),
        title: 'Session completed - openagentd',
        body: 'Fix notification wording',
        group: 'openagentd-assistant_done',
      },
    })
    expect(mockPlay).not.toHaveBeenCalled()
  })

  it('mobile on-screen skip only while the page is visible', async () => {
    os = 'ios'

    // Watching the session that finished: the banner would repeat the screen.
    expect((await sendDesktopNotification(payload, { sessionOnScreen: true })).status).toBe('disabled')
    expect(mockNotify).not.toHaveBeenCalled()

    // Another session, or the app just went to the background: notify.
    expect((await sendDesktopNotification(payload, { sessionOnScreen: false })).status).toBe('sent')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    expect((await sendDesktopNotification(payload, { sessionOnScreen: true })).status).toBe('sent')
    expect(mockNotify).toHaveBeenCalledTimes(2)
  })

  it('mobile tap opens the notified session', async () => {
    os = 'ios'
    const opened: string[] = []
    const stop = await listenForNotificationTaps((sessionId) => opened.push(sessionId))

    await sendDesktopNotification(payload)
    const [, args] = mockNotify.mock.calls[0] as unknown as [string, { options: { id: number } }]
    const id = args.options.id

    actionListener?.({ actionId: 'dismiss', notification: { id } })
    actionListener?.({ actionId: 'tap', notification: { id: id + 1 } })
    actionListener?.({ actionId: 'tap', notification: { id } })
    expect(opened).toEqual(['session-123'])

    stop()
    expect(actionListener).toBeNull()
  })

  it('desktop tap listener is a no-op', async () => {
    const stop = await listenForNotificationTaps(() => {})

    expect(actionListener).toBeNull()
    stop()
  })

  it('unsupported runtime', async () => {
    isTauri = false

    const result = await sendDesktopNotification(payload)

    expect(result.status).toBe('unsupported')
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('permission denied', async () => {
    permissionGranted = false
    permissionResult = 'denied'

    const first = await sendDesktopNotification(payload, { force: true })
    const second = await sendDesktopNotification(payload, { force: true })

    expect(first.status).toBe('permission-denied')
    expect(second.status).toBe('permission-denied')
    expect(mockRequestPermission).toHaveBeenCalledTimes(1)
    expect(mockNotify).not.toHaveBeenCalled()
  })
})
