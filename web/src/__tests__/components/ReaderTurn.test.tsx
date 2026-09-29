import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AssistantTurn } from '@/components/AssistantTurnFooter'
import { FileRefContext, type FileRefOpener } from '@/components/FileRefLink'
import { useAgentStore } from '@/stores/useAgentStore'
import type { ContentBlock } from '@/api/types'

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true, writable: true })
})
afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, pendingQuestion: null, resolvedQuestions: {} })
})

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
const workRow = () => screen.getByRole('button', { name: /1 read, 1 edit/ })

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

  it('lists the files the turn edited behind a closed row, and opens one from the list', () => {
    const open = mock((..._args: unknown[]) => {})
    renderTurn(finished, { opener: { canOpen: () => true, open } })

    const files = screen.getByRole('button', { name: /1 file changed/ })
    expect(files.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /src\/a\.ts/ })).toBeNull()

    fireEvent.click(files)

    expect(files.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    expect(open).toHaveBeenCalledWith({ path: 'src/a.ts' })

    fireEvent.click(files)
    expect(screen.queryByRole('button', { name: /src\/a\.ts/ })).toBeNull()
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

describe('AssistantTurn — reader mode, closing a long fold', () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect
  })

  function rectAt(top: number): DOMRect {
    return { top, bottom: top + 24, left: 0, right: 600, width: 600, height: 24, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  }

  /**
   * The fold opened in a transcript scrolled to ``scrollTop``. Closed, the
   * row sits 1000px into the transcript; open, it is pinned to the top of
   * the view, and the fold's end is 400px down it.
   */
  function renderScrolledTurn(scrollTop: number) {
    render(
      <div data-testid="transcript" style={{ overflowY: 'auto' }}>
        <AssistantTurn
          blocks={finished}
          startIndex={0}
          finalizedCount={finished.length}
          isWorking={false}
          isTrailingTurn
          totalBlocks={finished.length}
          reader
          renderBlock={({ block }) => <p data-testid={`block-${block.id}`}>{block.content || block.id}</p>}
        />
      </div>,
    )
    const transcript = screen.getByTestId('transcript')
    Object.defineProperty(transcript, 'scrollTop', { value: scrollTop, configurable: true, writable: true })
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const expanded = this.getAttribute('aria-expanded')
      if (expanded !== null) return rectAt(expanded === 'true' ? 0 : 1000 - transcript.scrollTop)
      if (this.textContent === 'Collapse') return rectAt(400)
      return rectAt(0)
    }
    fireEvent.click(workRow())
    return transcript
  }

  it('pins the open row to the top of the transcript while its steps scroll under it', () => {
    renderTurn(finished)
    const header = workRow().parentElement as HTMLElement
    expect(header.className).not.toContain('sticky')

    fireEvent.click(workRow())

    expect(header.className).toContain('sticky')
    expect(header.className).toContain('top-0')
  })

  it('closes from the end of the steps too, handing focus back to the row', () => {
    renderTurn(finished)
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull()
    fireEvent.click(workRow())

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))

    expect(workRow().getAttribute('aria-expanded')).toBe('false')
    for (const id of ['think', 'read', 'narrate', 'edit']) expect(rendered(id)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull()
    expect(document.activeElement).toBe(workRow())
  })

  it('puts the row where the reader clicked when the fold closes from its end', () => {
    const transcript = renderScrolledTurn(3000)

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))

    // The row lands 400px down the view, where the button was.
    expect(transcript.scrollTop).toBe(600)
  })

  it('leaves the pinned row where it is when it closes the fold', () => {
    const transcript = renderScrolledTurn(3000)

    fireEvent.click(workRow())

    // The row stays at the top of the view instead of scrolling away with the steps.
    expect(transcript.scrollTop).toBe(1000)
  })

  it('does not move a row that closes where it already sits', () => {
    const transcript = renderScrolledTurn(700)
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return rectAt(this.getAttribute('aria-expanded') !== null ? 1000 - transcript.scrollTop : 0)
    }

    fireEvent.click(workRow())

    expect(transcript.scrollTop).toBe(700)
  })
})

describe('AssistantTurn — reader mode, ask_user', () => {
  const PLACEHOLDER = 'Waiting for the user to answer. Do not continue until their reply arrives.'
  const ask = (toolResult: string): ContentBlock => ({
    id: 'ask', type: 'tool', content: '', toolName: 'ask_user', toolCallId: 'call-q', toolArgs: '{"questions":[]}', toolDone: true, toolResult,
  })
  const read = finished[1]
  const shell: ContentBlock = { id: 'run', type: 'tool', content: '', toolName: 'shell', toolArgs: '{"command":"ls"}', toolDone: true, toolResult: 'ok' }
  const answer = finished[4]

  it('folds an answered question with the rest of the work', () => {
    renderTurn([read, ask('User has answered your questions: "Which?"="A". Continue with the user\'s answers in mind.'), shell, answer])

    expect(rendered('ask')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /1 read/ }))
    expect(rendered('ask')).not.toBeNull()
  })

  it('folds a question answered here before the transcript catches up', () => {
    useAgentStore.setState({ sessionId: 's-1', pendingQuestion: null, resolvedQuestions: { 'call-q': { questions: [], answers: [['A']], reason: null } } })

    renderTurn([read, ask(PLACEHOLDER), shell, answer])

    expect(rendered('ask')).toBeNull()
  })

  it('keeps the open question out of the fold', () => {
    useAgentStore.setState({ sessionId: 's-1', pendingQuestion: { id: 'q-1', sessionId: 's-1', toolCallId: 'call-q', questions: [] }, resolvedQuestions: {} })

    renderTurn([read, ask(PLACEHOLDER)])

    expect(rendered('ask')).not.toBeNull()
  })
})
