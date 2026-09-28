import { APP_EVENTS, dispatchAppEvent } from './app-events'

/** Spread onto the sidebar root so ⌘F inside it searches sessions. */
export const SIDEBAR_FIND_SCOPE = { 'data-find-scope': 'sidebar' } as const

/**
 * ⌘F follows focus: session search while focus is inside the sidebar,
 * transcript find everywhere else. Decided here rather than by a key handler
 * on the sidebar because the desktop menu owns ⌘F and re-dispatches it on
 * ``document``, which a handler inside the sidebar never sees.
 */
export function routeFindShortcut(findInTranscript: () => void): void {
  if (document.activeElement?.closest('[data-find-scope="sidebar"]')) {
    dispatchAppEvent(APP_EVENTS.searchSessions)
    return
  }
  findInTranscript()
}
