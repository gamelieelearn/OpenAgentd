import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AssistantTurn } from '@/components/AssistantTurnFooter'
import { FileRefContext, type FileRefOpener } from '@/components/FileRefLink'
import type { ContentBlock } from '@/api/types'

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true, writable: true })
})
afterEach(cleanup)

const patchArgs = (...lines: string[]) => JSON.stringify({ patch_text: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') })

const finished: ContentBlock[] = [
  { id: 'think', type: 'thinking', content: 'Where is it?' },
  { id: 'read', type: 'tool', content: '', toolName: 'read', toolArgs: '{"path":"src/a.ts"}', toolDone: true, toolResult: 'x' },
  { id: 'narrate', type: 'text', content: 'Fixing it now.' },
  { id: 'edit', type: 'tool', content: '', toolName: 'patch', toolArgs: patchArgs('*** Update File: src/a.ts', '@@', '-a', '+b', '+c'), toolDone: true, toolResult: 'ok' },
  { id: 'answer', type: 'text', content: 'Done.' },
]

function renderTurn(blocks: ContentBlock[], props: { isWorking?: boolean; findHitBlockIds?: Set<string>; opener?: FileRefOpener } = {}) {
  const turn = (
    <AssistantTurn
      blocks={blocks}
      startIndex={0}
      finalizedCount={props.isWorking ? 0 : blocks.length}
      isWorking={props.isWorking ?? false}
      isTrailingTurn
      totalBlocks={blocks.length}
      reader
      findHitBlockIds={props.findHitBlockIds}
      renderBlock={({ block }) => <p data-testid={`block-${block.id}`}>{block.content || block.id}</p>}
    />
  )
  return render(props.opener ? <FileRefContext.Provider value={props.opener}>{turn}</FileRefContext.Provider> : turn)
}

const rendered = (id: string) => screen.queryByTestId(`block-${id}`)

describe('AssistantTurn — reader mode', () => {
  it('shows the answer and folds the work behind one row that opens it', () => {
    renderTurn(finished)

    expect(rendered('answer')).not.toBeNull()
    for (const id of ['think', 'read', 'narrate', 'edit']) expect(rendered(id)).toBeNull()

    const row = screen.getByRole('button', { name: /1 read, 1 edit/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row)

    expect(row.getAttribute('aria-expanded')).toBe('true')
    for (const id of ['think', 'read', 'narrate', 'edit']) expect(rendered(id)).not.toBeNull()
  })

  it('opens the fold while transcript find matches inside it', () => {
    renderTurn(finished, { findHitBlockIds: new Set(['narrate']) })

    expect(rendered('narrate')).not.toBeNull()
  })

  it('lists the files the turn edited, and opens one from the list', () => {
    const open = mock((..._args: unknown[]) => {})
    renderTurn(finished, { opener: { canOpen: () => true, open } })

    expect(screen.getByText('1 file changed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    expect(open).toHaveBeenCalledWith({ path: 'src/a.ts' })
  })

  it('names the step in progress while the turn runs, and lists no files yet', () => {
    const running: ContentBlock[] = [
      ...finished.slice(0, 4),
      { id: 'test', type: 'tool', content: '', toolName: 'shell', toolArgs: '{"command":"bun test","description":"Run web tests"}', toolDone: false },
    ]
    renderTurn(running, { isWorking: true })

    expect(screen.getByRole('button', { name: /Working · Shell: Run web tests/ })).toBeTruthy()
    expect(screen.queryByText(/files? changed/)).toBeNull()
  })

  it('says a thought-only trace thought, and counts failures', () => {
    renderTurn([
      { id: 'think', type: 'thinking', content: 'Hmm.' },
      { id: 'run', type: 'tool', content: '', toolName: 'shell', toolArgs: '{"command":"false"}', toolDone: true, toolResult: '[Failed — exit code 1]' },
      { id: 'answer', type: 'text', content: 'It failed.' },
    ])
    expect(screen.getByRole('button', { name: /1 command · 1 failed/ })).toBeTruthy()
    cleanup()

    renderTurn([{ id: 'think', type: 'thinking', content: 'Hmm.' }, { id: 'answer', type: 'text', content: 'Hi.' }])
    expect(screen.getByRole('button', { name: /^Thought/ })).toBeTruthy()
  })
})
