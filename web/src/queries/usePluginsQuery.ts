import { useQuery } from '@tanstack/react-query'
import { listPlugins } from '@/api/client'
import { queryKeys } from './keys'

/**
 * Plugin status (v3 `api.plugins`). Deliberately not re-exported from the
 * queries barrel: only lazily loaded UI (the Plugins page, the plugin notice)
 * uses it, which keeps it out of the eager bundle.
 */
export function usePluginsQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.plugins(),
    queryFn: listPlugins,
    enabled,
    // Plugins load once per server process; `config_changed` invalidates
    // this entry when plugin files change on disk.
    staleTime: 60_000,
  })
}
