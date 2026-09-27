import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { TranscriptViewMenu } from '@/components/TranscriptViewMenu'
import { useTranscriptStore } from '@/stores/useTranscriptStore'

afterEach(() => {
  cleanup()
  useTranscriptStore.setState({ readerMode: false, density: 'comfortable', fontSize: 14 })
})

function openMenu() {
  render(<TranscriptViewMenu />)
  fireEvent.click(screen.getByRole('button', { name: 'Transcript view' }))
}

describe('TranscriptViewMenu', () => {
  it('switches reader mode', () => {
    openMenu()

    fireEvent.click(screen.getByRole('switch', { name: 'Reader mode' }))

    expect(useTranscriptStore.getState().readerMode).toBe(true)
    expect(screen.getByRole('switch', { name: 'Reader mode' }).getAttribute('aria-checked')).toBe('true')
  })

  it('marks the trigger while reader mode is on', () => {
    useTranscriptStore.setState({ readerMode: true })
    render(<TranscriptViewMenu />)

    expect(screen.getByRole('button', { name: 'Transcript view' }).hasAttribute('data-active')).toBe(true)
  })

  it('picks a density', () => {
    openMenu()
    expect(screen.getByRole('radio', { name: 'Comfortable' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: 'Compact' }))

    expect(useTranscriptStore.getState().density).toBe('compact')
    expect(screen.getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true')
  })

  it('steps the text size and resets it', () => {
    openMenu()
    expect(screen.queryByRole('button', { name: 'Reset text size' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Larger text' }))

    expect(screen.getByText('15px')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset text size' }))
    expect(useTranscriptStore.getState().fontSize).toBe(14)
  })

  it('cannot step past the smallest size', () => {
    useTranscriptStore.setState({ fontSize: 12 })
    openMenu()

    expect((screen.getByRole('button', { name: 'Smaller text' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
