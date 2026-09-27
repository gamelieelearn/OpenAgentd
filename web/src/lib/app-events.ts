/**
 * Window events for chat-shell actions that have no keyboard shortcut.
 *
 * Native menu commands reach shortcut-backed actions by synthesizing the key
 * (``dispatchAppShortcut``); these events cover the rest, so the menu does
 * not need a key binding just to be routable.
 */
export const APP_EVENTS = {
  toggleScheduler: 'oa:toggle-scheduler',
  openWorkspace: 'oa:open-workspace',
  // The terminal key is matched on the physical Backquote code, which a
  // synthetic key press does not carry.
  openTerminal: 'oa:open-terminal',
  // The transcript owns the document it builds, so the palette asks for it.
  openSessionMarkdown: 'oa:open-session-markdown',
} as const

export type AppEvent = (typeof APP_EVENTS)[keyof typeof APP_EVENTS]

export function dispatchAppEvent(event: AppEvent): void {
  window.dispatchEvent(new Event(event))
}
