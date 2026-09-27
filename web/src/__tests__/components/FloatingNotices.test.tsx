import '@testing-library/jest-dom'

import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, within } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
mock.module('@/api/client', () => ({ installTypeScriptLsp: async () => ({}) }))
// The real card needs the Tauri updater bridge; only its placement matters here.
mock.module('@/components/UpdateCard', () => ({
  UpdateCard: () => <aside data-testid="update-card">Update available</aside>,
}))

import { FloatingNotices } from '@/components/FloatingNotices'
import { useLspInstallStore } from '@/stores/useLspInstallStore'
import { useToastStore } from '@/stores/useToastStore'

beforeEach(() => {
  useToastStore.setState({ toasts: [{ id: 't-1', tone: 'info', title: 'Saved', durationMs: 60_000 }] })
  useLspInstallStore.setState({ request: { workspace: '/project', languageServerVersion: '1.2.3', typeScriptVersion: '5.8.2' } })
})

afterEach(() => {
  cleanup()
  useToastStore.setState({ toasts: [] })
  useLspInstallStore.setState({ request: null })
})

it('stacks toasts, the TypeScript tools prompt and the update card in one column', () => {
  const { container } = render(<FloatingNotices />)

  const column = container.querySelector('[data-floating-notices]') as HTMLElement
  expect(column).not.toBeNull()
  expect(within(column).getByText('Saved')).toBeInTheDocument()
  expect(within(column).getByRole('dialog', { name: 'Install TypeScript language tools' })).toBeInTheDocument()
  expect(within(column).getByTestId('update-card')).toBeInTheDocument()
})

it('positions the column once, so the cards cannot overlap each other', () => {
  const { container } = render(<FloatingNotices />)

  const column = container.querySelector('[data-floating-notices]') as HTMLElement
  expect(column).toHaveClass('fixed')
  const lspCard = screen.getByRole('dialog').closest('aside') as HTMLElement
  expect(lspCard).not.toHaveClass('fixed')
})
