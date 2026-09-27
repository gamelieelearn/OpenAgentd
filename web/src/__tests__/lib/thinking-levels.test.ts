import { describe, expect, it } from 'bun:test'
import type { ModelCatalogEntry } from '@/api/types'
import { modelOverrideFor, supportedThinkingLevels } from '@/lib/thinking-levels'

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

describe('modelOverrideFor', () => {
  it('keeps the thinking level when the new model supports it', () => {
    expect(modelOverrideFor('openai:gpt-5', models, null, 'high')).toEqual({ model: 'openai:gpt-5', thinkingLevel: 'high' })
  })

  it('drops a thinking level the new model cannot serve', () => {
    expect(modelOverrideFor('zai:glm-4.6', models, null, 'high')).toEqual({ model: 'zai:glm-4.6', thinkingLevel: null })
  })

  it('stores the agent default as no override', () => {
    expect(modelOverrideFor('openai:gpt-5', models, 'openai:gpt-5', null)).toEqual({ model: null, thinkingLevel: null })
  })
})
