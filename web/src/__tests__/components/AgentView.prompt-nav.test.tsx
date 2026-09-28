import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { PROMPT_JUMP_MARGIN } from '@/components/AgentView/prompt-nav'
import { useAgentStore } from '@/stores/useAgentStore'
import type { ContentBlock } from '@/api/types'

beforeEach(() => {
  useAgentStore.setState({ sessionId: 'session-1' })
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

/** Lays the transcript out: the scroller at the top, prompts at the given tops. */
function layOut(container: HTMLElement, tops: Record<string, number>) {
  const scroller = container.querySelector<HTMLElement>('.oa-chat-scroll')!
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) })
  scroller.scrollTop = 1000
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

/** Where a jump scrolls to so the prompt now at ``top`` lands on the margin. */
function landing(top: number): number {
  return 1000 + top - PROMPT_JUMP_MARGIN
}

describe('AgentView — prompt navigation', () => {
  it('marks only prompts the user wrote', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    const ids = [...container.querySelectorAll<HTMLElement>('[data-prompt-id]')].map((el) => el.dataset.promptId)
    expect(ids).toEqual(['u1', 'u2', 'u3'])
  })

  it('pins no prompt bar over the transcript, even inside a turn', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    layOut(container, { u1: -900, u2: -300, u3: 500 })

    expect(screen.queryByRole('navigation', { name: 'Prompts' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Previous prompt' })).toBeNull()
  })

  it('jumps to the previous prompt from the keyboard, stepping on during a smooth jump', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)
    const scrollTo = layOut(container, { u1: -900, u2: -300, u3: 500 })

    fireEvent.keyDown(document, { key: 'ArrowUp', ctrlKey: true, altKey: true })
    expect(lastTop(scrollTo)).toBe(landing(-300))

    // A second press while the first jump is still scrolling steps on from it.
    fireEvent.keyDown(document, { key: 'ArrowUp', ctrlKey: true, altKey: true })
    expect(lastTop(scrollTo)).toBe(landing(-900))
  })

  it('jumps down to the next prompt from the keyboard', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)
    const scrollTo = layOut(container, { u1: -900, u2: -300, u3: 500 })

    fireEvent.keyDown(document, { key: 'ArrowDown', ctrlKey: true, altKey: true })
    expect(lastTop(scrollTo)).toBe(landing(500))
  })
})
