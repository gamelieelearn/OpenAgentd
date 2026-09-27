import { beforeEach, describe, expect, it } from 'bun:test'
import { useHeldMessagesStore } from '@/stores/useHeldMessagesStore'

beforeEach(() => {
  useHeldMessagesStore.setState({ messages: [] })
})

const contents = () => useHeldMessagesStore.getState().messages.map((m) => m.content)

describe('useHeldMessagesStore', () => {
  it('hands back the oldest message held for a session, one at a time', () => {
    const { hold, takeNext } = useHeldMessagesStore.getState()
    hold({ sessionId: 's1', content: 'first' })
    hold({ sessionId: 's2', content: 'elsewhere' })
    hold({ sessionId: 's1', content: 'second' })

    expect(takeNext('s1')?.content).toBe('first')
    expect(takeNext('s1')?.content).toBe('second')
    expect(takeNext('s1')).toBeNull()
    expect(contents()).toEqual(['elsewhere'])
  })

  it('takes every message of one session and leaves the others held', () => {
    const { hold, takeAll } = useHeldMessagesStore.getState()
    hold({ sessionId: 's1', content: 'a' })
    hold({ sessionId: 's2', content: 'elsewhere' })
    hold({ sessionId: 's1', content: 'b' })

    expect(takeAll('s1').map((m) => m.content)).toEqual(['a', 'b'])
    expect(contents()).toEqual(['elsewhere'])
  })

  it('takes a single message by id', () => {
    const { hold, take } = useHeldMessagesStore.getState()
    hold({ sessionId: 's1', content: 'keep' })
    hold({ sessionId: 's1', content: 'edit me' })
    const id = useHeldMessagesStore.getState().messages[1].id

    expect(take(id)?.content).toBe('edit me')
    expect(take(id)).toBeNull()
    expect(contents()).toEqual(['keep'])
  })

  it('describes held files for display', () => {
    const photo = new File(['x'], 'photo.png', { type: 'image/png' })
    const notes = new File(['y'], 'notes.md', { type: 'text/markdown' })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'look', files: [photo, notes] })

    const [held] = useHeldMessagesStore.getState().messages
    expect(held.files).toEqual([photo, notes])
    expect(held.attachments).toEqual([
      { original_name: 'photo.png', media_type: 'image/png', category: 'image' },
      { original_name: 'notes.md', media_type: 'text/markdown', category: 'document' },
    ])
  })
})
