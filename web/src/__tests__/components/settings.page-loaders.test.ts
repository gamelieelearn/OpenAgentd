import { describe, expect, it } from 'bun:test'

import { settingsPageFor } from '@/components/settings/page-loaders'
import { parentSection, type SettingsSection } from '@/stores/useSettingsStore'

describe('settingsPageFor', () => {
  it('maps drill-down sections onto the page that renders them', () => {
    expect(settingsPageFor('about')).toBe('hub')
    expect(settingsPageFor('skills-edit')).toBe('skillsEdit')
    expect(settingsPageFor('mcp-new')).toBe('mcpNew')
    expect(settingsPageFor('denied_paths')).toBe('deniedPaths')
  })

  it('sends the retired sandbox section, still in persisted state, to About', () => {
    const legacy = 'sandbox' as SettingsSection
    expect(settingsPageFor(legacy)).toBe('hub')
    expect(parentSection(legacy)).toBe('about')
  })
})
