import { describe, expect, it } from 'bun:test'

import type { ContentBlock } from '@/api/types'
import { sessionTouchedPaths } from '@/components/AgentChatView/helpers'

const WORKSPACE = '/repo'

function tool(id: string, toolName: string, args: unknown): ContentBlock {
  return { id, type: 'tool', content: '', toolName, toolArgs: typeof args === 'string' ? args : JSON.stringify(args) }
}

function patch(...lines: string[]): { patch_text: string } {
  return { patch_text: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') }
}

describe('sessionTouchedPaths — files the agents read or patched', () => {
  it('lists them newest first, relative to the workspace, each once', () => {
    const blocks = [
      tool('t1', 'read', { path: 'web/src/a.ts' }),
      tool('t2', 'patch', patch('*** Update File: /repo/web/src/b.ts', '@@', '-x', '+y', '*** Add File: web/src/c.ts', '+z')),
      { id: 'x1', type: 'text', content: 'Done: `a.ts`' } as ContentBlock,
      tool('t3', 'read', { file_path: './web/src/a.ts' }),
    ]
    const live = [tool('t4', 'patch', patch('*** Update File: web/src/old.ts', '*** Move to: web/src/new.ts', '@@', '-a', '+b'))]

    expect(sessionTouchedPaths({ lead: { blocks, currentBlocks: live } }, 'lead', WORKSPACE)).toEqual([
      'web/src/new.ts',
      'web/src/a.ts',
      'web/src/b.ts',
      'web/src/c.ts',
    ])
  })

  it("puts the lead's files before its members'", () => {
    const streams = {
      reviewer: { blocks: [tool('m1', 'read', { path: 'docs/review.md' })], currentBlocks: [] },
      lead: { blocks: [tool('l1', 'read', { path: 'src/main.rs' })], currentBlocks: [] },
    }

    expect(sessionTouchedPaths(streams, 'lead', WORKSPACE)).toEqual(['src/main.rs', 'docs/review.md'])
  })

  it('skips other tools, unparsable arguments, and paths outside the workspace', () => {
    const blocks = [
      tool('t1', 'grep', { path: 'src/hit.ts', pattern: 'x' }),
      tool('t2', 'read', '{"path": "src/stre'),
      tool('t3', 'read', { path: '/elsewhere/a.ts' }),
      tool('t4', 'read', { path: 42 }),
    ]

    expect(sessionTouchedPaths({ lead: { blocks, currentBlocks: [] } }, 'lead', WORKSPACE)).toEqual([])
  })
})
