import { describe, expect, it } from 'bun:test'

import { currentPromptIndex, promptLine } from '@/components/AgentView/prompt-nav'

// Prompt tops, in px from the transcript's top edge, in transcript order.
const TOPS = [-500, -100, 12, 300]

describe('currentPromptIndex', () => {
  it('is the last prompt at or above the line', () => {
    expect(currentPromptIndex(TOPS, 12)).toBe(2)
    expect(currentPromptIndex(TOPS, 0)).toBe(1)
  })

  it('is -1 above the first prompt', () => {
    expect(currentPromptIndex(TOPS, -600)).toBe(-1)
    expect(currentPromptIndex([], 0)).toBe(-1)
  })
})

describe('promptLine', () => {
  it('sits 2.75rem down, just below the prompt bar, and follows the root text size', () => {
    const root = document.documentElement
    const previous = root.style.fontSize
    try {
      root.style.fontSize = '16px'
      expect(promptLine()).toBe(44)
      root.style.fontSize = '20px'
      expect(promptLine()).toBe(55)
    } finally {
      root.style.fontSize = previous
    }
  })
})
