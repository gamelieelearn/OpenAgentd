/**
 * AgentView — the "New" line: where content you have not had on screen
 * starts when you come back to a session, and the jump to it.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { useAgentStore } from '@/stores/useAgentStore'
import { useUnreadStore } from '@/stores/useUnreadStore'
import type { ContentBlock } from '@/api/types'

const text = (id: string): ContentBlock => ({ id, type: 'text', content: id })
const prompt = (id: string): ContentBlock => ({ id, type: 'user', content: id })

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  setVisibility('visible')
  useUnreadStore.setState({ ids: [], lastSeen: {} })
  act(() => useAgentStore.setState({ sessionId: 's1', _syncedThrough: '2026-01-01T00:00:00Z' }))
})

afterEach(() => {
  cleanup()
  act(() => useAgentStore.setState({ sessionId: null, _syncedThrough: null }))
})

function renderView(blocks: ContentBlock[]) {
  const view = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)
  return {
    ...view,
    update: (next: ContentBlock[]) => view.rerender(<AgentView blocks={next} currentBlocks={[]} isWorking={false} />),
  }
}

describe('AgentView — New line', () => {
  it('marks where unseen content starts when a session is reopened', () => {
    useUnreadStore.setState({ lastSeen: { s1: 'a' } })

    const { container } = renderView([prompt('p1'), text('a'), prompt('p2'), text('b')])

    const divider = screen.getByRole('separator', { name: 'New since your last visit' })
    expect(container.querySelector('[data-prompt-id="p2"]')?.contains(divider)).toBe(true)
    expect(useUnreadStore.getState().lastSeen.s1).toBe('b')
  })

  it('draws no line on a first visit, or for content that arrives while you watch', () => {
    const { update } = renderView([prompt('p1'), text('a')])
    expect(screen.queryByRole('separator', { name: 'New since your last visit' })).toBeNull()

    update([prompt('p1'), text('a'), prompt('p2'), text('b')])

    expect(screen.queryByRole('separator', { name: 'New since your last visit' })).toBeNull()
    expect(useUnreadStore.getState().lastSeen.s1).toBe('b')
  })

  it('does not count content as seen while the window is hidden', () => {
    setVisibility('hidden')
    useUnreadStore.setState({ lastSeen: { s1: 'a' } })

    renderView([prompt('p1'), text('a'), prompt('p2'), text('b')])
    expect(useUnreadStore.getState().lastSeen.s1).toBe('a')

    act(() => setVisibility('visible'))
    expect(useUnreadStore.getState().lastSeen.s1).toBe('b')
  })

  it('offers a jump to the line while it is above the view', () => {
    useUnreadStore.setState({ lastSeen: { s1: 'a' } })
    const { container } = renderView([prompt('p1'), text('a'), prompt('p2'), text('b')])
    const scroller = container.querySelector('.oa-chat-scroll') as HTMLDivElement
    const divider = screen.getByRole('separator', { name: 'New since your last visit' })
    divider.getBoundingClientRect = () => ({ top: -300, bottom: -280, height: 20 }) as DOMRect
    const scrollTo = mock((..._args: unknown[]) => {})
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo

    act(() => { fireEvent.scroll(scroller) })
    fireEvent.click(screen.getByRole('button', { name: 'Jump to new messages' }))

    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect((scrollTo.mock.calls[0][0] as ScrollToOptions).top).toBeLessThan(0)
    expect(screen.queryByRole('button', { name: 'Jump to new messages' })).toBeNull()
  })
})
