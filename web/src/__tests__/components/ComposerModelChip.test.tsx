import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { ComposerModelChip } from '@/components/ComposerModelChip'

afterEach(cleanup)

describe('ComposerModelChip', () => {
  it('names the model and its thinking level', () => {
    render(<ComposerModelChip model="openai:gpt-5" thinkingLevel="high" onOpen={() => {}} />)

    const chip = screen.getByRole('button', { name: 'Model gpt-5, thinking high. Open Session Settings' })
    expect(chip.textContent).toBe('gpt-5high')
  })

  it('leaves out thinking that is off, and marks fast mode', () => {
    render(<ComposerModelChip model="gpt-5" thinkingLevel="off" fastMode onOpen={() => {}} />)

    const chip = screen.getByRole('button', { name: 'Model gpt-5, fast mode. Open Session Settings' })
    expect(chip.textContent).toBe('gpt-5fast')
  })

  it('opens Session Settings', () => {
    const onOpen = mock(() => {})
    render(<ComposerModelChip model="gpt-5" onOpen={onOpen} />)

    fireEvent.click(screen.getByRole('button', { name: /^Model gpt-5/ }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('says so when the agent default is in use', () => {
    render(<ComposerModelChip model={null} onOpen={() => {}} />)

    expect(screen.getByRole('button', { name: 'Default model. Open Session Settings' }).textContent).toBe('Default model')
  })
})
