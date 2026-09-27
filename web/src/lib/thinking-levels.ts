import type { ModelCatalogEntry } from '@/api/types'

/** Models with no declared levels still accept `none`. */
const FALLBACK_THINKING_LEVELS = ['none']

/** Thinking levels a model actually supports. `__none__` is an internal
 *  registry marker, never a user-selectable level. */
export function supportedThinkingLevels(entry: ModelCatalogEntry | undefined): string[] {
  const declared = entry?.thinking_levels ?? []
  const allowed = declared.length > 0 ? declared : FALLBACK_THINKING_LEVELS
  return allowed.filter((value) => value !== '__none__')
}

/**
 * Session override to store when the user picks model ``id``. The agent
 * default is stored as no override, and the current thinking level carries
 * over only if the new model can serve it.
 */
export function modelOverrideFor(
  id: string,
  models: ModelCatalogEntry[],
  defaultModel: string | null,
  thinkingLevel: string | null,
): { model: string | null; thinkingLevel: string | null } {
  const levels = supportedThinkingLevels(models.find((m) => m.id === id))
  return {
    model: id !== defaultModel ? id : null,
    thinkingLevel: thinkingLevel && levels.includes(thinkingLevel) ? thinkingLevel : null,
  }
}
