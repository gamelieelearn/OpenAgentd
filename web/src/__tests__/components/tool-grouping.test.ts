import { describe, expect, it } from 'bun:test'

import type { ContentBlock } from '@/api/types'
import { groupToolRuns, patchFileStats, summarizeToolRun, summarizeTurnChanges } from '@/components/ToolCall/grouping'

function tool(id: string, name: string, args: Record<string, unknown> = {}, extra: Partial<ContentBlock> = {}): ContentBlock {
  return { id, type: 'tool', content: '', toolName: name, toolArgs: JSON.stringify(args), toolDone: true, toolResult: 'ok', ...extra }
}
const text = (id: string, content = 'Answer'): ContentBlock => ({ id, type: 'text', content })
const thinking = (id: string): ContentBlock => ({ id, type: 'thinking', content: 'Considering' })
const patch = (path: string, body: string) => ({ patch_text: `*** Begin Patch\n*** Update File: ${path}\n@@\n${body}\n*** End Patch` })

describe('groupToolRuns', () => {
  it('leaves short runs alone', () => {
    const blocks = [tool('t1', 'read', { path: 'a.ts' }), tool('t2', 'read', { path: 'b.ts' }), text('x')]
    expect(groupToolRuns(blocks, { live: false }).map((s) => s.kind)).toEqual(['block', 'block', 'block'])
  })

  it('folds a finished run of three or more rows between prose', () => {
    const blocks = [
      text('intro'),
      tool('t1', 'read', { path: 'a.ts' }),
      thinking('th'),
      tool('t2', 'grep', { pattern: 'x' }),
      text('answer'),
    ]
    const segments = groupToolRuns(blocks, { live: false })
    expect(segments).toEqual([
      { kind: 'block', index: 0 },
      { kind: 'group', start: 1, end: 4, summary: expect.anything() },
      { kind: 'block', index: 4 },
    ])
  })

  it('never folds a question or an interactive app result', () => {
    const app = tool('t3', 'dashboard', {}, { extra: { mcp_app: { uri: 'ui://x' } } })
    const blocks = [
      tool('t1', 'read', { path: 'a.ts' }),
      tool('t2', 'read', { path: 'b.ts' }),
      tool('q', 'ask_user'),
      tool('t4', 'read', { path: 'c.ts' }),
      app,
      tool('t5', 'read', { path: 'd.ts' }),
    ]
    expect(groupToolRuns(blocks, { live: false }).every((s) => s.kind === 'block')).toBe(true)
  })

  it('keeps the tool in flight, and anything after it, outside the group while the turn runs', () => {
    const blocks = [
      tool('t1', 'read', { path: 'a.ts' }),
      tool('t2', 'read', { path: 'b.ts' }),
      tool('t3', 'shell', { command: 'ls' }),
      tool('t4', 'shell', { command: 'bun test' }, { toolDone: false }),
      thinking('th'),
    ]
    expect(groupToolRuns(blocks, { live: true })).toEqual([
      { kind: 'group', start: 0, end: 3, summary: expect.anything() },
      { kind: 'block', index: 3 },
      { kind: 'block', index: 4 },
    ])
  })

  it('keeps the newest tool visible while the turn runs, even once it has finished', () => {
    const blocks = [tool('t1', 'read'), tool('t2', 'read'), tool('t3', 'read'), tool('t4', 'read')]
    const segments = groupToolRuns(blocks, { live: true })
    expect(segments.at(-1)).toEqual({ kind: 'block', index: 3 })
    expect(segments[0]).toMatchObject({ kind: 'group', start: 0, end: 3 })
  })

  it('folds the whole trailing run once the turn has closed', () => {
    const blocks = [tool('t1', 'read'), tool('t2', 'read'), tool('t3', 'read')]
    expect(groupToolRuns(blocks, { live: false })).toEqual([
      { kind: 'group', start: 0, end: 3, summary: expect.anything() },
    ])
  })
})

describe('summarizeToolRun', () => {
  it('counts distinct files read and edited, commands, and searches', () => {
    const summary = summarizeToolRun([
      tool('r1', 'read', { path: 'src/a.ts' }),
      tool('r2', 'read', { path: 'src/a.ts' }),
      tool('r3', 'read', { path: 'src/b.ts' }),
      tool('g', 'grep', { pattern: 'x' }),
      tool('s', 'shell', { command: 'ls' }),
      tool('p', 'patch', patch('src/a.ts', '-old\n+new\n+more')),
      thinking('th'),
    ])
    expect(summary.label).toBe('Edited 1 file, read 2 files, ran 1 search, ran 1 command')
    expect(summary).toMatchObject({ toolCount: 6, failed: 0, additions: 2, deletions: 1 })
  })

  it('names tools outside the known categories generically', () => {
    expect(summarizeToolRun([tool('a', 'note'), tool('b', 'todo_manage')]).label).toBe('Used 2 tools')
    expect(summarizeToolRun([tool('a', 'read', { path: 'a' }), tool('b', 'note')]).label).toBe('Read 1 file, used 1 other tool')
  })

  it('counts failures', () => {
    const summary = summarizeToolRun([
      tool('a', 'shell', { command: 'x' }, { toolResult: '[Failed — exit code 1]\nboom' }),
      tool('b', 'shell', { command: 'y' }),
    ])
    expect(summary.failed).toBe(1)
    expect(summary.label).toBe('Ran 2 commands')
  })
})

describe('patchFileStats', () => {
  it('reports each touched file with its own line counts', () => {
    const args = JSON.stringify({
      patch_text: '*** Begin Patch\n*** Add File: new.ts\n+a\n+b\n*** Update File: old.ts\n@@\n-x\n+y\n*** Delete File: gone.ts\n*** End Patch',
    })
    expect(patchFileStats(args)).toEqual([
      { path: 'new.ts', kind: 'add', additions: 2, deletions: 0 },
      { path: 'old.ts', kind: 'update', additions: 1, deletions: 1 },
      { path: 'gone.ts', kind: 'delete', additions: 0, deletions: 0 },
    ])
  })

  it('reports a moved file under its new path', () => {
    const args = JSON.stringify({ patch_text: '*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n*** End Patch' })
    expect(patchFileStats(args)).toEqual([{ path: 'b.ts', kind: 'update', additions: 1, deletions: 1 }])
  })

  it('returns nothing for unparsable arguments', () => {
    expect(patchFileStats('{not json')).toEqual([])
    expect(patchFileStats(undefined)).toEqual([])
  })
})

describe('summarizeTurnChanges', () => {
  it('merges every successful edit to a path, in first-touched order', () => {
    const changes = summarizeTurnChanges([
      tool('p1', 'patch', patch('src/b.ts', '-x\n+y')),
      text('mid'),
      tool('p2', 'patch', { patch_text: '*** Begin Patch\n*** Add File: src/new.ts\n+a\n+b\n*** End Patch' }),
      tool('p3', 'patch', patch('src/b.ts', '+z')),
      tool('p4', 'patch', patch('src/new.ts', '+c')),
    ])
    expect(changes).toEqual({
      files: [
        { path: 'src/b.ts', kind: 'update', additions: 2, deletions: 1 },
        { path: 'src/new.ts', kind: 'add', additions: 3, deletions: 0 },
      ],
      additions: 5,
      deletions: 1,
    })
  })

  it('ignores failed and unfinished edits', () => {
    const changes = summarizeTurnChanges([
      tool('p1', 'patch', patch('a.ts', '+x'), { toolResult: 'Error: context not found' }),
      tool('p2', 'patch', patch('b.ts', '+x'), { toolDone: false, toolResult: undefined }),
    ])
    expect(changes.files).toEqual([])
  })

  it('reports a file deleted after being edited as deleted', () => {
    const changes = summarizeTurnChanges([
      tool('p1', 'patch', patch('a.ts', '+x')),
      tool('p2', 'patch', { patch_text: '*** Begin Patch\n*** Delete File: a.ts\n*** End Patch' }),
    ])
    expect(changes.files).toEqual([{ path: 'a.ts', kind: 'delete', additions: 1, deletions: 0 }])
  })
})
