import { afterEach, describe, expect, it } from 'bun:test'

import {
  DEFAULT_TRANSCRIPT_FONT_SIZE,
  TRANSCRIPT_FONT_SIZES,
  TRANSCRIPT_STORAGE_KEY,
  transcriptStyle,
  useTranscriptStore,
} from '@/stores/useTranscriptStore'

afterEach(() => {
  useTranscriptStore.setState({ density: 'comfortable', fontSize: DEFAULT_TRANSCRIPT_FONT_SIZE })
  localStorage.removeItem(TRANSCRIPT_STORAGE_KEY)
})

describe('useTranscriptStore', () => {
  it('steps the font size through its scale and stops at either end', () => {
    const { stepFontSize } = useTranscriptStore.getState()
    stepFontSize(1)
    expect(useTranscriptStore.getState().fontSize).toBe(15)
    for (let i = 0; i < 10; i++) stepFontSize(1)
    expect(useTranscriptStore.getState().fontSize).toBe(TRANSCRIPT_FONT_SIZES.at(-1))
    for (let i = 0; i < 10; i++) stepFontSize(-1)
    expect(useTranscriptStore.getState().fontSize).toBe(TRANSCRIPT_FONT_SIZES[0])
    useTranscriptStore.getState().resetFontSize()
    expect(useTranscriptStore.getState().fontSize).toBe(DEFAULT_TRANSCRIPT_FONT_SIZE)
  })

  it('keeps the 11px floor', () => {
    expect(Math.min(...TRANSCRIPT_FONT_SIZES)).toBeGreaterThanOrEqual(11)
  })

  it('remembers density and size', () => {
    useTranscriptStore.getState().setDensity('compact')
    useTranscriptStore.getState().stepFontSize(1)

    const stored = JSON.parse(localStorage.getItem(TRANSCRIPT_STORAGE_KEY) ?? '{}')
    expect(stored.state).toEqual({ density: 'compact', fontSize: 15 })
  })

  it('ignores stored values it does not know', async () => {
    localStorage.setItem(TRANSCRIPT_STORAGE_KEY, JSON.stringify({ state: { density: 'tiny', fontSize: 9 }, version: 0 }))
    await useTranscriptStore.persist.rehydrate()

    expect(useTranscriptStore.getState()).toMatchObject({ density: 'comfortable', fontSize: DEFAULT_TRANSCRIPT_FONT_SIZE })
  })
})

describe('transcriptStyle', () => {
  it('sets the reading size in rem and the rhythm for the density', () => {
    expect(transcriptStyle('comfortable', 16)).toMatchObject({
      '--transcript-font-size': '1rem',
      '--transcript-turn-gap': '0.75rem',
    })
    const compact = transcriptStyle('compact', 14) as Record<string, string>
    const relaxed = transcriptStyle('relaxed', 14) as Record<string, string>
    expect(parseFloat(compact['--transcript-turn-gap'])).toBeLessThan(parseFloat(relaxed['--transcript-turn-gap']))
    expect(Number(compact['--transcript-line-height'])).toBeLessThan(Number(relaxed['--transcript-line-height']))
  })
})
