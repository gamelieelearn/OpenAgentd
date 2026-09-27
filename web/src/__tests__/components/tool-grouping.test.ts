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
  it('leaves a single read-only call alone', () => {
    const blocks = [tool('t1', 'read', { path: 'a.ts' }), text('x')]
    expect(groupToolRuns(blocks, { live: false }).map((s) => s.kind)).toEqual(['block', 'block'])
  })

  it('folds consecutive read-only calls between prose', () => {
    const blocks = [
      text('intro'),
      tool('t1', 'read', { path: 'a.ts' }),
      tool('t2', 'grep', { pattern: 'x' }),
      tool('t3', 'glob', { pattern: '*.ts' }),
      text('answer'),
    ]
    expect(groupToolRuns(blocks, { live: false })).toEqual([
      { kind: 'block', index: 0 },
      { kind: 'group', start: 1, end: 4, summary: expect.anything() },
      { kind: 'block', index: 4 },
    ])
  })

  it('keeps edits, shell commands, failures, and thinking on their own rows', () => {
    const failed = tool('t4', 'read', { path: 'gone.ts' }, { toolResult: 'Error: file not found' })
    const blocks = [
      tool('t1', 'read', { path: 'a.ts' }),
      tool('t2', 'patch', { patch_text: '' }),
      tool('t3', 'read', { path: 'b.ts' }),
      tool('s', 'shell', { command: 'ls' }),
      tool('t5', 'read', { path: 'c.ts' }),
      failed,
      tool('t6', 'read', { path: 'd.ts' }),
      thinking('th'),
      tool('t7', 'read', { path: 'e.ts' }),
    ]
    expect(groupToolRuns(blocks, { live: false }).every((s) => s.kind === 'block')).toBe(true)
  })

  it('never folds a question or an interactive app result', () => {
    const app = tool('t3', 'read', {}, { extra: { mcp_app: { uri: 'ui://x' } } })
    const blocks = [tool('t1', 'read', { path: 'a.ts' }), tool('q', 'ask_user'), tool('t2', 'read', { path: 'b.ts' }), app]
    expect(groupToolRuns(blocks, { live: false }).every((s) => s.kind === 'block')).toBe(true)
  })

  it('absorbs blank text chunks, which render nothing', () => {
    const blocks = [tool('t1', 'read'), text('blank', '  \n'), tool('t2', 'read')]
    expect(groupToolRuns(blocks, { live: false })).toEqual([
      { kind: 'group', start: 0, end: 3, summary: expect.anything() },
    ])
  })

  it('keeps the call in flight, and the newest finished one, visible while the turn runs', () => {
    const blocks = [tool('t1', 'read'), tool('t2', 'grep'), tool('t3', 'read'), tool('t4', 'read', {}, { toolDone: false, toolResult: undefined })]
    expect(groupToolRuns(blocks, { live: true })).toEqual([
      { kind: 'group', start: 0, end: 2, summary: expect.anything() },
      { kind: 'block', index: 2 },
      { kind: 'block', index: 3 },
    ])
  })

  it('folds the whole trailing run once the turn has closed', () => {
    const blocks = [tool('t1', 'read'), tool('t2', 'read'), tool('t3', 'read')]
    expect(groupToolRuns(blocks, { live: false })).toEqual([
      { kind: 'group', start: 0, end: 3, summary: expect.anything() },
    ])
  })
})

describe('summarizeToolRun', () => {
  it('reads as "Explored" with call counts per kind', () => {
    const summary = summarizeToolRun([
      tool('r1', 'read', { path: 'src/a.ts' }),
      tool('r2', 'read', { path: 'src/a.ts' }),
      tool('r3', 'read', { path: 'src/b.ts' }),
      tool('g', 'grep', { pattern: 'x' }),
      tool('w', 'web_search', { query: 'x' }),
      tool('f', 'web_fetch', { url: 'https://x' }),
    ])
    expect(summary).toEqual({ label: 'Explored · 3 reads, 2 searches, 1 fetch', toolCount: 6 })
  })

  it('uses the singular for one call', () => {
    expect(summarizeToolRun([tool('a', 'read'), tool('b', 'lsp')]).label).toBe('Explored · 1 read, 1 search')
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
    expect(changes).toMatchObject({
      files: [
        { path: 'src/b.ts', kind: 'update', additions: 2, deletions: 1 },
        { path: 'src/new.ts', kind: 'add', additions: 3, deletions: 0 },
      ],
      additions: 5,
      deletions: 1,
    })
  })

  it('keeps each edit to a file as its own diff, oldest first, numbered from the result', () => {
    const meta = '@@ openagentd-diff-meta {"files":[{"path":"src/b.ts","hunks":[{"old_start":40,"new_start":41}]}]}'
    const changes = summarizeTurnChanges([
      tool('p1', 'patch', patch('src/b.ts', '-x\n+y'), { toolResult: `${meta}\nPatch applied successfully.` }),
      tool('p2', 'patch', patch('src/b.ts', '+z')),
    ])

    const [file] = changes.files
    expect(file.diffs.map((diff) => diff.lines.map((line) => `${line.type}:${line.value}`))).toEqual([
      ['removed:x', 'added:y'],
      ['added:z'],
    ])
    expect(file.diffs[0].hunkStarts).toEqual([{ oldStart: 40, newStart: 41 }])
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
    expect(changes.files).toHaveLength(1)
    expect(changes.files[0]).toMatchObject({ path: 'a.ts', kind: 'delete', additions: 1, deletions: 0 })
  })
})
