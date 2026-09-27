import { describe, expect, it } from 'bun:test'

import type { ContentBlock } from '@/api/types'
import { currentStep, formatElapsed, lastTurnChanges } from '@/components/ComposerIsland.status'

let seq = 0
const block = (type: ContentBlock['type'], content = '', extra: Partial<ContentBlock> = {}): ContentBlock => ({
  id: `b${seq++}`,
  type,
  content,
  ...extra,
})
const tool = (toolName: string, args: Record<string, unknown>, done = false, toolResult?: string): ContentBlock =>
  block('tool', '', { toolName, toolArgs: JSON.stringify(args), toolDone: done, toolResult })
const patch = (path: string, added: string) => tool(
  'patch',
  { patch_text: `*** Begin Patch\n*** Update File: ${path}\n@@\n-old\n+${added}\n*** End Patch` },
  true,
  '[Succeeded]',
)

describe('currentStep', () => {
  it('names the file a running read opens', () => {
    expect(currentStep([block('user', 'hi'), tool('read', { path: 'src/app/main.tsx' })])).toBe('Reading main.tsx')
  })

  it('names the files a running patch edits', () => {
    const running = tool('patch', { patch_text: '*** Begin Patch\n*** Update File: web/a.ts\n@@\n-x\n+y\n*** End Patch' })
    expect(currentStep([running])).toBe('Editing a.ts')
  })

  it('uses a shell command description as the step', () => {
    expect(currentStep([tool('shell', { command: 'bun test', description: 'Run the web tests' })])).toBe('Run the web tests')
  })

  it('says the agent is thinking or writing from its newest block', () => {
    expect(currentStep([block('thinking', 'Considering…')])).toBe('Thinking')
    expect(currentStep([block('thinking', 'Plan'), block('text', 'Here is')])).toBe('Writing')
  })

  it('skips blank chunks that render nothing', () => {
    expect(currentStep([block('thinking', 'Plan'), block('text', '  ')])).toBe('Thinking')
  })

  it('reports a parallel call that is still running after a later one finished', () => {
    const slow = tool('shell', { command: 'make', description: 'Build the app' })
    const fast = tool('read', { path: 'a.ts' }, true)
    expect(currentStep([slow, fast])).toBe('Build the app')
  })

  it('is thinking between a finished call and the next step', () => {
    expect(currentStep([tool('read', { path: 'a.ts' }, true)])).toBe('Thinking')
  })

  it('is starting until the turn produces something', () => {
    expect(currentStep([])).toBe('Starting')
    expect(currentStep([block('user', 'go')])).toBe('Starting')
  })
})

describe('formatElapsed', () => {
  it('reads as a clock', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(42_900)).toBe('0:42')
    expect(formatElapsed(12 * 60_000 + 5_000)).toBe('12:05')
    expect(formatElapsed(3_723_000)).toBe('1:02:03')
  })

  it('never goes negative across a clock skew', () => {
    expect(formatElapsed(-500)).toBe('0:00')
  })
})

describe('lastTurnChanges', () => {
  it('counts only the files changed since the last prompt', () => {
    const blocks = [
      block('user', 'first'),
      patch('old.ts', 'a'),
      block('user', 'second'),
      patch('a.ts', 'b'),
      block('user', 'report', { extra: { from_agent: 'explorer' } }),
      patch('b.ts', 'c'),
    ]
    const changes = lastTurnChanges(blocks)
    expect(changes.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts'])
    expect(changes.additions).toBe(2)
    expect(changes.deletions).toBe(2)
  })
})
