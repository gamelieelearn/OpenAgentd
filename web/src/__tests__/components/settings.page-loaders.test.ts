import { describe, expect, it } from 'bun:test'

import { settingsPageFor } from '@/components/settings/page-loaders'

describe('settingsPageFor', () => {
  it('maps drill-down and alias sections onto the page that renders them', () => {
    expect(settingsPageFor('about')).toBe('hub')
    expect(settingsPageFor('skills-edit')).toBe('skillsEdit')
    expect(settingsPageFor('mcp-new')).toBe('mcpNew')
    expect(settingsPageFor('sandbox')).toBe('deniedPaths')
    expect(settingsPageFor('denied_paths')).toBe('deniedPaths')
  })
})
