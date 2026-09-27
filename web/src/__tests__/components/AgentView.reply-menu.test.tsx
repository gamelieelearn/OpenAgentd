import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { useAgentStore } from '@/stores/useAgentStore'
import { createDefaultAgentStream } from '@/stores/useAgentStore/defaults'
import { APP_EVENTS, dispatchAppEvent } from '@/lib/app-events'
import type { ContentBlock } from '@/api/types'

const writeText = mock(async (..._args: unknown[]) => {})
const loadOlderMessages = mock(async () => {
  useAgentStore.setState({ hasMore: false })
})
const initialLoadOlder = useAgentStore.getState().loadOlderMessages

const OLDER: ContentBlock[] = [
  { id: 'u0', type: 'user', content: 'Earlier question' },
  { id: 'a0', type: 'text', content: 'Earlier answer' },
]
const BLOCKS: ContentBlock[] = [
  { id: 'u1', type: 'user', content: 'Fix it' },
  { id: 'a1', type: 'text', content: 'Use **bold** and [docs](https://x.dev)' },
]

beforeEach(() => {
  writeText.mockClear()
  loadOlderMessages.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
  const lead = { ...createDefaultAgentStream(), blocks: [...OLDER, ...BLOCKS] }
  useAgentStore.setState({
    sessionId: 'session-1',
    sessionTitle: 'Bug hunt',
    leadName: 'lead',
    agentStreams: { lead },
    hasMore: true,
    loadOlderMessages,
  })
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({
    sessionId: null,
    sessionTitle: null,
    leadName: null,
    agentStreams: {},
    hasMore: false,
    _pendingMessages: [],
    loadOlderMessages: initialLoadOlder,
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

  it('opens the whole session, earlier pages included, as a Markdown document', async () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    openReplyMenu(container)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open session as Markdown' }))

    const preview = await screen.findByRole('dialog', { name: 'File preview: Bug hunt.md' })
    expect(loadOlderMessages).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(preview.textContent).toContain('# Bug hunt'))
    expect(preview.textContent).toContain('Earlier question')
    expect(preview.textContent).toContain('Use **bold** and [docs](https://x.dev)')
  })

  it('opens the same document from the palette command', async () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    act(() => dispatchAppEvent(APP_EVENTS.openSessionMarkdown))

    const preview = await screen.findByRole('dialog', { name: 'File preview: Bug hunt.md' })
    await waitFor(() => expect(preview.textContent).toContain('Earlier answer'))
  })
})
