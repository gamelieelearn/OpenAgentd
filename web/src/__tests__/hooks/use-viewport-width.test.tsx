import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'

import { useViewportAtLeast, useViewportWidth } from '@/hooks/use-viewport-width'

const ORIGINAL_WIDTH = window.innerWidth

function resizeTo(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
}

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: ORIGINAL_WIDTH })
})

function Width() {
  return <output>{useViewportWidth()}</output>
}

let wideRenders = 0
function Wide() {
  wideRenders += 1
  return <output>{useViewportAtLeast(1280) ? 'wide' : 'narrow'}</output>
}

describe('useViewportWidth', () => {
  it('follows window resizes instead of the width at first render', () => {
    resizeTo(1400)
    render(<Width />)
    expect(screen.getByRole('status').textContent).toBe('1400')
    resizeTo(900)
    expect(screen.getByRole('status').textContent).toBe('900')
  })
})

describe('useViewportAtLeast', () => {
  it('re-renders only when the window crosses the threshold', () => {
    resizeTo(1400)
    wideRenders = 0
    render(<Wide />)
    expect(screen.getByRole('status').textContent).toBe('wide')
    const afterMount = wideRenders

    resizeTo(1350)
    resizeTo(1300)
    expect(wideRenders).toBe(afterMount)

    resizeTo(1200)
    expect(screen.getByRole('status').textContent).toBe('narrow')
    expect(wideRenders).toBe(afterMount + 1)
  })
})
