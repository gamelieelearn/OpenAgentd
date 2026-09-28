import { beforeEach, describe, expect, it, mock } from 'bun:test'

let isTauri = true
const setBadgeCount = mock(async (..._args: unknown[]) => {})
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => ({ isTauri, os: 'macos' }) }))
mock.module('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setBadgeCount }) }))

const { buildDesktopWindowTitle, syncDesktopBadgeCount } = await import('@/lib/window-title')

beforeEach(() => {
  isTauri = true
  setBadgeCount.mockClear()
})

describe('buildDesktopWindowTitle', () => {
  it('uses the session title for coding windows when available', () => {
    expect(buildDesktopWindowTitle({ workspace: '/Users/name/Workspace A', sessionTitle: 'Fix updater restart' })).toBe('Fix updater restart')
  })

  it('falls back to the workspace basename for coding windows without a session title', () => {
    expect(buildDesktopWindowTitle({ workspace: '/Users/name/Workspace A' })).toBe('Workspace A')
  })

  it('uses only the session title when no workspace is attached', () => {
    expect(buildDesktopWindowTitle({ sessionTitle: 'Refactor auth flow' })).toBe('Refactor auth flow')
  })

  it('falls back to the app name when no title is available', () => {
    expect(buildDesktopWindowTitle({ sessionTitle: '   ' })).toBe('OpenAgentd')
  })

  it('prefers the chat label over the workspace basename', () => {
    expect(
      buildDesktopWindowTitle({ workspace: '/Users/name', workspaceName: 'Chat' }),
    ).toBe('Chat')
  })

  it('lets the session title win over the workspace label', () => {
    expect(
      buildDesktopWindowTitle({
        workspace: '/Users/name',
        workspaceName: 'Chat',
        sessionTitle: 'Trip planning',
      }),
    ).toBe('Trip planning')
  })

  it('counts sessions that need you in front of the title', () => {
    expect(buildDesktopWindowTitle({ sessionTitle: 'Fix updater restart', needsYou: 2 })).toBe('(2) Fix updater restart')
    expect(buildDesktopWindowTitle({ sessionTitle: 'Fix updater restart', needsYou: 0 })).toBe('Fix updater restart')
  })
})

describe('syncDesktopBadgeCount', () => {
  it('badges the app icon with the count and clears it at zero', async () => {
    await syncDesktopBadgeCount(3)
    await syncDesktopBadgeCount(0)

    expect(setBadgeCount.mock.calls).toEqual([[3], [undefined]])
  })

  it('does nothing outside the desktop app', async () => {
    isTauri = false

    await syncDesktopBadgeCount(3)

    expect(setBadgeCount).not.toHaveBeenCalled()
  })
})
