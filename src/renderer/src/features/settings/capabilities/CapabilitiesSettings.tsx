import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import { Tab, TabList, TabPanel, Tabs } from '../../../ui'
import { useCapsText } from './text'
import { ConfirmProvider } from './confirm'
import { McpSection } from './McpSection'
import { SkillsSection } from './SkillsSection'
import { ExtensionsSection } from './ExtensionsSection'
import { MarketSection } from './MarketSection'
import { PromptsSection } from './PromptsSection'
import { VoiceSetupPanel, VoiceStatusPanel, useVoiceSetup } from './VoiceSection'
import { ComputerUseSection } from './ComputerUseSection'
import { SearchApiSection, SearchBackendSection } from './SearchSection'
import { GitRuntimeSection } from './GitRuntimeSection'
import { SettingsMore } from '../root/controls'
import { getSettingsRequest, subscribeSettingsRequest } from '../root/deep-link'
import { getSettingReveal, requestSettingReveal, subscribeSettingReveal } from '../search/search-model'
import './capabilities.css'

export type CapabilitiesTabId = 'skills' | 'mcp' | 'tools' | 'market'

const TAB_IDS: readonly CapabilitiesTabId[] = ['skills', 'mcp', 'tools', 'market']
const LEGACY_TAB: Record<string, CapabilitiesTabId> = { voice: 'tools', market: 'market', git: 'tools' }
const LEGACY_SETTING: Record<string, string> = { voice: 'caps-tools-voice-setup', git: 'caps-tools-git' }

let handledRevealRevision = 0
let handledRequestRevision: number | null = null

function isCapabilitiesTab(value: string | undefined): value is CapabilitiesTabId {
  return !!value && (TAB_IDS as readonly string[]).includes(value)
}

export function CapabilitiesSettings(): ReactElement {
  const t = useT()
  const text = useCapsText()
  const request = useSyncExternalStore(subscribeSettingsRequest, getSettingsRequest, getSettingsRequest)
  const reveal = useSyncExternalStore(subscribeSettingReveal, getSettingReveal, getSettingReveal)
  const [tab, setTab] = useState<CapabilitiesTabId>(() => {
    if (reveal && reveal.revision > handledRevealRevision && reveal.section === 'capabilities' && isCapabilitiesTab(reveal.tab)) {
      return reveal.tab
    }
    if (request && request.revision !== handledRequestRevision) return LEGACY_TAB[request.view] ?? 'skills'
    return 'skills'
  })

  useEffect(() => {
    if (!reveal || reveal.revision <= handledRevealRevision) return
    handledRevealRevision = reveal.revision
    if (reveal.section === 'capabilities' && isCapabilitiesTab(reveal.tab)) setTab(reveal.tab)
  }, [reveal])

  useEffect(() => {
    if (!request || request.revision === handledRequestRevision) return
    handledRequestRevision = request.revision
    const target = LEGACY_TAB[request.view]
    if (!target) return
    setTab(target)
    const settingId = LEGACY_SETTING[request.view]
    if (settingId) requestSettingReveal({ section: 'capabilities', tab: target, id: settingId })
  }, [request])

  return (
    <ConfirmProvider>
      <div className="caps-root" data-testid="caps-settings">
        <Tabs
          selectedKey={tab}
          onSelectionChange={(key) => {
            if (typeof key === 'string' && isCapabilitiesTab(key)) setTab(key)
          }}
          className="caps-tabs"
        >
          <TabList className="caps-tablist" aria-label={t('set.capabilities')}>
            <Tab id="skills" data-testid="caps-tab-skills">
              {text('tabSkills')}
            </Tab>
            <Tab id="mcp" data-testid="caps-tab-mcp">
              {text('tabMcp')}
            </Tab>
            <Tab id="tools" data-testid="caps-tab-tools">
              {text('tabTools')}
            </Tab>
            <Tab id="market" data-testid="caps-tab-market">
              {t('market.title')}
            </Tab>
          </TabList>

          <TabPanel id="skills" className="caps-tabpanel">
            <SkillsSection />
            <ExtensionsSection />
            <SettingsMore>
              <PromptsSection />
            </SettingsMore>
          </TabPanel>
          <TabPanel id="mcp" className="caps-tabpanel">
            <McpSection />
          </TabPanel>
          <TabPanel id="tools" className="caps-tabpanel">
            <ToolsTab />
          </TabPanel>
          <TabPanel id="market" className="caps-tabpanel">
            <MarketSection />
          </TabPanel>
        </Tabs>
      </div>
    </ConfirmProvider>
  )
}

function ToolsTab(): ReactElement {
  const voice = useVoiceSetup()
  return (
    <>
      <ComputerUseSection />
      <SearchBackendSection />
      <VoiceStatusPanel voice={voice} />
      <SettingsMore>
        <SearchApiSection />
        <div data-setting-id="caps-tools-git">
          <GitRuntimeSection />
        </div>
        <div data-setting-id="caps-tools-voice-setup">
          <VoiceSetupPanel voice={voice} />
        </div>
      </SettingsMore>
    </>
  )
}
