/**
 * Tests for ``Thinking`` reasoning trace renderer.
 *
 * Focus: ``splitSections`` correctness for the multi-``**Header**`` reasoning
 * format produced by OpenAI's ``/responses`` API.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { Thinking } from '@/components/Thinking'
import { splitSections } from '@/utils/thinking'

afterEach(cleanup)

describe('splitSections', () => {
  it('returns a single empty-header section for plain text', () => {
    const sections = splitSections('Just thinking out loud.')
    expect(sections).toEqual([
      { header: null, body: 'Just thinking out loud.' },
    ])
  })

  it('parses a single bold header followed by a body', () => {
    const text = '**Planning**\n\nFirst I need to enumerate options.'
    expect(splitSections(text)).toEqual([
      { header: 'Planning', body: 'First I need to enumerate options.' },
    ])
  })

  it('parses multiple bold headers with separate bodies', () => {
    const text =
      '**Planning**\n\nFirst body.\n\n**Refining**\n\nSecond body.\n\n**Wrap-up**\n\nThird body.'
    expect(splitSections(text)).toEqual([
      { header: 'Planning', body: 'First body.' },
      { header: 'Refining', body: 'Second body.' },
      { header: 'Wrap-up', body: 'Third body.' },
    ])
  })

  it('handles a leading prose paragraph before the first header', () => {
    const text = 'Some prelude.\n\n**Section**\n\nBody.'
    expect(splitSections(text)).toEqual([
      { header: null, body: 'Some prelude.' },
      { header: 'Section', body: 'Body.' },
    ])
  })

  it('does not split inline bold text inside a section body', () => {
    const text = '**Planning**\n\nConsider **only** these cases.'
    const result = splitSections(text)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      header: 'Planning',
      body: 'Consider **only** these cases.',
    })
  })

  it('handles a header with no body (streaming mid-section)', () => {
    expect(splitSections('**Just-started section**')).toEqual([
      { header: 'Just-started section', body: '' },
    ])
  })

  it('handles empty input', () => {
    expect(splitSections('')).toEqual([])
  })
})

describe('Thinking', () => {
  it('renders each section header as a separate styled run', () => {
    const text = '**One**\n\nfirst.\n\n**Two**\n\nsecond.'
    const { container, getByText } = render(<Thinking content={text} isStreaming />)

    expect(container.querySelectorAll('[data-thinking-section-header]')).toHaveLength(2)
    expect(getByText('first.')).toBeTruthy()
    expect(getByText('second.')).toBeTruthy()
    // No raw asterisks should leak into the rendered text.
    expect(container.textContent).not.toContain('**')
  })

  it('preserves double newlines in thinking content as-is', () => {
    const text = 'Line one.\n\nLine two.\n\n\nLine three.'
    const { container } = render(<Thinking content={text} isStreaming />)

    expect(container.textContent).toContain('Line one.\n\nLine two.\n\n\nLine three.')
  })
})

describe('Thinking — disclosure', () => {
  const TRACE = '**Planning**\n\nRead the config first.\n\n**Checking**\n\nThen run the tests.'

  it('stays open while the trace is streaming, naming the section in progress', () => {
    render(<Thinking content={TRACE} isStreaming />)

    const toggle = screen.getByRole('button', { name: /thinking/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toContain('Checking')
    expect(screen.getByText('Then run the tests.')).toBeTruthy()
  })

  it('collapses a finished trace to one row titled by its first section', () => {
    render(<Thinking content={TRACE} />)

    const toggle = screen.getByRole('button', { name: /thought/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toContain('Planning')
    expect(screen.queryByText('Read the config first.')).toBeNull()
  })

  it('titles a trace without section headers by its first line', () => {
    render(<Thinking content={'The user wants a rename.\nStart with the store.'} />)

    expect(screen.getByRole('button', { name: /thought/i }).textContent).toContain('The user wants a rename.')
  })

  it('opens and closes on click', () => {
    render(<Thinking content={TRACE} />)
    const toggle = screen.getByRole('button', { name: /thought/i })

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Read the config first.')).toBeTruthy()

    fireEvent.click(toggle)
    expect(screen.queryByText('Read the config first.')).toBeNull()
  })

  it('keeps a trace the reader opened open after it finishes streaming', () => {
    const { rerender } = render(<Thinking content={TRACE} isStreaming />)
    const toggle = screen.getByRole('button', { name: /thinking/i })
    fireEvent.click(toggle) // close
    fireEvent.click(toggle) // reopen: now an explicit choice

    rerender(<Thinking content={TRACE} />)
    expect(screen.getByRole('button', { name: /thought/i }).getAttribute('aria-expanded')).toBe('true')
  })

  it('forceOpen shows a collapsed trace, e.g. while find has a match inside it', () => {
    render(<Thinking content={TRACE} forceOpen />)

    expect(screen.getByText('Read the config first.')).toBeTruthy()
  })

  it('renders nothing for a whitespace-only trace', () => {
    const { container } = render(<Thinking content={'  \n '} />)

    expect(container.innerHTML).toBe('')
  })
})
