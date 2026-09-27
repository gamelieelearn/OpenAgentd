import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { CodingFilePreviewContent } from '@/components/CodingFileViewerPanel'
import { useFileRevealStore } from '@/stores/useFileRevealStore'
import type { WorkspaceFileInfo } from '@/api/types'

const FILE: WorkspaceFileInfo = { path: 'src/main.ts', name: 'main.ts', size: 40, mtime: 1, mime: 'text/plain' }
const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = mock(async () => new Response('one\ntwo\nthree\nfour')) as unknown as typeof fetch
  useFileRevealStore.setState({ request: null })
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('CodingFilePreviewContent — revealing a line', () => {
  it('selects the requested line once the file loads, and consumes the request', async () => {
    useFileRevealStore.getState().reveal('src/main.ts', 3)
    render(<CodingFilePreviewContent workspace="/repo" file={FILE} />)

    expect(await screen.findByRole('button', { name: 'Add comment for line 3' })).toBeTruthy()
    expect(useFileRevealStore.getState().request).toBeNull()
  })

  it('reveals a line in a file that is already open, clamped to its length', async () => {
    render(<CodingFilePreviewContent workspace="/repo" file={FILE} />)
    await screen.findByRole('button', { name: 'Select line 4' })

    act(() => useFileRevealStore.getState().reveal('src/main.ts', 99))
    expect(await screen.findByRole('button', { name: 'Add comment for line 4' })).toBeTruthy()
  })

  it('leaves a request for another file alone', async () => {
    useFileRevealStore.getState().reveal('src/other.ts', 2)
    render(<CodingFilePreviewContent workspace="/repo" file={FILE} />)
    await screen.findByRole('button', { name: 'Select line 4' })

    expect(screen.queryByRole('button', { name: /^Add comment/ })).toBeNull()
    expect(useFileRevealStore.getState().request?.path).toBe('src/other.ts')
  })
})
