import { useEffect, useSyncExternalStore, type ReactElement } from 'react'
import { ConfirmProvider } from './confirm'
import { McpSection } from './McpSection'
import { SkillsSection } from './SkillsSection'
import { ExtensionsSection } from './ExtensionsSection'
import { MarketSection } from './MarketSection'
import { PromptsSection } from './PromptsSection'
import { VoiceSetupPanel, VoiceStatusPanel, useVoiceSetup } from './VoiceSection'
import { ComputerUseSection } from './ComputerUseSection'
import { SearchApiSection } from './SearchSection'
import { GitRuntimeSection } from './GitRuntimeSection'
import { getSettingsRequest, subscribeSettingsRequest } from '../root/deep-link'
import { getSettingReveal, requestSettingReveal, subscribeSettingReveal } from '../search/search-model'
import { CAPABILITIES_TABS, type CapabilitiesTabId } from '../types'
import './capabilities.css'

export type { CapabilitiesTabId }
const LEGACY_TAB: Record<string, CapabilitiesTabId> = { skills: 'skills', mcp: 'mcp', tools: 'tools', voice: 'tools', market: 'market', git: 'tools' }
const LEGACY_SETTING: Record<string, string> = { tools: 'caps-tools-computer-use', voice: 'caps-tools-voice-setup', git: 'caps-tools-git' }

let handledRevealRevision = 0
let handledRequestRevision: number | null = null

function isCapabilitiesTab(value: string | undefined): value is CapabilitiesTabId {
  return !!value && (CAPABILITIES_TABS as readonly string[]).includes(value)
}

export interface CapabilitiesSettingsProps {
  tab: CapabilitiesTabId
  onTabChange: (tab: CapabilitiesTabId) => void
}

export function CapabilitiesSettings({ tab, onTabChange }: CapabilitiesSettingsProps): ReactElement {
  const request = useSyncExternalStore(subscribeSettingsRequest, getSettingsRequest, getSettingsRequest)
  const reveal = useSyncExternalStore(subscribeSettingReveal, getSettingReveal, getSettingReveal)

  useEffect(() => {
    if (!reveal || reveal.revision <= handledRevealRevision) return
    handledRevealRevision = reveal.revision
    if (reveal.section === 'capabilities' && isCapabilitiesTab(reveal.tab) && reveal.tab !== tab) onTabChange(reveal.tab)
  }, [reveal, tab, onTabChange])

  useEffect(() => {
    if (!request || request.revision === handledRequestRevision) return
    handledRequestRevision = request.revision
    const target = LEGACY_TAB[request.view] ?? (request.view === 'capabilities' ? 'skills' : undefined)
    if (!target) return
    if (target !== tab) onTabChange(target)
    const settingId = LEGACY_SETTING[request.view]
    if (settingId) requestSettingReveal({ section: 'capabilities', tab: target, id: settingId })
  }, [request, tab, onTabChange])

  return (
    <ConfirmProvider>
      <div className="caps-root caps-tabpanel" data-testid="caps-settings" data-tab={tab}>
        {tab === 'skills' ? (
          <>
            <SkillsSection />
            <ExtensionsSection />
            <PromptsSection />
          </>
        ) : tab === 'mcp' ? (
          <McpSection />
        ) : tab === 'tools' ? (
          <ToolsTab />
        ) : (
          <MarketSection />
        )}
      </div>
    </ConfirmProvider>
  )
}

function ToolsTab(): ReactElement {
  const voice = useVoiceSetup()
  return (
    <>
      <ComputerUseSection />
      <VoiceStatusPanel voice={voice} />
      <SearchApiSection />
      <div data-setting-id="caps-tools-git">
        <GitRuntimeSection />
      </div>
      <div data-setting-id="caps-tools-voice-setup">
        <VoiceSetupPanel voice={voice} />
      </div>
    </>
  )
}
