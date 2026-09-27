import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { useAgentStore } from '@/stores/useAgentStore'
import type { ContentBlock } from '@/api/types'

const revertToMessage = mock(async () => null)
const initialRevertToMessage = useAgentStore.getState().revertToMessage

beforeEach(() => {
  revertToMessage.mockClear()
  useAgentStore.setState({ sessionId: 'session-1', revertToMessage })
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, _pendingMessages: [], revertToMessage: initialRevertToMessage })
})

const BLOCKS: ContentBlock[] = [
  { id: 'm1', type: 'user', content: 'first prompt' },
  { id: 'a1', type: 'text', content: 'first answer' },
  { id: 'r1', type: 'user', content: 'report', extra: { from_agent: 'explorer' } },
  { id: 'm2', type: 'user', content: 'second prompt' },
  { id: 'a2', type: 'text', content: 'second answer' },
]

describe('AgentView — edit any prompt', () => {
  it('offers Edit on every prompt the user wrote, and rewinds to the one clicked', () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    const edits = screen.getAllByRole('button', { name: 'Edit message' })
    expect(edits).toHaveLength(2)

    fireEvent.click(edits[0])
    expect(revertToMessage).toHaveBeenCalledWith('m1')
  })

  it('offers no Edit while a turn is open', () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} isTurnOpen />)

    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull()
  })
})

describe('AgentView — retry', () => {
  it('offers Retry on the latest finished answer only', () => {
    const onRetry = mock(() => {})
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} onRetry={onRetry} />)

    const retries = screen.getAllByRole('button', { name: 'Retry response' })
    expect(retries).toHaveLength(1)
    fireEvent.click(retries[0])
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('offers no Retry while the turn is still open', () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} isTurnOpen onRetry={() => {}} />)

    expect(screen.queryByRole('button', { name: 'Retry response' })).toBeNull()
  })

  it('offers no Retry when the latest turn did not answer a prompt the user wrote', () => {
    const blocks: ContentBlock[] = [
      { id: 'r1', type: 'user', content: 'report', extra: { from_agent: 'explorer' } },
      { id: 'a1', type: 'text', content: 'thanks' },
    ]
    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} onRetry={() => {}} />)

    expect(screen.queryByRole('button', { name: 'Retry response' })).toBeNull()
  })
})
