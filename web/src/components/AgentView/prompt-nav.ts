/**
 * Prompt navigation over the rendered transcript: which prompt's turn is in
 * view, and the line a jump lands a prompt on.
 *
 * Positions are prompt tops in px from the transcript's top edge, in
 * transcript order, so the rules stay testable without layout.
 */

/** The prompt bar's reach (2.125rem + borders) plus a gap, in rem. */
const PROMPT_LINE_REM = 2.75

/** Slack for sub-pixel layout, so a prompt already on the line counts as there. */
const EPSILON = 2

/**
 * The reading line, just below the prompt bar, in px from the transcript's
 * top edge. A jump lands its prompt here, clear of the bar, and a prompt at or
 * above it is the one being read. In rem, so it grows with the bar when the
 * root text size does (iOS Dynamic Type).
 */
export function promptLine(): number {
  const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return PROMPT_LINE_REM * (Number.isFinite(rootSize) && rootSize > 0 ? rootSize : 16)
}

/** Rendered prompts the user wrote, in transcript order. */
export function promptElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-prompt-id]'))
}

/** The last prompt at or above ``line``, whose turn the view is in; -1 before the first. */
export function currentPromptIndex(tops: readonly number[], line: number): number {
  let index = -1
  for (let i = 0; i < tops.length && tops[i] <= line + EPSILON; i++) index = i
  return index
}
