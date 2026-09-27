import { describe, expect, it } from 'bun:test'
import type { ModelCatalogEntry } from '@/api/types'
import { supportedThinkingLevels } from '@/lib/thinking-levels'

function model(id: string, thinking_levels: string[]): ModelCatalogEntry {
  const [provider, name] = id.split(':')
  return { id, provider, model: name, vision: false, output_image: false, output_video: false, thinking_levels, summary_trigger_tokens: 0, fast_mode: false }
}

const models = [model('openai:gpt-5', ['low', 'high']), model('zai:glm-4.6', [])]

describe('supportedThinkingLevels', () => {
  it('lists declared levels without the internal __none__ marker', () => {
    expect(supportedThinkingLevels(model('a:b', ['__none__', 'low']))).toEqual(['low'])
  })

  it('falls back to none when a model declares nothing', () => {
    expect(supportedThinkingLevels(models[1])).toEqual(['none'])
    expect(supportedThinkingLevels(undefined)).toEqual(['none'])
  })
})
