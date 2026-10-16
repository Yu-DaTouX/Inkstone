import type { ReactElement } from 'react'
import { SettingsPage } from '../features/settings/root'
import { installSettingsDeepLink } from '../features/settings/root/deep-link'

installSettingsDeepLink()

export interface SettingsPanelV3Props {
  onBack?: () => void
  onRuns?: () => void
  onShowOnboarding?: () => void
}

export function SettingsPanelV3({ onBack, onRuns, onShowOnboarding }: SettingsPanelV3Props = {}): ReactElement {
  return <SettingsPage onBack={onBack} onRuns={onRuns} onShowOnboarding={onShowOnboarding} />
}
