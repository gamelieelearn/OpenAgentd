import '@testing-library/jest-dom'

import { afterEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'

import type { PluginsResponse } from '@/api/client'
import { PluginsSettingsPage, pluginNoticeText } from '@/components/settings/pages/settings.plugins'
import { queryKeys } from '@/queries'

const DATA: PluginsResponse = {
  dirs: ['/home/u/.config/openagentd/plugins'],
  plugins: [
    { name: 'agy_auth', file: 'agy_auth.ts', path: '/p/agy_auth.ts', status: 'loaded', provider: 'agy', hooks: [], errors: [] },
    { name: 'scrub', file: 'scrub.ts', path: '/p/scrub.ts', status: 'loaded', provider: null, hooks: ['tool.after'], errors: [] },
    { name: 'bad', file: 'bad.ts', path: '/p/bad.ts', status: 'error', provider: null, hooks: [], errors: ['bad.ts:1:5: Unexpected token'] },
  ],
  unported: [{ name: 'legacy', file: 'legacy.py', path: '/p/legacy.py' }],
}

function renderPage(data: PluginsResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })
  client.setQueryData(queryKeys.plugins(), data)
  return render(
    <QueryClientProvider client={client}>
      <PluginsSettingsPage />
    </QueryClientProvider>,
  )
}

afterEach(cleanup)

describe('PluginsSettingsPage', () => {
  it('lists plugins with their provider, hooks and load errors', () => {
    renderPage(DATA)
    const list = screen.getByRole('region', { name: 'Installed plugins' })
    expect(within(list).getByText('Installed (3) · 1 failed')).toBeInTheDocument()
    expect(within(list).getByText('provider: agy')).toBeInTheDocument()
    expect(within(list).getByText('tool.after')).toBeInTheDocument()
    expect(within(list).getByText('bad.ts:1:5: Unexpected token')).toBeInTheDocument()
    expect(within(list).getByLabelText('Failed to load')).toBeInTheDocument()
    expect(within(list).getAllByLabelText('Loaded')).toHaveLength(2)
    expect(screen.getByText('/home/u/.config/openagentd/plugins')).toBeInTheDocument()
  })

  it('warns about Python plugins the backend does not run', () => {
    renderPage(DATA)
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('1 Python plugin is not running')).toBeInTheDocument()
    expect(within(alert).getByText('legacy.py')).toBeInTheDocument()
  })

  it('shows no warning and an empty state when nothing is installed', () => {
    renderPage({ dirs: ['/p'], plugins: [], unported: [] })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('No plugins installed.')).toBeInTheDocument()
  })
})

describe('pluginNoticeText', () => {
  it('summarises unported and failed plugins, keyed by the affected files', () => {
    const n = pluginNoticeText(DATA)!
    expect(n.description).toBe('1 Python plugin needs a TypeScript port; 1 failed to load. See Settings → Plugins.')
    expect(n.key).toContain('legacy.py')
    expect(n.key).toContain('bad.ts')
  })

  it('is silent when every plugin runs', () => {
    expect(pluginNoticeText({ ...DATA, plugins: DATA.plugins.slice(0, 2), unported: [] })).toBeNull()
  })
})
