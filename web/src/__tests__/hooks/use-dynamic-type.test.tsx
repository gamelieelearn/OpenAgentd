import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'

let platform = { isTauri: true, os: 'ios' }
const stop = mock(() => {})
const follow = mock(() => stop)
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => platform, usePlatform: () => platform }))
mock.module('@/lib/dynamic-type', () => ({ followDynamicType: follow }))

const { useDynamicType } = await import('@/hooks/use-dynamic-type')

afterEach(() => {
  cleanup()
  follow.mockClear()
  stop.mockClear()
})

describe('useDynamicType', () => {
  it('follows the system text size in the iOS app and stops on unmount', () => {
    platform = { isTauri: true, os: 'ios' }
    const { unmount } = renderHook(() => useDynamicType())
    expect(follow).toHaveBeenCalledTimes(1)
    unmount()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('leaves other shells alone (macOS resolves the body style to 13px)', () => {
    for (const next of [{ isTauri: true, os: 'macos' }, { isTauri: false, os: 'ios' }, { isTauri: true, os: 'android' }]) {
      platform = next
      renderHook(() => useDynamicType())
    }
    expect(follow).not.toHaveBeenCalled()
  })
})
