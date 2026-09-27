import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { TurnChanges } from '@/components/TurnChanges'
import type { FileDiff } from '@/components/ToolCall/diffUtils'

afterEach(cleanup)

const file = (path: string, kind: 'add' | 'update' | 'delete' = 'update', additions = 1, deletions = 0, diffs: FileDiff[] = []) => ({ path, kind, additions, deletions, diffs })
const edit = (path: string, removed: string, added: string): FileDiff => ({
  path,
  kind: 'update',
  lines: [{ type: 'removed', value: removed }, { type: 'added', value: added }],
})

describe('TurnChanges', () => {
  it('titles the card with the file count and line totals', () => {
    render(<TurnChanges changes={{ files: [file('src/a.ts'), file('b.ts')], additions: 12, deletions: 3 }} />)

    const card = screen.getByRole('region', { name: 'Files changed in this turn' })
    expect(card.textContent).toContain('Changed 2 files')
    expect(card.textContent).toContain('+12')
    expect(card.textContent).toContain('-3')
  })

  it("shows a file's diff from this turn when its row is opened", () => {
    render(
      <TurnChanges
        changes={{ files: [file('src/a.ts', 'update', 2, 2, [edit('src/a.ts', 'old one', 'new one'), edit('src/a.ts', 'old two', 'new two')])], additions: 2, deletions: 2 }}
      />,
    )

    const row = screen.getByRole('button', { name: 'Changes to src/a.ts' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('new one')).toBeNull()

    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('old one')).toBeTruthy()
    expect(screen.getByText('new two')).toBeTruthy()

    fireEvent.click(row)
    expect(screen.queryByText('new one')).toBeNull()
  })

  it('opens every diff from the card header', () => {
    render(
      <TurnChanges
        changes={{ files: [file('a.ts', 'update', 1, 1, [edit('a.ts', 'a-', 'a+')]), file('b.ts', 'update', 1, 1, [edit('b.ts', 'b-', 'b+')])], additions: 2, deletions: 2 }}
      />,
    )

    const header = screen.getByRole('button', { name: /Changed 2 files/ })
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('a+')).toBeTruthy()
    expect(screen.getByText('b+')).toBeTruthy()

    fireEvent.click(header)
    expect(screen.queryByText('a+')).toBeNull()
  })

  it('opens a changed file from its own button, but not a deleted one', () => {
    const onOpenFile = mock(() => {})
    render(
      <TurnChanges
        changes={{ files: [file('src/a.ts'), file('src/gone.ts', 'delete')], additions: 1, deletions: 0 }}
        onOpenFile={onOpenFile}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open src/a.ts' }))
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts')
    expect(screen.queryByRole('button', { name: /gone\.ts/ })).toBeNull()
    expect(screen.getByText('deleted')).toBeTruthy()
  })

  it('marks new files', () => {
    render(<TurnChanges changes={{ files: [file('src/new.ts', 'add')], additions: 1, deletions: 0 }} />)

    expect(screen.getByText('new')).toBeTruthy()
  })

  it('lists the first five files and reveals the rest on request', () => {
    const files = Array.from({ length: 7 }, (_, i) => file(`f${i}.ts`))
    render(<TurnChanges changes={{ files, additions: 7, deletions: 0 }} />)

    expect(screen.queryByText('f5.ts')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more files' }))
    expect(screen.getByText('f6.ts')).toBeTruthy()
  })

  it('renders nothing when the turn changed no files', () => {
    const { container } = render(<TurnChanges changes={{ files: [], additions: 0, deletions: 0 }} />)

    expect(container.innerHTML).toBe('')
  })
})
