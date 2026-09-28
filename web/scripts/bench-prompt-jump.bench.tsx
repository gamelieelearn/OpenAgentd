/**
 * Benchmark: ⌥⌘↑ (previous prompt) when that prompt is not rendered, or not
 * loaded yet.
 *
 * Drives public behaviour only: real key presses on the real AgentView, the
 * real agent store, and `fetch` answering `/agent/{id}/history?before=` with
 * 100-row pages after a fixed latency. So the same file runs on any revision:
 *
 *   cd web && bun test ./scripts/bench-prompt-jump.bench.tsx
 *
 *   # compare with an older revision
 *   git worktree add --detach /tmp/before <ref>
 *   ln -s "$PWD/node_modules" /tmp/before/web/node_modules
 *   cp scripts/bench-prompt-jump.bench.tsx /tmp/before/web/scripts/
 *   (cd /tmp/before/web && BENCH_JSON=/tmp/before.json bun test ./scripts/bench-prompt-jump.bench.tsx)
 *   BENCH_BASELINE=/tmp/before.json bun test ./scripts/bench-prompt-jump.bench.tsx
 *
 * happy-dom has no layout, so a fake one stacks the transcript in DOM order
 * with fixed heights (a prompt, a reply row, the "Show earlier" row), and a
 * fake scroller clamps `scrollTop` and fires `scroll` like a browser. Smooth
 * scrolls land at once. The simulated reader presses again only after
 * everything has settled, which flatters code that needs more presses. Times
 * are happy-dom's: compare them between revisions, not with frame budgets.
 *
 * Env: BENCH_LATENCY_MS (default 60) per history request; BENCH_RUNS (default
 * 5) runs per scenario, reporting median times; BENCH_JSON writes the
 * results; BENCH_BASELINE prints them against a previous run's JSON.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'

import { AgentView } from '@/components/AgentView'
import { PROMPT_JUMP_MARGIN } from '@/components/AgentView/prompt-nav'
import { useAgentStore } from '@/stores/useAgentStore'
import { createDefaultAgentStream } from '@/stores/useAgentStore/defaults'
import { applyOrphanToolResults, parseAgentBlocks } from '@/utils/messages'
import type { OrphanToolResult } from '@/utils/messages'
import type { ContentBlock, MessageResponse } from '@/api/types'

const LATENCY_MS = Number(process.env.BENCH_LATENCY_MS ?? 60)
const RUNS = Number(process.env.BENCH_RUNS ?? 5)
/** `HISTORY_PAGE_SIZE` in appv3/crates/db/src/queries/messages.rs. */
const PAGE_ROWS = 100
const SESSION = 'bench-session'
const MAX_PRESSES = 60

// ── Session rows ─────────────────────────────────────────────────────────────

let seq = 0

function row(role: string, fields: Partial<MessageResponse> = {}): MessageResponse {
  seq += 1
  return {
    id: `m${String(seq).padStart(6, '0')}`,
    session_id: SESSION,
    role,
    content: null,
    reasoning_content: null,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    seq,
    kind: 'chat',
    is_summary: false,
    is_hidden: false,
    extra: null,
    created_at: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(),
    attachments: null,
    ...fields,
  }
}

/** An assistant tool call and its result: two rows, one tool card. */
function toolPair(n: number, name: string): MessageResponse[] {
  const id = `call-${seq + 1}`
  return [
    row('assistant', {
      reasoning_content: `Checking part ${n} before changing it.`,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify({ path: `src/module${n}.ts` }) } }],
    }),
    row('tool', { tool_call_id: id, name, content: `export const value${n} = ${n}\n`.repeat(8), extra: { duration_ms: 40 } }),
  ]
}

const answer = (n: number) =>
  `Done with step ${n}.\n\n- Updated \`src/module${n}.ts\` to read the new option\n- Added a test for the empty case\n- Ran the suite: **all green**\n\nThe migration note is left as a TODO.`

/** A prompt and a coding reply: 8 rows (three tool calls, then prose). */
function exchange(n: number, { report = false } = {}): MessageResponse[] {
  return [
    row('user', { content: `Prompt ${n}: please update module ${n} and add a test.` }),
    // A sub-agent report is a user row the transcript shows as its own turn.
    ...(report ? [row('user', { content: `Explorer: module ${n} has two callers.`, extra: { from_agent: 'explorer' } })] : []),
    ...toolPair(n, 'read_file'),
    ...toolPair(n, 'grep'),
    ...toolPair(n, 'bash'),
    row('assistant', { content: answer(n) }),
  ]
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

// ── Backend: history pages behind `fetch` ────────────────────────────────────

let sessionRows: MessageResponse[] = []
const net = { requests: 0, inflight: 0 }
const activity = { count: 0, at: 0 }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function touch() {
  activity.count += 1
  activity.at = performance.now()
}

const originalFetch = globalThis.fetch

async function fakeFetch(input: RequestInfo | URL) {
  const url = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : String(input), 'http://localhost')
  const before = url.searchParams.get('before')
  if (!/\/agent\/[^/]+\/history$/.test(url.pathname) || before === null) {
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  }
  net.requests += 1
  net.inflight += 1
  await sleep(LATENCY_MS)
  net.inflight -= 1
  touch()
  const end = Number(before)
  const start = Math.max(0, end - PAGE_ROWS)
  const body = {
    lead: { id: SESSION, messages: sessionRows.slice(start, end) },
    members: [],
    has_more: start > 0,
    next_cursor: start > 0 ? String(start) : null,
  }
  return { ok: true, status: 200, json: async () => body }
}

/** The store as a session opened on ``rows[loadedFrom..]`` leaves it. */
function seed(rows: MessageResponse[], loadedFrom: number) {
  sessionRows = rows
  const orphans: Record<string, OrphanToolResult> = {}
  const blocks = applyOrphanToolResults(parseAgentBlocks(rows.slice(loadedFrom), orphans), orphans)
  useAgentStore.setState({
    sessionId: SESSION,
    leadName: 'lead',
    agentStreams: { lead: { ...createDefaultAgentStream(), blocks, _orphanToolResults: orphans } },
    hasMore: loadedFrom > 0,
    nextCursor: loadedFrom > 0 ? String(loadedFrom) : null,
    _loadingOlder: false,
    _leadRevertTime: null,
  })
}

// ── Fake layout ──────────────────────────────────────────────────────────────

const VIEW_H = 900
const PAD = 24
const GAP = 12
const PROMPT_H = 88
const ROW_H = 180
const ROW_GAP = 8
const BUTTON_H = 48

interface Stage {
  scroller: HTMLElement
  list: HTMLElement
  top: number
  jumps: number
}

let stage: Stage | null = null
const nativeRect = Element.prototype.getBoundingClientRect

function box(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect
}

/** A transcript row's height: a reply is its rows, the rest are fixed. */
function heightOf(child: Element): number {
  if (child.hasAttribute('data-chat-scroll-anchor')) return 0
  const turn = child.firstElementChild
  if (turn?.classList.contains('space-y-2')) return turn.childElementCount * (ROW_H + ROW_GAP) - ROW_GAP
  if (child.classList.contains('justify-center')) return BUTTON_H
  return PROMPT_H
}

/** ``target``'s top in the content; the content height when it is not a row. */
function childTop(list: Element, target: Element | null): number {
  let y = PAD
  for (const child of Array.from(list.children)) {
    if (child === target) return y
    y += heightOf(child) + GAP
  }
  return y - GAP + PAD
}

function layoutRect(el: Element): DOMRect {
  const s = stage
  if (!s) return nativeRect.call(el)
  if (el === s.scroller) return box(0, VIEW_H)
  if (el === s.list || !s.list.contains(el)) return nativeRect.call(el)
  let node = el
  let replyRow: Element | null = null
  while (node.parentElement && node.parentElement !== s.list) {
    const parent = node.parentElement
    if (parent.classList.contains('space-y-2') && parent.parentElement?.parentElement === s.list) replyRow = node
    node = parent
  }
  const top = childTop(s.list, node) - s.top
  if (!replyRow) return box(top, heightOf(node))
  const index = Array.prototype.indexOf.call(replyRow.parentElement!.children, replyRow)
  return box(top + index * (ROW_H + ROW_GAP), ROW_H)
}

function fakeRect(this: Element): DOMRect {
  return layoutRect(this)
}

function install(container: HTMLElement): Stage {
  const scroller = container.querySelector<HTMLElement>('.oa-chat-scroll')!
  const list = scroller.querySelector<HTMLElement>('.space-y-3')!
  const s: Stage = { scroller, list, top: 0, jumps: 0 }
  let scrollQueued = false
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => s.top,
    set: (value: number) => {
      const next = Math.min(Math.max(0, value), Math.max(0, childTop(list, null) - VIEW_H))
      if (next === s.top) return
      s.top = next
      touch()
      if (scrollQueued) return
      scrollQueued = true
      setTimeout(() => {
        scrollQueued = false
        scroller.dispatchEvent(new Event('scroll'))
      }, 0)
    },
  })
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => childTop(list, null) })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => VIEW_H })
  scroller.scrollTo = ((options: ScrollToOptions) => {
    s.jumps += 1
    scroller.scrollTop = options.top ?? s.top
  }) as typeof scroller.scrollTo
  stage = s
  Element.prototype.getBoundingClientRect = fakeRect
  return s
}

function promptTop(s: Stage, id: string): number | null {
  const el = s.list.querySelector(`[data-prompt-id="${id}"]`)
  return el ? el.getBoundingClientRect().top : null
}

const onMargin = (top: number | null) => top !== null && Math.abs(top - PROMPT_JUMP_MARGIN) <= 2

function promptOnMargin(s: Stage): boolean {
  return Array.from(s.list.querySelectorAll('[data-prompt-id]')).some((el) => onMargin(el.getBoundingClientRect().top))
}

// ── Reader ───────────────────────────────────────────────────────────────────

const EMPTY: ContentBlock[] = []

function Transcript() {
  const blocks = useAgentStore((s) => (s.leadName ? s.agentStreams[s.leadName]?.blocks : undefined) ?? EMPTY)
  return <AgentView blocks={blocks} currentBlocks={EMPTY} isWorking={false} />
}

/** Wait until nothing renders, scrolls, or loads for three frames. */
async function settle() {
  let quiet = 0
  while (quiet < 3) {
    const before = activity.count
    await act(async () => {
      await sleep(16)
    })
    quiet = activity.count === before && net.inflight === 0 ? quiet + 1 : 0
  }
}

interface Result {
  /** Presses until the target prompt sat on the jump line; `ideal` is the fewest possible. */
  presses: number
  ideal: number
  landed: boolean
  /** Jumps whose prompt did not stay on the line (the view moved after it). */
  disturbed: number
  requests: number
  commits: number
  commitMs: number
  /** From each press until its last render, scroll, or response; summed. */
  busyMs: number
  turns: number
  nodes: number
}

interface Scenario {
  name: string
  rows: MessageResponse[]
  loadedFrom: number
  target: string
  ideal: number
  /** Where the reader is before the first press: a prompt on the line, or the end. */
  from: string | 'end'
}

async function run(scenario: Scenario): Promise<Result> {
  seed(scenario.rows, scenario.loadedFrom)
  const tally = { counting: false, commits: 0, commitMs: 0 }
  const onRender = (_id: string, _phase: string, actualDuration: number) => {
    touch()
    if (!tally.counting) return
    tally.commits += 1
    tally.commitMs += actualDuration
  }
  const view = render(
    <Profiler id="transcript" onRender={onRender}>
      <Transcript />
    </Profiler>,
  )
  const s = install(view.container)
  s.scroller.scrollTop = scenario.from === 'end'
    ? Number.MAX_SAFE_INTEGER
    : s.top + (promptTop(s, scenario.from) ?? 0) - PROMPT_JUMP_MARGIN
  await settle()

  net.requests = 0
  tally.counting = true
  let presses = 0
  let busyMs = 0
  let disturbed = 0
  while (presses < MAX_PRESSES && !onMargin(promptTop(s, scenario.target))) {
    const jumps = s.jumps
    const pressedAt = performance.now()
    activity.at = pressedAt
    presses += 1
    await act(async () => {
      fireEvent.keyDown(document, { key: 'ArrowUp', ctrlKey: true, altKey: true })
    })
    await settle()
    busyMs += activity.at - pressedAt
    if (s.jumps > jumps && !promptOnMargin(s)) disturbed += 1
  }
  tally.counting = false

  const turns = Array.from(s.list.children).filter((c) => heightOf(c) !== BUTTON_H && !c.hasAttribute('data-chat-scroll-anchor')).length
  return {
    presses,
    ideal: scenario.ideal,
    landed: onMargin(promptTop(s, scenario.target)),
    disturbed,
    requests: net.requests,
    commits: tally.commits,
    commitMs: tally.commitMs,
    busyMs,
    turns,
    nodes: s.scroller.getElementsByTagName('*').length,
  }
}

// ── Scenarios ────────────────────────────────────────────────────────────────

function longAgentRun(): Scenario {
  seq = 0
  const earlier = range(10).flatMap((n) => exchange(n))
  const prompt = row('user', { content: 'Now migrate every module to the new option.' })
  const run = range(300).flatMap((n) => toolPair(n, 'edit_file'))
  const rows = [...earlier, prompt, ...run]
  // Six pages of tool calls sit between the latest page and the prompt.
  return { name: 'Long agent run (6 prompt-less pages)', rows, loadedFrom: rows.length - PAGE_ROWS, target: prompt.id, ideal: 1, from: 'end' }
}

function nextPage(): Scenario {
  seq = 0
  const exchanges = range(40).map((n) => exchange(n))
  const rows = exchanges.flat()
  // The loaded page starts inside exchange 27's reply; its prompt is a page back.
  return { name: 'Prompt on the page before', rows, loadedFrom: rows.length - PAGE_ROWS, target: exchanges[27][0].id, ideal: 1, from: exchanges[28][0].id }
}

function pastRenderWindow(): Scenario {
  seq = 0
  // 121 turn items, all loaded; the 80 rendered start with exchange 20's reply.
  const exchanges = range(60).map((n) => exchange(n, { report: n === 59 }))
  return { name: 'Loaded, past the 80 rendered turns', rows: exchanges.flat(), loadedFrom: 0, target: exchanges[20][0].id, ideal: 1, from: exchanges[21][0].id }
}

function walkBack(): Scenario {
  seq = 0
  const exchanges = range(60).map((n) => exchange(n))
  const rows = exchanges.flat()
  // From the end, 30 presses at best: across two page boundaries.
  return { name: 'Walk back 30 prompts from the end', rows, loadedFrom: rows.length - PAGE_ROWS, target: exchanges[30][0].id, ideal: 30, from: 'end' }
}

const results: Record<string, Result> = {}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

beforeAll(() => {
  globalThis.fetch = fakeFetch as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  stage = null
  Element.prototype.getBoundingClientRect = nativeRect
  useAgentStore.setState({ sessionId: null, agentStreams: {}, hasMore: false, nextCursor: null, _loadingOlder: false })
})

afterAll(async () => {
  globalThis.fetch = originalFetch
  if (process.env.BENCH_JSON) await Bun.write(process.env.BENCH_JSON, JSON.stringify(results, null, 2))
  const baseline: Record<string, Result> | null = process.env.BENCH_BASELINE
    ? JSON.parse(await Bun.file(process.env.BENCH_BASELINE).text())
    : null
  const columns: Array<[string, (r: Result) => string]> = [
    ['presses', (r) => `${r.presses}${r.landed ? '' : '✗'} (best ${r.ideal})`],
    ['disturbed', (r) => String(r.disturbed)],
    ['requests', (r) => String(r.requests)],
    ['commits', (r) => String(r.commits)],
    ['commit ms', (r) => r.commitMs.toFixed(1)],
    ['busy ms', (r) => r.busyMs.toFixed(0)],
    ['turns', (r) => String(r.turns)],
    ['DOM nodes', (r) => String(r.nodes)],
  ]
  console.log(`\n⌥⌘↑ benchmark — ${LATENCY_MS} ms per history request, median of ${RUNS} runs${baseline ? ' — baseline → this revision' : ''}\n`)
  for (const [name, result] of Object.entries(results)) {
    console.log(name)
    const before = baseline?.[name]
    for (const [label, cell] of columns) {
      console.log(`  ${label.padEnd(10)} ${before ? `${cell(before).padStart(14)} → ` : ''}${cell(result)}`)
    }
  }
  console.log()
})

describe('⌥⌘↑ to a prompt that is not rendered or not loaded', () => {
  for (const make of [longAgentRun, nextPage, pastRenderWindow, walkBack]) {
    it(make().name, async () => {
      const runs: Result[] = []
      for (let i = 0; i < RUNS; i++) {
        runs.push(await run(make()))
        cleanup()
        stage = null
        Element.prototype.getBoundingClientRect = nativeRect
      }
      // Counts do not vary between runs; times do.
      const result = { ...runs[0], commitMs: median(runs.map((r) => r.commitMs)), busyMs: median(runs.map((r) => r.busyMs)) }
      results[make().name] = result
      expect(runs.every((r) => r.presses === result.presses && r.commits === result.commits)).toBe(true)
    }, 180_000)
  }
})
