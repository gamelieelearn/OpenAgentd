import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { InlineTitleInput } from '@/components/ui/inline-title-input'

afterEach(cleanup)

function setup(initial = 'Old title') {
  const onSubmit = mock((..._args: unknown[]) => {})
  const onCancel = mock(() => {})
  render(<InlineTitleInput initial={initial} label="Session title" onSubmit={onSubmit} onCancel={onCancel} />)
  return { onSubmit, onCancel, input: screen.getByLabelText('Session title') as HTMLInputElement }
}

describe('InlineTitleInput', () => {
  it('starts focused with the current title selected', () => {
    const { input } = setup()

    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('Old title'.length)
  })

  it('saves the trimmed title on Enter', async () => {
    const user = userEvent.setup()
    const { input, onSubmit, onCancel } = setup()

    await user.clear(input)
    await user.type(input, '  New title  {Enter}')

    expect(onSubmit.mock.calls).toEqual([['New title']])
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('saves when focus leaves the field', async () => {
    const user = userEvent.setup()
    const { input, onSubmit } = setup()

    await user.type(input, '!')
    fireEvent.blur(input)

    expect(onSubmit.mock.calls).toEqual([['Old title!']])
  })

  it('cancels on Escape, or when the title is empty or unchanged', async () => {
    const user = userEvent.setup()
    const escape = setup()
    await user.type(escape.input, 'x{Escape}')
    fireEvent.blur(escape.input)
    expect(escape.onSubmit).not.toHaveBeenCalled()
    expect(escape.onCancel).toHaveBeenCalledTimes(1)
    cleanup()

    const empty = setup()
    await user.clear(empty.input)
    await user.type(empty.input, '   {Enter}')
    expect(empty.onSubmit).not.toHaveBeenCalled()
    expect(empty.onCancel).toHaveBeenCalledTimes(1)
    cleanup()

    const unchanged = setup()
    await user.type(unchanged.input, '{Enter}')
    expect(unchanged.onSubmit).not.toHaveBeenCalled()
    expect(unchanged.onCancel).toHaveBeenCalledTimes(1)
  })
})
