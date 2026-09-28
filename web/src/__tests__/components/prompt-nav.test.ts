import { describe, expect, it } from 'bun:test'

import { promptJumpTarget } from '@/components/AgentView/prompt-nav'

// Prompt tops, in px from the transcript's top edge, in transcript order.
const TOPS = [-500, -100, 12, 300]

describe('promptJumpTarget', () => {
  it('steps past a prompt that already sits on the line', () => {
    expect(promptJumpTarget(TOPS, 12, -1)).toBe(1)
    expect(promptJumpTarget(TOPS, 12, 1)).toBe(3)
  })

  it('finds nothing beyond either end', () => {
    expect(promptJumpTarget(TOPS, -600, -1)).toBe(-1)
    expect(promptJumpTarget(TOPS, 400, 1)).toBe(-1)
  })
})
