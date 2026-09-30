/**
 * The Settings modal's root element. Settings pages scope their own
 * shortcuts (⌘S) to it, so they work while Settings is the top layer and
 * stop while a dialog opens over it.
 */
export const SETTINGS_ROOT_ATTR = 'data-settings-modal'

export function settingsRoot(): Element | null {
  return typeof document === 'undefined' ? null : document.querySelector(`[${SETTINGS_ROOT_ATTR}]`)
}
