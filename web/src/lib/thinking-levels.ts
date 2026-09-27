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
