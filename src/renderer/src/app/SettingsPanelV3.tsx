import { lazy, Suspense, useEffect, type ReactElement } from 'react'
import { useStore } from '../state/store'
import { consumeSettingsHash, installSettingsDeepLink } from '../features/settings/root/deep-link'

installSettingsDeepLink()

const SettingsPage = lazy(() => import('../features/settings/root').then((m) => ({ default: m.SettingsPage })))

export interface SettingsPanelV3Props {
  onShowOnboarding?: () => void
}

function closeSettings(): void {
  useStore.getState().closeSettings()
}

export function SettingsPanelV3({ onShowOnboarding }: SettingsPanelV3Props = {}): ReactElement | null {
  const open = useStore((s) => s.settingsOpen)

  useEffect(() => {
    consumeSettingsHash()
    const onHash = (): void => {
      consumeSettingsHash()
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (!open) return null
  return (
    <Suspense fallback={null}>
      <SettingsPage
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
