import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { useAgentStore } from '@/stores/useAgentStore'
import { createDefaultAgentStream } from '@/stores/useAgentStore/defaults'
import type { ContentBlock } from '@/api/types'

const writeText = mock(async (..._args: unknown[]) => {})

const BLOCKS: ContentBlock[] = [
  { id: 'u1', type: 'user', content: 'Fix it' },
  { id: 'a1', type: 'text', content: 'Use **bold** and [docs](https://x.dev)' },
]

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
  const lead = { ...createDefaultAgentStream(), blocks: [...BLOCKS] }
  useAgentStore.setState({
    sessionId: 'session-1',
    sessionTitle: 'Bug hunt',
    leadName: 'lead',
    agentStreams: { lead },
  })
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({
    sessionId: null,
    sessionTitle: null,
    leadName: null,
    agentStreams: {},
  })
})

function openReplyMenu(container: HTMLElement) {
  fireEvent.contextMenu(container.querySelector('[data-find-block="a1"]')!)
  return screen.getByRole('menu', { name: 'Reply actions' })
}

describe('AgentView — reply context menu', () => {
  it('copies a reply as plain text or as Markdown', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    openReplyMenu(container)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))
    expect(writeText).toHaveBeenLastCalledWith('Use bold and docs (https://x.dev)')
    expect(screen.queryByRole('menu')).toBeNull()

    openReplyMenu(container)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as Markdown' }))
    expect(writeText).toHaveBeenLastCalledWith('Use **bold** and [docs](https://x.dev)')
  })

  it('keeps the native menu on a prompt', () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    fireEvent.contextMenu(screen.getByText('Fix it'))
    expect(screen.queryByRole('menu', { name: 'Reply actions' })).toBeNull()
  })
})
