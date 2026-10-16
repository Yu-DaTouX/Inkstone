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
import { VoiceSection } from './VoiceSection'
import { ComputerUseSection } from './ComputerUseSection'
import { getSettingsRequest, subscribeSettingsRequest } from '../root/deep-link'
import './capabilities.css'

export type CapabilitiesTabId = 'connections' | 'skills' | 'extensions' | 'market' | 'prompts' | 'voice'

const LEGACY_TAB: Record<string, CapabilitiesTabId> = { voice: 'voice', market: 'market' }

export function CapabilitiesSettings(): ReactElement {
  const t = useT()
  const text = useCapsText()
  const request = useSyncExternalStore(subscribeSettingsRequest, getSettingsRequest, getSettingsRequest)
  const [tab, setTab] = useState<CapabilitiesTabId>(() => LEGACY_TAB[request?.view ?? ''] ?? 'connections')
  useEffect(() => {
    const target = LEGACY_TAB[request?.view ?? '']
    if (target) setTab(target)
  }, [request?.revision, request?.view])

  return (
    <ConfirmProvider>
      <div className="caps-root" data-testid="caps-settings">
        <Tabs
          selectedKey={tab}
          onSelectionChange={(key) => {
            if (typeof key === 'string') setTab(key as CapabilitiesTabId)
          }}
          className="caps-tabs"
        >
          <TabList className="caps-tablist" aria-label={t('set.capabilities')}>
            <Tab id="connections" data-testid="caps-tab-connections">
              {t('set.connections')}
            </Tab>
            <Tab id="skills" data-testid="caps-tab-skills">
              {t('cap.skillsTitle')}
            </Tab>
            <Tab id="extensions" data-testid="caps-tab-extensions">
              {text('extensions')}
            </Tab>
            <Tab id="market" data-testid="caps-tab-market">
              {t('market.title')}
            </Tab>
            <Tab id="prompts" data-testid="caps-tab-prompts">
              {text('prompts')}
            </Tab>
            <Tab id="voice" data-testid="caps-tab-voice">
              {t('voice.title')}
            </Tab>
          </TabList>

          <TabPanel id="connections" className="caps-tabpanel">
            <McpSection />
            <ComputerUseSection />
          </TabPanel>
          <TabPanel id="skills" className="caps-tabpanel">
            <SkillsSection />
          </TabPanel>
          <TabPanel id="extensions" className="caps-tabpanel">
            <ExtensionsSection />
          </TabPanel>
          <TabPanel id="market" className="caps-tabpanel">
            <MarketSection />
          </TabPanel>
          <TabPanel id="prompts" className="caps-tabpanel">
            <PromptsSection />
          </TabPanel>
          <TabPanel id="voice" className="caps-tabpanel">
            <VoiceSection />
          </TabPanel>
        </Tabs>
      </div>
    </ConfirmProvider>
  )
}
