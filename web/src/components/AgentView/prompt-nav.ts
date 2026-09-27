/**
 * Prompt navigation over the rendered transcript: which prompt's turn is in
 * view, and which prompt a previous/next jump lands on.
 *
 * Positions are prompt tops in px from the transcript's top edge, in
 * transcript order, so the rules stay testable without layout.
 */

/** Where a prompt lands, below the transcript's top edge, after a jump. */
export const PROMPT_JUMP_MARGIN = 12

/** Slack for sub-pixel layout, so a prompt already on the line counts as there. */
const EPSILON = 2

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

/** The nearest prompt strictly above (``-1``) or below (``1``) ``line``; -1 when there is none. */
export function promptJumpTarget(tops: readonly number[], line: number, direction: -1 | 1): number {
  if (direction < 0) {
    for (let i = tops.length - 1; i >= 0; i--) if (tops[i] < line - EPSILON) return i
    return -1
  }
  for (let i = 0; i < tops.length; i++) if (tops[i] > line + EPSILON) return i
  return -1
}
