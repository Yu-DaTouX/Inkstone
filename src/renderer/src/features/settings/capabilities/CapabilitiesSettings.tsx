/**
 * v3「能力与插件」设置（S2）。
 *
 * 分组：连接（MCP）/ 技能 / 扩展 / 市场 / 提示词。外观只用 `ui/` 与 `patterns/`，
 * 版面在本目录的 `capabilities.css`（features 层）；业务状态仍走主 store 与正式 IPC。
 *
 * 无 props：S0 的 `SettingsPanelV3` 直接挂 `<CapabilitiesSettings />`。
 *
 * 有意不做的事（与任务边界一致）：
 *   · 不新建 MCP 安装 / 授权通道，只复用 `prepareNativeImport/commitNativeImport`；
 *   · 不自动迁移凭证、不自动联网、不自动探测远端；
 *   · 没有稳定接口的项（如提示词的编辑）只读展示并标限制。
 */
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

/** 旧 `openSettings(name)` 页名里能直接落到某个能力分页的那几个。 */
const LEGACY_TAB: Record<string, CapabilitiesTabId> = { voice: 'voice', market: 'market' }

export function CapabilitiesSettings(): ReactElement {
  const t = useT()
  const text = useCapsText()
  const request = useSyncExternalStore(subscribeSettingsRequest, getSettingsRequest, getSettingsRequest)
  const [tab, setTab] = useState<CapabilitiesTabId>(() => LEGACY_TAB[request?.view ?? ''] ?? 'connections')
  /* 已经停在能力页时再次收到 voice / market 深链接，也要落到对应分页（revision 每次都变） */
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
