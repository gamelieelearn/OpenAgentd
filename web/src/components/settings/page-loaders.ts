/**
 * Dynamic imports for the Settings section pages, shared by SettingsModal's
 * ``lazy()`` components and the hover/focus preload on its triggers, so each
 * page chunk is requested once from either path.
 *
 * Preloading waits for intent rather than idle time: in the packaged shells
 * the assets are local, so a launch-time warm-up would only spend CPU and
 * memory on pages most sessions never open (see ``optimistic-preload.ts``).
 */
import { useSettingsStore, type SettingsSection } from '@/stores/useSettingsStore'

export const settingsPageLoaders = {
  hub: () => import('@/components/settings/pages/settings.index'),
  agents: () => import('@/components/settings/pages/settings.agents'),
  skills: () => import('@/components/settings/pages/settings.skills'),
  skillsNew: () => import('@/components/settings/pages/settings.skills.new'),
  skillsEdit: () => import('@/components/settings/pages/settings.skills.$name'),
  mcp: () => import('@/components/settings/pages/settings.mcp'),
  mcpNew: () => import('@/components/settings/pages/settings.mcp.new'),
  mcpEdit: () => import('@/components/settings/pages/settings.mcp.$name'),
  memory: () => import('@/components/settings/pages/settings.memory'),
  providers: () => import('@/components/settings/pages/settings.providers'),
  deniedPaths: () => import('@/components/settings/pages/settings.denied_paths'),
  automation: () => import('@/components/settings/pages/settings.automation'),
  plugins: () => import('@/components/settings/pages/settings.plugins'),
}

type SettingsPage = keyof typeof settingsPageLoaders

const PAGE_FOR_SECTION: Record<SettingsSection, SettingsPage> = {
  about: 'hub',
  agents: 'agents',
  skills: 'skills',
  'skills-new': 'skillsNew',
  'skills-edit': 'skillsEdit',
  mcp: 'mcp',
  'mcp-new': 'mcpNew',
  'mcp-edit': 'mcpEdit',
  providers: 'providers',
  denied_paths: 'deniedPaths',
  memory: 'memory',
  plugins: 'plugins',
  automation: 'automation',
}

/** The page that renders ``section`` (unknown restored sections fall back to the hub). */
export function settingsPageFor(section: SettingsSection): SettingsPage {
  return PAGE_FOR_SECTION[section] ?? 'hub'
}

/** Start loading the page Settings will open on (the last visited section by default). */
export function preloadSettings(section: SettingsSection = useSettingsStore.getState().section): void {
  void settingsPageLoaders[settingsPageFor(section)]().catch(() => {
    // A failed preload is not an error; opening the page retries.
  })
}
