import { Suspense, useEffect, type ReactElement } from 'react'
import { useStore } from '../state/store'
import { usePresence } from '../ui'
import { preloadable } from '../lib/preloadable'
import type { SettingsPageProps } from '../features/settings/root'
import { consumeSettingsHash, installSettingsDeepLink } from '../features/settings/root/deep-link'

installSettingsDeepLink()

const settingsPage = preloadable<SettingsPageProps>(() => import('../features/settings/root').then((m) => ({ default: m.SettingsPage })))
const SettingsPage = settingsPage.Component
const loadSettings = settingsPage.preload

export interface SettingsPanelV3Props {
  onShowOnboarding?: () => void
}

function closeSettings(): void {
  useStore.getState().closeSettings()
}

export function SettingsPanelV3({ onShowOnboarding }: SettingsPanelV3Props = {}): ReactElement | null {
  const open = useStore((s) => s.settingsOpen)
  const presence = usePresence(open)

  useEffect(() => {
    const idle = window.requestIdleCallback(() => { void loadSettings().catch(() => undefined) }, { timeout: 2000 })
    return () => window.cancelIdleCallback(idle)
  }, [])

  useEffect(() => {
    consumeSettingsHash()
    const onHash = (): void => {
      consumeSettingsHash()
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (!presence.present) return null
  return (
    <Suspense fallback={null}>
      <SettingsPage
        isOpen={open}
        onClose={closeSettings}
        onShowOnboarding={
          onShowOnboarding
            ? () => {
                closeSettings()
                onShowOnboarding()
              }
            : undefined
        }
      />
    </Suspense>
  )
}
