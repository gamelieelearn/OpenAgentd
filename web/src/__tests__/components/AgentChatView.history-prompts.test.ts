import { describe, expect, it } from 'bun:test'

import type { ContentBlock } from '@/api/types'
import { composerHistoryPrompts, newestUserBlockId } from '@/components/AgentChatView/helpers'

const user = (id: string, content: string, fromAgent?: string): ContentBlock => ({
  id,
  type: 'user',
  content,
  ...(fromAgent ? { extra: { from_agent: fromAgent } } : {}),
})

const blocks: ContentBlock[] = [
  user('u1', 'first prompt'),
  { id: 'a1', type: 'text', content: 'an answer' },
  user('r1', 'explorer: found three call sites', 'explorer#1'),
  user('u2', '   '),
  user('u3', 'second prompt', 'user'),
  user('r2', 'second prompt', 'reviewer'),
]

describe('composer ↑/↓ recall', () => {
  it('offers the prompts the user wrote, newest first, without sub-agent reports', () => {
    expect(composerHistoryPrompts(blocks)).toEqual(['second prompt', 'first prompt'])
  })

  it('shows a recalled prompt at the prompt, not at a report with the same text', () => {
    expect(newestUserBlockId(blocks, 'second prompt')).toBe('u3')
    expect(newestUserBlockId(blocks, 'explorer: found three call sites')).toBeUndefined()
  })
})
