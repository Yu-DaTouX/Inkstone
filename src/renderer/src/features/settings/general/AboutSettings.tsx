import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import { BUILD_INFO, formatBuildTime } from '../../../../../shared/build-info'
import type { AppUpdateStatus } from '../../../../../shared/app-update'
import { useStore } from '../../../state/store'
import { Button, Dialog, Modal, ModalOverlay, Switch } from '../../../ui'
import { settingsText } from '../settings-text'
import { generalText, type GeneralText } from './general-text'
import { piSourceLabel } from './general-model'
import { SettingsRow } from '../root/controls'

const PHASE_TEXT: Record<AppUpdateStatus['phase'], keyof GeneralText> = {
  idle: 'aboutPhaseIdle',
  checking: 'aboutPhaseChecking',
  current: 'aboutPhaseCurrent',
  available: 'aboutPhaseAvailable',
  downloading: 'aboutPhaseDownloading',
  downloaded: 'aboutPhaseDownloaded',
  error: 'aboutPhaseError',
  manual: 'aboutPhaseManual'
}

export interface AboutSettingsProps {
  onOpenModels?: () => void
  onShowOnboarding?: () => void
}

export function AboutSettings({ onOpenModels, onShowOnboarding }: AboutSettingsProps = {}): ReactElement {
  const { lang } = useI18n()
  const text = generalText(lang)
  const settingsCopy = settingsText(lang)
  const piInfo = useStore((s) => s.piInfo)
  const redetectPi = useStore((s) => s.redetectPi)
  const openBrowser = useStore((s) => s.openBrowser)
  const [status, setStatus] = useState<AppUpdateStatus | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [confirmInstall, setConfirmInstall] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const refresh = (): void => {
      void window.yan.appUpdate
        .status()
        .then((value) => {
          if (alive.current) setStatus(value)
        })
        .catch((cause) => {
          if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
        })
    }
    refresh()
    const id = window.setInterval(refresh, 5000)
    return () => {
      alive.current = false
      window.clearInterval(id)
    }
  }, [])

  const act = (action: 'check' | 'download'): void => {
    setError('')
    const pending = action === 'check' ? window.yan.appUpdate.check() : window.yan.appUpdate.download()
    void pending
      .then((value) => {
        if (alive.current) setStatus(value)
      })
      .catch((cause) => {
        if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  const install = (): void => {
    setConfirmInstall(false)
    void window.yan.appUpdate
      .install()
      .then((result) => {
        if (!result.ok && alive.current) setError(result.error ?? '')
      })
      .catch((cause) => {
        if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  const redetect = async (): Promise<void> => {
    setDetecting(true)
    try {
      await redetectPi()
    } finally {
      if (alive.current) setDetecting(false)
    }
  }

  const phase = status ? text[PHASE_TEXT[status.phase]] : text.aboutPhaseIdle

  return (
    <section className="settings-section" data-testid="v3-about-settings">
      <p className="settings-note" role="note">
        {text.aboutNote}
      </p>

      {error ? (
        <p className="settings-row__desc settings-row__desc--error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="settings-rows">
        <SettingsRow
          label={`${text.aboutVersion} ${BUILD_INFO.version || '—'}`}
          description={`${text.aboutBuild} ${formatBuildTime(BUILD_INFO.buildTime) || '—'}${
            BUILD_INFO.buildHash ? ` · ${BUILD_INFO.buildHash}` : ''
          }`}
        >
          {null}
        </SettingsRow>

        <SettingsRow
          label={text.aboutOpenSource}
          description={<span className="settings-path">{BUILD_INFO.repositoryUrl || '—'}</span>}
        >
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!BUILD_INFO.repositoryUrl}
            data-testid="v3-about-repo"
            onPress={() => {
              if (BUILD_INFO.repositoryUrl) void openBrowser(BUILD_INFO.repositoryUrl)
            }}
          >
            {text.aboutOpen}
          </Button>
        </SettingsRow>

        <SettingsRow
          label={text.aboutPi}
          description={
            <>
              {text.aboutPiDesc} · {piSourceLabel(piInfo?.source)} {piInfo?.version ?? '—'}
              {piInfo?.error ? ` · ${piInfo.error}` : ''}
            </>
          }
        >
          <Button size="sm" variant="secondary" isDisabled={detecting} data-testid="v3-about-pi-redetect" onPress={() => void redetect()}>
            {detecting ? text.aboutRedetecting : text.aboutRedetect}
          </Button>
        </SettingsRow>

        <SettingsRow label={text.aboutUpdates} description={<span data-testid="v3-about-update-state">{phase}</span>}>
          <Switch
            aria-label={text.aboutUpdateAuto}
            isSelected={status?.automatic ?? true}
            isDisabled={!status}
            onChange={(on) => {
              void window.yan.appUpdate
                .automatic(on)
                .then((value) => {
                  if (alive.current) setStatus(value)
                })
                .catch((cause) => {
                  if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
                })
            }}
            data-testid="v3-about-update-auto"
          />
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!status || status.phase === 'checking' || status.phase === 'downloading'}
            data-testid="v3-about-update-check"
            onPress={() => act('check')}
          >
            {text.aboutUpdateCheck}
          </Button>
          {status?.phase === 'available' ? (
            <Button size="sm" variant="primary" onPress={() => act('download')}>
              {text.aboutUpdateDownload}
            </Button>
          ) : null}
          {status?.phase === 'manual' ? (
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                if (status.releaseUrl) void openBrowser(status.releaseUrl)
              }}
            >
              {text.aboutUpdateReleases}
            </Button>
          ) : null}
          {status?.phase === 'downloaded' ? (
            <Button size="sm" variant="primary" data-testid="v3-about-update-install" onPress={() => setConfirmInstall(true)}>
              {text.aboutUpdateInstall}
            </Button>
          ) : null}
        </SettingsRow>

        <SettingsRow label={text.aboutCredentials} description={text.aboutCredentialsDesc}>
          {onOpenModels ? (
            <Button size="sm" variant="secondary" data-testid="v3-about-models" onPress={onOpenModels}>
              {text.aboutCredentialsAction}
            </Button>
          ) : (
            <span className="settings-value">—</span>
          )}
        </SettingsRow>

        {onShowOnboarding ? (
          <SettingsRow label={settingsCopy.onboardingTitle} description={settingsCopy.onboardingDesc}>
            <Button size="sm" variant="secondary" data-testid="v3-about-onboarding" onPress={onShowOnboarding}>
              {settingsCopy.onboardingAction}
            </Button>
          </SettingsRow>
        ) : null}
      </div>

      <ModalOverlay className="settings-confirm-overlay" isOpen={confirmInstall} onOpenChange={setConfirmInstall}>
        <Modal className="settings-confirm-modal">
          <Dialog className="settings-confirm" title={text.aboutUpdateInstall} aria-label={text.aboutUpdateInstall}>
            <p className="settings-row__desc">{text.aboutUpdateInstallConfirm}</p>
            <div className="settings-actions">
              <Button variant="secondary" size="sm" onPress={() => setConfirmInstall(false)}>
                {text.cancel}
              </Button>
              <Button variant="primary" size="sm" data-testid="v3-about-update-install-confirm" onPress={install}>
                {text.aboutUpdateInstall}
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </section>
  )
}
