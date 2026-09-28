import { afterEach, describe, expect, it } from 'bun:test'

import { DISPLAY_PREFS_STORAGE_KEY, useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'

afterEach(() => {
  useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' })
  localStorage.removeItem(DISPLAY_PREFS_STORAGE_KEY)
})

describe('useDisplayPrefsStore — transcript style', () => {
  it('starts detailed and remembers a switch to reader', () => {
    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('detailed')

    useDisplayPrefsStore.getState().setTranscriptStyle('reader')

    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('reader')
    expect(JSON.parse(localStorage.getItem(DISPLAY_PREFS_STORAGE_KEY) ?? '{}').state).toEqual({ transcriptStyle: 'reader' })
  })

  it('falls back to detailed for a stored style it does not know', async () => {
    localStorage.setItem(DISPLAY_PREFS_STORAGE_KEY, JSON.stringify({ state: { transcriptStyle: 'compact' }, version: 0 }))

    await useDisplayPrefsStore.persist.rehydrate()

    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('detailed')
  })
})
