/**
 * The stack of things open over the app, in the order they opened.
 *
 * DOM order and mount order do not say what is on top: a popover inside a
 * dialog renders earlier in the DOM, and hooks register at mount, not at
 * open. Every surface that opens over the app pushes a layer when it opens
 * and removes it when it closes, so the last entry is what the user sees on
 * top. The dispatcher reads this to route Escape and to block app shortcuts.
 *
 * - ``dialog``: confirmations and forms. Blocks every app shortcut.
 * - ``overlay``: palette, Settings, lightboxes, fullscreen views. Blocks app
 *   shortcuts except switchers (⌘K, ⌘P, ⌘,), unless ``allowSwitch`` says no.
 * - ``transient``: popovers, menus, pinned tooltips. Only takes Escape.
 *
 * Limit: surfaces that open in the same render are ordered child first
 * (React runs child effects before parent ones). Nested surfaces here open
 * on a later click, so this does not come up.
 */
export type LayerKind = 'dialog' | 'overlay' | 'transient'

export interface LayerInit {
  kind: LayerKind
  /** Escape on the top layer, or a switcher replacing it. */
  close: () => void
  /** ``false`` keeps switchers out, e.g. Settings with unsaved changes. */
  allowSwitch?: () => boolean
  /**
   * Close it before a switcher runs. Surfaces that a store swaps by itself
   * (palette, Settings) leave this off; the rest would stay open underneath.
   * Defaults to true for transient layers.
   */
  closeOnSwitch?: boolean
  /** The layer's root, so keys for regions inside it keep working. */
  element?: () => Element | null
}

export interface KeyLayer extends LayerInit {
  id: number
}

let stack: KeyLayer[] = []
let nextId = 1

export function pushLayer(init: LayerInit): number {
  const id = nextId++
  stack = [...stack, { ...init, id }]
  return id
}

export function removeLayer(id: number): void {
  stack = stack.filter((layer) => layer.id !== id)
}

export function layerStack(): readonly KeyLayer[] {
  return stack
}

export function topLayer(): KeyLayer | null {
  return stack.at(-1) ?? null
}

/** The topmost layer that blocks app shortcuts, if any. */
export function topBlockingLayer(): KeyLayer | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].kind !== 'transient') return stack[i]
  }
  return null
}

export function isTopLayer(id: number | null): boolean {
  return id !== null && topLayer()?.id === id
}

export function _resetLayersForTests(): void {
  stack = []
}
