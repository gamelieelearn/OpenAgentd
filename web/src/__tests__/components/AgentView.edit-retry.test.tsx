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

describe('AgentView — restore to here', () => {
  it('keeps a prompt and its answer by rewinding to the next prompt, composer untouched', () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    const restores = screen.getAllByRole('button', { name: 'Restore to here' })
    // The latest prompt has nothing after it to undo.
    expect(restores).toHaveLength(1)

    fireEvent.click(restores[0])
    expect(revertToMessage).toHaveBeenCalledWith('m2', { restoreDraft: false })
  })

  it('offers no Restore while a turn is open', () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} isTurnOpen />)

    expect(screen.queryByRole('button', { name: 'Restore to here' })).toBeNull()
  })
})

describe('AgentView — retry', () => {
  it('keeps Retry to the error card; a finished answer has none', () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} onRetry={() => {}} />)

    expect(screen.queryByRole('button', { name: 'Retry response' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})
