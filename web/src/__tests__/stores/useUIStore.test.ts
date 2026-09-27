import { afterEach, describe, expect, it } from 'bun:test'

import { useUIStore } from '@/stores/useUIStore'

function resetUIStore(): void {
  useUIStore.setState({
    schedulerOpen: false,
    agentCapabilitiesOpen: false,
    paletteOpen: false,
    palettePage: null,
    quickOpenOpen: false,
    telemetryOpen: false,
  })
}

afterEach(resetUIStore)

describe('useUIStore utility modals', () => {
  it('keeps only one utility modal open at a time', () => {
    useUIStore.getState().toggleScheduler()
    expect(useUIStore.getState().schedulerOpen).toBe(true)

    useUIStore.getState().toggleAgentCapabilities()
    expect(useUIStore.getState().schedulerOpen).toBe(false)
    expect(useUIStore.getState().agentCapabilitiesOpen).toBe(true)
  })

  it('closes the currently open modal when toggled again', () => {
    useUIStore.getState().toggleAgentCapabilities()
    useUIStore.getState().toggleAgentCapabilities()

    expect(useUIStore.getState().agentCapabilitiesOpen).toBe(false)
    expect(useUIStore.getState().schedulerOpen).toBe(false)
  })

  it('togglePalette closes the other panels', () => {
    useUIStore.getState().toggleScheduler()
    expect(useUIStore.getState().schedulerOpen).toBe(true)

    useUIStore.getState().togglePalette()
    expect(useUIStore.getState().paletteOpen).toBe(true)
    expect(useUIStore.getState().schedulerOpen).toBe(false)
    expect(useUIStore.getState().agentCapabilitiesOpen).toBe(false)
  })

  it('keeps Quick Open and the Command Palette mutually exclusive', () => {
    useUIStore.getState().toggleQuickOpen()
    expect(useUIStore.getState().quickOpenOpen).toBe(true)

    useUIStore.getState().togglePalette()
    expect(useUIStore.getState()).toMatchObject({
      quickOpenOpen: false,
      paletteOpen: true,
    })
  })

  it('closeAll resets all utility panels', () => {
    useUIStore.setState({ schedulerOpen: true, agentCapabilitiesOpen: true, paletteOpen: true, quickOpenOpen: true, telemetryOpen: true })
    useUIStore.getState().closeAll()
    expect(useUIStore.getState()).toMatchObject({
      schedulerOpen: false,
      agentCapabilitiesOpen: false,
      paletteOpen: false,
      quickOpenOpen: false,
      telemetryOpen: false,
    })
  })

  it('opening telemetry closes the other overlays, and they close it', () => {
    useUIStore.getState().toggleScheduler()
    useUIStore.getState().openTelemetry()
    expect(useUIStore.getState()).toMatchObject({ telemetryOpen: true, schedulerOpen: false })

    useUIStore.getState().togglePalette()
    expect(useUIStore.getState()).toMatchObject({ telemetryOpen: false, paletteOpen: true })
  })

  it('toggleTelemetry flips the overlay', () => {
    useUIStore.getState().toggleTelemetry()
    expect(useUIStore.getState().telemetryOpen).toBe(true)
    useUIStore.getState().toggleTelemetry()
    expect(useUIStore.getState().telemetryOpen).toBe(false)
  })

  it('openPalette can land on one of its pages, and the next toggle starts at the root', () => {
    useUIStore.getState().toggleScheduler()
    useUIStore.getState().openPalette('change-model')
    expect(useUIStore.getState()).toMatchObject({ paletteOpen: true, palettePage: 'change-model', schedulerOpen: false })

    useUIStore.getState().closePalette()
    useUIStore.getState().togglePalette()
    expect(useUIStore.getState()).toMatchObject({ paletteOpen: true, palettePage: null })
  })
})
