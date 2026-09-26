import { afterEach, describe, expect, it } from 'bun:test'
import { dynamicTypeScale, followDynamicType, MAX_DYNAMIC_TYPE_SCALE } from '@/lib/dynamic-type'

// happy-dom cannot resolve ``-apple-system-body``, so the probe's computed
// size stands in for WKWebView's answer.
let bodyPx = '17px'
const originalGetComputedStyle = window.getComputedStyle

function stubProbe() {
  window.getComputedStyle = ((element: Element, pseudo?: string | null) =>
    element instanceof HTMLElement && element.hasAttribute('data-dynamic-type-probe')
      ? ({ fontSize: bodyPx } as CSSStyleDeclaration)
      : originalGetComputedStyle.call(window, element, pseudo)) as typeof window.getComputedStyle
}

afterEach(() => {
  window.getComputedStyle = originalGetComputedStyle
  document.documentElement.style.removeProperty('font-size')
  bodyPx = '17px'
})

describe('dynamicTypeScale', () => {
  it('follows the body size from the iOS default, never below the design size, up to the cap', () => {
    expect(dynamicTypeScale(17)).toBe(1)
    expect(dynamicTypeScale(14)).toBe(1)
    expect(dynamicTypeScale(19)).toBeCloseTo(19 / 17)
    expect(dynamicTypeScale(28)).toBe(MAX_DYNAMIC_TYPE_SCALE)
    expect(dynamicTypeScale(Number.NaN)).toBe(1)
  })
})

describe('followDynamicType', () => {
  it('scales the root font size and follows a changed text size', () => {
    stubProbe()
    bodyPx = '19px'
    const stop = followDynamicType()
    const root = document.documentElement
    expect(parseFloat(root.style.fontSize)).toBeCloseTo((16 * 19) / 17)

    // Back from Settings at the default size.
    bodyPx = '17px'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(root.style.fontSize).toBe('')

    bodyPx = '21px'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(root.style.fontSize).not.toBe('')

    stop()
    expect(root.style.fontSize).toBe('')
    expect(document.querySelector('[data-dynamic-type-probe]')).toBeNull()
  })
})
