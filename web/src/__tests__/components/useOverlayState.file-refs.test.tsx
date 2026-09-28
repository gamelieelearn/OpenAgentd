import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { useOverlayState, type UseOverlayStateArgs } from '@/components/AgentChatView/useOverlayState'
import { queryKeys } from '@/queries'
import { useAgentStore } from '@/stores/useAgentStore'
import type { AgentStream } from '@/stores/useAgentStore/types'
import { useFileRevealStore } from '@/stores/useFileRevealStore'
import { useToastStore } from '@/stores/useToastStore'
import { useUIStore } from '@/stores/useUIStore'
import type { WorkspaceFileInfo } from '@/api/types'

const WORKSPACE = '/repo/project'
const FILES: WorkspaceFileInfo[] = ['src/a.ts', 'web/src/components/Button.tsx', 'web/src/index.ts', 'app/src/index.ts']
  .map((path) => ({ path, name: path.slice(path.lastIndexOf('/') + 1), size: 10, mtime: 1, mime: 'text/plain' }))

function renderOverlay(overrides: Partial<UseOverlayStateArgs> = {}) {
  const client = new QueryClient()
  client.setQueryData(queryKeys.coding.files(WORKSPACE), { workspace: WORKSPACE, truncated: false, files: FILES })
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const args: UseOverlayStateArgs = {
    isMobile: false,
    workspace: WORKSPACE,
    toggleScheduler: () => {},
    toggleAgentCapabilities: () => {},
    togglePalette: () => {},
    toggleQuickOpen: () => {},
    ...overrides,
  }
  return renderHook(() => useOverlayState(args), { wrapper })
}

beforeEach(() => {
  useFileRevealStore.setState({ request: null })
  useToastStore.setState({ toasts: [] })
})
afterEach(() => {
  cleanup()
  useAgentStore.setState({ leadName: null, agentStreams: {} })
  useUIStore.setState({ quickOpenOpen: false, quickOpenQuery: '' })
})

describe('useOverlayState — opening file references', () => {
  it('opens an in-workspace absolute path in the dock, at its line', async () => {
    const { result } = renderOverlay()

    await act(() => result.current.handleFileRefOpen({ path: `${WORKSPACE}/src/a.ts`, line: 12 }))

    expect(result.current.fileViewer?.path).toBe('src/a.ts')
    expect(result.current.workspacePanel).toBe('files')
    expect(useFileRevealStore.getState().request).toMatchObject({ path: 'src/a.ts', line: 12 })
  })

  it('opens a file cited by its name alone, at its line', async () => {
    const { result } = renderOverlay()

    await act(() => result.current.handleFileRefOpen({ path: 'Button.tsx', line: 7 }))

    expect(result.current.fileViewer?.path).toBe('web/src/components/Button.tsx')
    expect(useFileRevealStore.getState().request).toMatchObject({ path: 'web/src/components/Button.tsx', line: 7 })
  })

  it('opens the matching file the session read when several match', async () => {
    const read = { id: 't1', type: 'tool', content: '', toolName: 'read', toolArgs: JSON.stringify({ path: `${WORKSPACE}/app/src/index.ts` }) } as const
    useAgentStore.setState({ leadName: 'lead', agentStreams: { lead: { blocks: [read], currentBlocks: [] } as unknown as AgentStream } })
    const { result } = renderOverlay()

    await act(() => result.current.handleFileRefOpen({ path: 'src/index.ts' }))

    expect(result.current.fileViewer?.path).toBe('app/src/index.ts')
  })

  it('lets the user choose in Quick Open when several files match', async () => {
    const { result } = renderOverlay()

    await act(() => result.current.handleFileRefOpen({ path: 'index.ts', line: 3 }))

    expect(result.current.fileViewer).toBeNull()
    expect(useUIStore.getState()).toMatchObject({ quickOpenOpen: true, quickOpenQuery: 'index.ts:3' })
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('says so when the file is not in the workspace', async () => {
    const { result } = renderOverlay()

    await act(() => result.current.handleFileRefOpen({ path: 'src/missing.ts', line: 3 }))

    expect(result.current.fileViewer).toBeNull()
    expect(useFileRevealStore.getState().request).toBeNull()
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      title: 'File not found',
      description: 'No file in this workspace matches src/missing.ts.',
    })
  })
})

describe('useOverlayState — switching model from an error', () => {
  afterEach(() => useUIStore.setState({ agentCapabilitiesOpen: false, paletteOpen: false }))

  it('opens Session Settings, where the model is picked', () => {
    const { toggleAgentCapabilities } = useUIStore.getState()
    const { result } = renderOverlay({ toggleAgentCapabilities })

    act(() => result.current.handleSwitchModel())

    expect(useUIStore.getState()).toMatchObject({ agentCapabilitiesOpen: true, paletteOpen: false })
  })

  it('leaves Session Settings open when it already is', () => {
    const { toggleAgentCapabilities } = useUIStore.getState()
    useUIStore.setState({ agentCapabilitiesOpen: true })
    const { result } = renderOverlay({ toggleAgentCapabilities })

    act(() => result.current.handleSwitchModel())

    expect(useUIStore.getState().agentCapabilitiesOpen).toBe(true)
  })
})
