import { afterEach, describe, expect, it, mock } from 'bun:test'

import { APP_EVENTS } from '@/lib/app-events'
import { routeFindShortcut } from '@/lib/find-shortcut'

afterEach(() => {
  document.body.innerHTML = ''
})

function focusButton(scope?: string): void {
  const wrapper = document.createElement('div')
  if (scope) wrapper.setAttribute('data-find-scope', scope)
  const button = document.createElement('button')
  wrapper.appendChild(button)
  document.body.appendChild(wrapper)
  button.focus()
}

describe('routeFindShortcut', () => {
  it('searches sessions while focus is inside the sidebar', () => {
    const findInTranscript = mock(() => {})
    const searchSessions = mock(() => {})
    window.addEventListener(APP_EVENTS.searchSessions, searchSessions)
    focusButton('sidebar')

    routeFindShortcut(findInTranscript)

    window.removeEventListener(APP_EVENTS.searchSessions, searchSessions)
    expect(searchSessions).toHaveBeenCalledTimes(1)
    expect(findInTranscript).not.toHaveBeenCalled()
  })

  it('finds in the transcript everywhere else', () => {
    const findInTranscript = mock(() => {})
    focusButton()

    routeFindShortcut(findInTranscript)

    expect(findInTranscript).toHaveBeenCalledTimes(1)
  })
})
