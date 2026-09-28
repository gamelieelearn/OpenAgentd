import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { promptLine } from '@/components/AgentView/prompt-nav'
import { useAgentStore } from '@/stores/useAgentStore'
import type { ContentBlock } from '@/api/types'

beforeEach(() => {
  useAgentStore.setState({ sessionId: 'session-1', hasMore: false })
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, _pendingMessages: [] })
})

const BLOCKS: ContentBlock[] = [
  { id: 'u1', type: 'user', content: 'first prompt' },
  { id: 'a1', type: 'text', content: 'first answer' },
  { id: 'r1', type: 'user', content: 'a report', extra: { from_agent: 'explorer' } },
  { id: 'u2', type: 'user', content: 'second prompt\nwith a second line' },
  { id: 'a2', type: 'text', content: 'second answer' },
  { id: 'u3', type: 'user', content: 'third prompt' },
  { id: 'a3', type: 'text', content: 'third answer' },
]

/** Lays the transcript out: the scroller at the top, scrolled to ``scrollTop``, prompts at the given tops. */
function layOut(container: HTMLElement, tops: Record<string, number>, scrollTop = 1000) {
  const scroller = container.querySelector<HTMLElement>('.oa-chat-scroll')!
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) })
  scroller.scrollTop = scrollTop
  const scrollTo = mock((..._args: unknown[]) => {})
  scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo
  for (const el of container.querySelectorAll<HTMLElement>('[data-prompt-id]')) {
    const top = tops[el.dataset.promptId!]
    el.getBoundingClientRect = () => ({ top, bottom: top + 40, left: 0, right: 800, width: 800, height: 40, x: 0, y: top, toJSON: () => ({}) })
  }
  act(() => {
    fireEvent.scroll(scroller)
  })
  return scrollTo
}

function lastTop(scrollTo: ReturnType<typeof layOut>): number | undefined {
  return (scrollTo.mock.calls.at(-1)?.[0] as ScrollToOptions | undefined)?.top
}

/** Where a jump scrolls to so the prompt now at ``top`` lands on the line. */
function landing(top: number, scrollTop = 1000): number {
  return scrollTop + top - promptLine()
}

function bar() {
  return screen.queryByRole('navigation', { name: 'Prompts' })
}

describe('AgentView — prompt navigation', () => {
  it('marks only prompts the user wrote', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    const ids = [...container.querySelectorAll<HTMLElement>('[data-prompt-id]')].map((el) => el.dataset.promptId)
    expect(ids).toEqual(['u1', 'u2', 'u3'])
  })

  it('names the prompt whose turn is in view, and stays while the view is inside a turn', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    layOut(container, { u1: -900, u2: -300, u3: 500 })
    expect(bar()?.textContent).toContain('second prompt')
    expect(bar()?.textContent).not.toContain('with a second line')

    // Just jumped to: the prompt sits in full on the line, below the bar.
    layOut(container, { u1: -600, u2: promptLine(), u3: 800 })
    expect(bar()?.textContent).toContain('second prompt')
  })

  it('stays away at the top of the transcript, where nothing has scrolled under it', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    layOut(container, { u1: 24, u2: 400, u3: 900 }, 0)
    expect(bar()).toBeNull()
  })

  it('steps to the prompt before or after the one in the bar', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)
    const scrollTo = layOut(container, { u1: -900, u2: -300, u3: 500 })

    fireEvent.click(screen.getByRole('button', { name: 'Previous prompt' }))
    expect(lastTop(scrollTo)).toBe(landing(-900))

    // A press while the first jump is still scrolling steps on from its target.
    fireEvent.keyDown(document, { key: 'ArrowDown', ctrlKey: true, altKey: true })
    expect(lastTop(scrollTo)).toBe(landing(-300))
  })

  it('steps down from the keyboard too', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)
    const scrollTo = layOut(container, { u1: -900, u2: -300, u3: 500 })

    fireEvent.keyDown(document, { key: 'ArrowDown', ctrlKey: true, altKey: true })
    expect(lastTop(scrollTo)).toBe(landing(500))
  })

  it('scrolls the prompt in the bar back into view from its text', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)
    const scrollTo = layOut(container, { u1: -900, u2: -300, u3: 500 })

    fireEvent.click(screen.getByRole('button', { name: /^Jump to prompt/ }))
    expect(lastTop(scrollTo)).toBe(landing(-300))
  })

  it('disables Previous on the first prompt once nothing earlier is left to load', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    layOut(container, { u1: promptLine(), u2: 600, u3: 1200 })
    expect(screen.getByRole('button', { name: 'Previous prompt' }).hasAttribute('disabled')).toBe(true)

    act(() => useAgentStore.setState({ hasMore: true }))
    expect(screen.getByRole('button', { name: 'Previous prompt' }).hasAttribute('disabled')).toBe(false)
  })
})
