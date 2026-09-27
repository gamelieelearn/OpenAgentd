import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { DEFAULT_TRANSCRIPT_FONT_SIZE, useTranscriptStore } from '@/stores/useTranscriptStore'
import type { ContentBlock } from '@/api/types'

afterEach(() => {
  cleanup()
  useTranscriptStore.setState({ density: 'comfortable', fontSize: DEFAULT_TRANSCRIPT_FONT_SIZE })
})

const BLOCKS: ContentBlock[] = [
  { id: 'u1', type: 'user', content: 'a prompt' },
  { id: 'a1', type: 'text', content: 'an answer' },
]

describe('AgentView — transcript view settings', () => {
  it('hands the reading size and density to the transcript as CSS variables', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)
    const transcript = container.querySelector<HTMLElement>('.oa-transcript')!
    expect(transcript.style.getPropertyValue('--transcript-font-size')).toBe('0.875rem')

    act(() => useTranscriptStore.setState({ fontSize: 18, density: 'relaxed' }))
    expect(transcript.style.getPropertyValue('--transcript-font-size')).toBe('1.125rem')
    expect(transcript.style.getPropertyValue('--transcript-turn-gap')).toBe('1.25rem')
  })
})
