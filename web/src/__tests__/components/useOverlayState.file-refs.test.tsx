import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { useOverlayState, type UseOverlayStateArgs } from '@/components/AgentChatView/useOverlayState'
import { queryKeys } from '@/queries'
import { useFileRevealStore } from '@/stores/useFileRevealStore'
import { useToastStore } from '@/stores/useToastStore'
import type { WorkspaceFileInfo } from '@/api/types'

const WORKSPACE = '/repo/project'
const FILE: WorkspaceFileInfo = { path: 'src/a.ts', name: 'a.ts', size: 10, mtime: 1, mime: 'text/plain' }

function renderOverlay() {
  const client = new QueryClient()
  client.setQueryData(queryKeys.coding.files(WORKSPACE), { workspace: WORKSPACE, truncated: false, files: [FILE] })
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const args: UseOverlayStateArgs = {
    isMobile: false,
    workspace: WORKSPACE,
    toggleScheduler: () => {},
    toggleAgentCapabilities: () => {},
    togglePalette: () => {},
    toggleQuickOpen: () => {},
  }
  return renderHook(() => useOverlayState(args), { wrapper })
}

beforeEach(() => {
  useFileRevealStore.setState({ request: null })
  useToastStore.setState({ toasts: [] })
})
afterEach(cleanup)

describe('useOverlayState — opening file references', () => {
  it('opens an in-workspace absolute path in the dock, at its line', async () => {
    const { result } = renderOverlay()

    await act(() => result.current.handleFileRefOpen({ path: `${WORKSPACE}/src/a.ts`, line: 12 }))

    expect(result.current.codingFileViewer?.path).toBe('src/a.ts')
    expect(result.current.codingPanel).toBe('files')
    expect(useFileRevealStore.getState().request).toMatchObject({ path: 'src/a.ts', line: 12 })
  })

  it('says so when the file is not in the workspace', async () => {
    const { result } = renderOverlay()

    await act(() => result.current.handleFileRefOpen({ path: 'src/missing.ts', line: 3 }))

    expect(result.current.codingFileViewer).toBeNull()
    expect(useFileRevealStore.getState().request).toBeNull()
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ title: 'File not found' })
  })
})
