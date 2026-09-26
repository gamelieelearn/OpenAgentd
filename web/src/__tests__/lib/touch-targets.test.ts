/**
 * DESIGN.md "Mobile Touch Parity Scaling": on coarse pointers, controls grow
 * toward a 44px target while desktop keeps its dense sizes. happy-dom does not
 * evaluate ``pointer: coarse``, so this guards the rules and class strings.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DOCK_ROW_ACTION_CLASS, dockTabCloseClass } from '@/components/CodingWorkspacePanel/dock-tab-styles'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')

describe('coarse-pointer touch targets', () => {
  it('grows the shared list row to 44px on touch', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{\s*:root\s*\{\s*--spacing-list-row:\s*2\.75rem;/)
  })

  it('grows dock row actions and the tab close control on touch', () => {
    expect(DOCK_ROW_ACTION_CLASS).toContain('pointer-coarse:size-9')
    expect(dockTabCloseClass(false)).toContain('pointer-coarse:size-8')
    expect(dockTabCloseClass(true)).toContain('pointer-coarse:size-8')
  })
})
