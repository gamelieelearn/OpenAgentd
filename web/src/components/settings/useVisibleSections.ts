import { useHealthQuery } from '@/queries/useHealthQuery'
import { SETTINGS_SECTIONS, type SettingsSectionDef } from './sections'

/** The section registry minus sections whose backend capability is missing (v2). */
export function useVisibleSettingsSections(): readonly SettingsSectionDef[] {
  const capabilities = useHealthQuery().data?.capabilities
  return SETTINGS_SECTIONS.filter((s) => !s.capability || (capabilities?.includes(s.capability) ?? false))
}
