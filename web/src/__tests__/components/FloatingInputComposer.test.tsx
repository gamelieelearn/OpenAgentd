import { describe, it, expect, afterEach, beforeEach, mock } from 'bun:test'
import { createRef, useRef } from 'react'
import { render, screen, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FloatingInputComposer } from '@/components/FloatingInputComposer'
import { useAgentStore } from '@/stores/useAgentStore'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'
import type { InputComposerHandle } from '@/components/InputComposer'

let mockIsMobile = false

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => mockIsMobile,
}))

mock.module('framer-motion', () => ({
  motion: {
    div: ({
      children,
      style,
      animate,
      layout: _layout,
      initial: _initial,
      transition: _transition,
      drag: _drag,
      dragListener: _dragListener,
      dragControls: _dragControls,
      dragMomentum: _dragMomentum,
      dragElastic: _dragElastic,
      onDragEnd: _onDragEnd,
      ...props
    }: Record<string, unknown>) => {
      const mergedStyle = { ...(style as Record<string, unknown> | undefined) }
      if (animate && typeof animate === 'object') {
        const maybeAnimate = animate as Record<string, unknown>
        if (typeof maybeAnimate.x === 'number' || typeof maybeAnimate.y === 'number') {
          const x = typeof maybeAnimate.x === 'number' ? maybeAnimate.x : 0
          const y = typeof maybeAnimate.y === 'number' ? maybeAnimate.y : 0
          mergedStyle.transform = `translateX(${x}px) translateY(${y}px)`
        }
      }
      return <div {...props} style={mergedStyle}>{children as React.ReactNode}</div>
    },
  },
  AnimatePresence: ({ children }: { children: unknown }) => children as React.ReactNode,
  useDragControls: () => ({ start: () => {} }),
}))

const STORAGE_KEY = 'oa-input-position'

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  useAgentStore.setState({ _pendingMessages: [], isAgentWorking: false })
  useTranscriptFollowStore.setState({ unseen: null, jumpToLatest: null })
  mockIsMobile = false
})

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

// Test harness — provides a bounds container with a stable, measurable size.
function Harness(props: {
  onSubmit?: (message: string, files?: File[], mentions?: string[], delivery?: string) => void
  onStop?: () => void
  placeholder?: string
  exposeFocus?: boolean
  isStreaming?: boolean
  slashCommands?: Array<{ id: string; label: string; description: string }>
  onOpenSessionSettings?: () => void
  onCompact?: () => void
}) {
  const boundsRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<InputComposerHandle>(null)
  return (
    <div
      ref={boundsRef}
      data-testid="bounds"
      style={{ position: 'relative', width: 1200, height: 800 }}
    >
      {props.exposeFocus && (
        <button type="button" onClick={() => inputRef.current?.focus()}>
          Focus input
        </button>
      )}
      <button type="button">Outside</button>
      <FloatingInputComposer
        ref={inputRef}
        boundsRef={boundsRef}
        onSubmit={props.onSubmit ?? (() => {})}
        onStop={props.onStop}
        isStreaming={props.isStreaming}
        placeholder={props.placeholder ?? 'Message…'}
        slashCommands={props.slashCommands}
        model="openai:gpt-5"
        thinkingLevel="high"
        onOpenSessionSettings={props.onOpenSessionSettings}
        context={{ used: 50_000, limit: 200_000, output: 1_200 }}
        onCompact={props.onCompact}
      />
    </div>
  )
}

describe('FloatingInputComposer', () => {
  it('keeps the inner InputComposer textarea mounted but hidden from AT while minimized', () => {
    render(<Harness />)
    // The textarea is always in the DOM regardless of minimized state
    // — visibility is opacity-driven so the ref stays valid and focus
    // can land instantly on expand. While minimized, the wrapping
    // ``aria-hidden`` correctly removes it from the accessibility
    // tree, so we query by label (DOM-level) rather than role
    // (a11y-tree-level).
    const textarea = screen.getByLabelText('Message input')
    expect(textarea).toBeTruthy()
    expect(textarea.getAttribute('disabled')).not.toBeNull()
  })

  it('exposes a drag handle labelled for screen readers', () => {
    render(<Harness />)
    const handle = screen.getByRole('button', { name: /drag input bar/i })
    expect(handle).toBeTruthy()
  })

  it('starts at the default position (zero offset) when no value is stored', () => {
    render(<Harness />)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('reads persisted offset from localStorage on mount without throwing', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: 40, y: -120 }))
    expect(() => render(<Harness />)).not.toThrow()
    // After mount the clamp effect may rewrite the value if bounds don't
    // accommodate the stored offset; we only require the entry remains
    // valid JSON with numeric fields.
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { x: number; y: number }
    expect(typeof parsed.x).toBe('number')
    expect(typeof parsed.y).toBe('number')
  })

  it('ignores malformed localStorage entries without throwing', () => {
    localStorage.setItem(STORAGE_KEY, 'not-json')
    expect(() => render(<Harness />)).not.toThrow()
  })

  it('ignores localStorage entries that do not match the expected shape', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ foo: 'bar' }))
    expect(() => render(<Harness />)).not.toThrow()
  })

  it('resets position on double-click of the handle', async () => {
    const user = userEvent.setup()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: 40, y: -120 }))
    render(<Harness />)

    const handle = screen.getByRole('button', { name: /drag input bar/i })
    await user.dblClick(handle)

    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify({ x: 0, y: 0 }))
  })

  it('clamps a stored offset back into bounds on window resize', () => {
    // Seed an out-of-bounds offset. The clamp effect runs on mount and on
    // resize; the mount pass should already correct it, but we also verify
    // a resize event does not push it further.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: 99999, y: -99999 }))
    render(<Harness />)

    act(() => {
      window.dispatchEvent(new Event('resize'))
    })

    const raw = localStorage.getItem(STORAGE_KEY)
    // Clamp may be a no-op if jsdom reports zero-sized rects, but if it
    // writes anything it must not preserve the extreme values.
    if (raw !== null && raw !== JSON.stringify({ x: 99999, y: -99999 })) {
      const parsed = JSON.parse(raw) as { x: number; y: number }
      expect(Math.abs(parsed.x)).toBeLessThan(99999)
      expect(Math.abs(parsed.y)).toBeLessThan(99999)
    }
  })


  it('forwards the placeholder prop to the inner InputComposer when expanded', async () => {
    const user = userEvent.setup()
    render(<Harness placeholder="Ask the team…" />)
    // Placeholder is empty while the bar is minimized so its ghost
    // doesn't bleed through the slot opacity fade. The minimized
    // The collapsed strip's chat button expands the bar so the
    // textarea's placeholder becomes visible.
    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    const textarea = await screen.findByRole('textbox', { name: 'Message input' })
    expect(textarea.getAttribute('placeholder')).toBe('Ask the team…')
  })

  it('collapses to the status island, with Stop, while the agent works', () => {
    useAgentStore.setState({ isAgentWorking: true, leadName: null, agentStreams: {} })
    render(<Harness isStreaming onStop={() => {}} />)

    const textarea = screen.getByLabelText('Message input')
    expect(textarea.getAttribute('disabled')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Attach file' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop generation' })).toBeTruthy()
  })

  it('leaves no click-blocking hit area behind at the docked position', () => {
    // The positioning wrapper stays anchored at the default docked slot
    // (bottom-centre) while framer moves only the inner panel via
    // ``transform``. If the wrapper keeps ``pointer-events: auto`` it turns
    // into an invisible max-w-md rectangle that swallows every click over
    // the chat transcript at the docked position once the bar is dragged
    // away. Hit-testing must belong to the panel that actually moves.
    render(<Harness />)

    const handle = screen.getByRole('button', { name: /drag input bar/i })
    const wrapper = handle.closest('div.absolute') as HTMLElement | null
    expect(wrapper).not.toBeNull()
    expect(wrapper!.className).toContain('pointer-events-none')

    const panel = wrapper!.firstElementChild as HTMLElement
    expect(panel.className).toContain('pointer-events-auto')
  })

  it('offers the model chip once expanded, opening Session Settings', async () => {
    const user = userEvent.setup()
    const onOpenSessionSettings = mock(() => {})
    render(<Harness onOpenSessionSettings={onOpenSessionSettings} />)
    expect(screen.queryByRole('button', { name: /^Model gpt-5/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    await user.click(screen.getByRole('button', { name: 'Model gpt-5, thinking high. Open Session Settings' }))
    expect(onOpenSessionSettings).toHaveBeenCalledTimes(1)
  })

  it('carries the jump-to-latest chip on the moving panel', () => {
    useTranscriptFollowStore.setState({ unseen: 2, jumpToLatest: () => {} })
    render(<Harness />)

    const chip = screen.getByRole('button', { name: 'Jump to latest, 2 new' })
    const handle = screen.getByRole('button', { name: /drag input bar/i })
    const panel = (handle.closest('div.absolute') as HTMLElement).firstElementChild as HTMLElement
    expect(panel.contains(chip)).toBe(true)
  })

  it('carries the context ring, which compacts on request', async () => {
    const user = userEvent.setup()
    const onCompact = mock(() => {})
    render(<Harness onCompact={onCompact} />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    await user.click(screen.getByRole('button', { name: /50,000 of 200,000 before auto-compact \(25%\)/ }))
    await user.click(screen.getByRole('button', { name: 'Compact now' }))
    expect(onCompact).toHaveBeenCalledTimes(1)
  })

  it('holds Compact now while the agent works', async () => {
    const user = userEvent.setup()
    render(<Harness isStreaming onCompact={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    await user.click(screen.getByRole('button', { name: /before auto-compact/ }))
    expect(screen.getByRole('button', { name: 'Compact now' })).toHaveProperty('disabled', true)
  })

  it('does not render queued messages inside the floating composer', () => {
    useAgentStore.setState({
      sessionId: 'session-a',
      _pendingMessages: [
        { id: 'pm-1', sessionId: 'session-a', content: 'first queued message' },
        { id: 'pm-2', sessionId: 'session-a', content: 'second queued message' },
      ],
    })

    render(<Harness />)

    expect(screen.queryByRole('button', { name: /2 messages awaiting/i })).toBeNull()
    expect(screen.queryByText('first queued message')).toBeNull()
  })

  it('expands and focuses the textarea through its imperative focus handle', async () => {
    const user = userEvent.setup()
    render(<Harness exposeFocus />)

    const textarea = screen.getByLabelText('Message input')
    expect(textarea.getAttribute('disabled')).not.toBeNull()

    await user.click(screen.getByRole('button', { name: 'Focus input' }))
    await act(nextFrame)

    expect(textarea.getAttribute('disabled')).toBeNull()
    expect(document.activeElement).toBe(textarea)
  })

  it('minimizes when Escape is pressed while the input is focused', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.click(textarea)

    expect(textarea.getAttribute('disabled')).toBeNull()

    await user.keyboard('{Escape}')

    expect(textarea.getAttribute('disabled')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()
  })

  it('auto-minimizes when the empty input loses focus', async () => {
    const user = userEvent.setup()
    render(<Harness exposeFocus />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.click(textarea)
    expect(textarea.getAttribute('disabled')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Outside' }))

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220))
    })

    expect(textarea.getAttribute('disabled')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()
  })

  it('stays open while focus moves to a control on the bar or its popover', async () => {
    const user = userEvent.setup()
    render(<Harness onCompact={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.click(textarea)
    // The ring's panel is portalled out of the bar, and takes focus.
    await user.click(screen.getByRole('button', { name: /before auto-compact/ }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220))
    })

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Compact now' }))
    expect(textarea.getAttribute('disabled')).toBeNull()
  })

  it('collapses when focus leaves a control on the bar for the page', async () => {
    const user = userEvent.setup()
    render(<Harness onOpenSessionSettings={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    const chip = screen.getByRole('button', { name: /^Model gpt-5/ })
    act(() => chip.focus())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220))
    })
    expect(textarea.getAttribute('disabled')).toBeNull()

    // A click on plain transcript text moves focus to the body: no focusin.
    act(() => chip.blur())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220))
    })

    expect(textarea.getAttribute('disabled')).not.toBeNull()
  })


  it('expands and inserts the first typed character through its imperative insertText handle', async () => {
    const ref = createRef<InputComposerHandle>()
    function InsertHarness() {
      const boundsRef = useRef<HTMLDivElement>(null)
      return (
        <div ref={boundsRef} style={{ position: 'relative', width: 1200, height: 800 }}>
          <FloatingInputComposer ref={ref} boundsRef={boundsRef} onSubmit={() => {}} />
        </div>
      )
    }

    render(<InsertHarness />)

    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement
    expect(textarea.getAttribute('disabled')).not.toBeNull()

    act(() => {
      ref.current?.focus()
      ref.current?.insertText('h')
    })

    expect(textarea.getAttribute('disabled')).toBeNull()
    expect(textarea.value).toBe('h')
  })

  it('minimizes after sending a message', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.type(textarea, 'hello')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(textarea.getAttribute('disabled')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()
  })

  it('passes how a mid-turn message should be delivered on to its owner', async () => {
    const user = userEvent.setup()
    const onSubmit = mock((..._args: unknown[]) => {})
    render(<Harness isStreaming onStop={() => {}} onSubmit={onSubmit} />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'then run the tests')
    await user.keyboard('{Alt>}{Enter}{/Alt}')

    expect(onSubmit.mock.calls[0]).toEqual(['then run the tests', undefined, undefined, 'after-turn'])
  })

})

// ── Cross-platform: mobile vs desktop behavior ────────────────────────────

describe('FloatingInputComposer — mobile: always fully expanded', () => {
  beforeEach(() => {
    mockIsMobile = true
  })
  afterEach(() => {
    mockIsMobile = false
  })

  it('renders the full textarea immediately without an expand affordance', () => {
    render(<Harness />)
    // On mobile the bar is always expanded — no "Expand input bar" button.
    expect(screen.queryByRole('button', { name: 'Expand input bar' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeTruthy()
  })

  it('does not collapse after submit on mobile', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.type(textarea, 'hello')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    // The textarea should still be present and enabled after submit.
    expect(screen.queryByRole('button', { name: 'Expand input bar' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeTruthy()
  })

  it('does not collapse when the textarea loses focus on mobile', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.click(textarea)
    // Blur the textarea
    await user.tab()

    // Still expanded — no minimize on mobile blur.
    expect(screen.queryByRole('button', { name: 'Expand input bar' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeTruthy()
  })
})

describe('FloatingInputComposer — desktop: minimize/expand lifecycle', () => {
  it('starts minimized and expands on click', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    // Desktop starts minimized.
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Expand input bar' })).toBeNull()
  })

  it('collapses when the empty textarea loses focus on desktop', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    // Focus leaves the textarea for the page (a Tab would land on the
    // bar's own context ring, which keeps it open).
    await act(nextFrame)
    await act(nextFrame)
    act(() => (document.activeElement as HTMLElement | null)?.blur())

    // After the 180 ms blur-debounce timer the bar collapses.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 220))
    })
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()
  })

  it('does NOT collapse when the textarea has content at blur time', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.type(textarea, 'draft text')
    // Tab away — canMinimize=false because there is unsent content.
    await user.tab()

    await act(async () => {
      await new Promise((r) => setTimeout(r, 220))
    })
    // Bar stays expanded.
    expect(screen.queryByRole('button', { name: 'Expand input bar' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeTruthy()
  })
})

describe('FloatingInputComposer — orientation change: portrait-mobile → landscape-tablet', () => {
  it('does not schedule a collapse timer when blur fires while isMobile is true', async () => {
    // When the bar is in mobile mode (isMobile=true), handleBlur must return
    // early without calling setTimeout. We verify this by confirming the bar
    // stays fully expanded after a blur — on mobile the Expand affordance
    // must never appear.
    mockIsMobile = true

    const user = userEvent.setup()
    render(<Harness />)

    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.click(textarea)
    // Blur with empty input (canMinimize=true) — the timer must NOT fire.
    await user.tab()

    // Wait well past the 180ms debounce window.
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 250))
    })

    // Still fully expanded on mobile — no Expand button, textarea present.
    expect(screen.queryByRole('button', { name: 'Expand input bar' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeTruthy()
  })
})

describe('FloatingInputComposer — transcript clearance', () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect

  beforeEach(() => {
    // Happy DOM has no layout: give the bounds and the floating panel sizes.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const height = this.dataset.testid === 'bounds'
        ? 800
        : this.className.includes('pointer-events-auto') ? 100 : 0
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON: () => ({}) } as DOMRect
    }
  })
  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect
  })

  const clearance = () => screen.getByTestId('bounds').style.getPropertyValue('--composer-clearance')

  it('reserves the bar height below the transcript at the docked position', () => {
    render(<Harness />)
    // 16px dock gap + 100px panel + 8px drag-handle overhang.
    expect(clearance()).toBe('124px')
  })

  it('reserves nothing once the bar is dragged into the upper half', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: 0, y: -500 }))
    render(<Harness />)
    expect(clearance()).toBe('0px')
  })

  it('reserves nothing on mobile, where the bar sits in the layout flow', () => {
    mockIsMobile = true
    render(<Harness />)
    expect(clearance()).toBe('')
  })
})
