import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import { BUILD_INFO, formatBuildTime } from '../../../../../shared/build-info'
import type { AppUpdateStatus } from '../../../../../shared/app-update'
import { useStore } from '../../../state/store'
import { Button, Dialog, Modal, ModalOverlay, Notice, Switch } from '../../../ui'
import { settingsText } from '../settings-text'
import { generalText, type GeneralText } from './general-text'
import { piSourceLabel } from './general-model'
import { SettingsGroup, SettingsRow } from '../root/controls'

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
  onShowOnboarding?: () => void
}

export function AboutSettings({ onShowOnboarding }: AboutSettingsProps = {}): ReactElement {
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
      if (document.visibilityState !== 'visible') return
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
      {error ? (
        <Notice tone="fail" compact>
          {error}
        </Notice>
      ) : null}

      <SettingsGroup title={settingsCopy.groupAboutApp}>
        <SettingsRow
          settingId="about-version"
          label={text.aboutVersion}
          description={`${text.aboutBuild} ${formatBuildTime(BUILD_INFO.buildTime) || '—'}${
            BUILD_INFO.buildHash ? ` · ${BUILD_INFO.buildHash}` : ''
          }`}
        >
          <span className="settings-value" data-testid="v3-about-version">
            {BUILD_INFO.version || '—'}
          </span>
        </SettingsRow>

        <SettingsRow
          settingId="about-update-check"
          label={text.aboutUpdates}
          description={<span data-testid="v3-about-update-state">{phase}</span>}
        >
          {status?.phase === 'manual' ? (
            <Button
              variant="secondary"
              onPress={() => {
                if (status.releaseUrl) void openBrowser(status.releaseUrl)
              }}
            >
              {text.aboutUpdateReleases}
            </Button>
          ) : null}
          {status?.phase === 'available' ? (
            <Button variant="secondary" onPress={() => act('download')}>
              {text.aboutUpdateDownload}
            </Button>
          ) : null}
          {status?.phase === 'downloaded' ? (
            <Button variant="primary" data-testid="v3-about-update-install" onPress={() => setConfirmInstall(true)}>
              {text.aboutUpdateInstall}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            isDisabled={!status || status.phase === 'checking' || status.phase === 'downloading'}
            data-testid="v3-about-update-check"
            onPress={() => act('check')}
          >
            {text.aboutUpdateCheck}
          </Button>
        </SettingsRow>

        <SettingsRow settingId="about-update-auto" label={text.aboutUpdateAuto} description={text.aboutUpdateAutoDesc}>
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
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={settingsCopy.groupAboutMore}>
        <SettingsRow
          settingId="about-pi-redetect"
          label={text.aboutPi}
          description={
            <>
              {text.aboutPiDesc} · {piSourceLabel(piInfo?.source)} {piInfo?.version ?? '—'}
              {piInfo?.error ? ` · ${piInfo.error}` : ''}
            </>
          }
        >
          <Button variant="secondary" isDisabled={detecting} data-testid="v3-about-pi-redetect" onPress={() => void redetect()}>
            {detecting ? text.aboutRedetecting : text.aboutRedetect}
          </Button>
        </SettingsRow>

        <SettingsRow
          settingId="about-repository"
          label={text.aboutOpenSource}
          description={<span className="settings-path">{BUILD_INFO.repositoryUrl || '—'}</span>}
        >
          <Button
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

        {onShowOnboarding ? (
          <SettingsRow
            settingId="about-onboarding"
            label={settingsCopy.onboardingTitle}
            description={settingsCopy.onboardingDesc}
          >
            <Button variant="secondary" data-testid="v3-about-onboarding" onPress={onShowOnboarding}>
              {settingsCopy.onboardingAction}
            </Button>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <ModalOverlay className="settings-confirm-overlay" isOpen={confirmInstall} onOpenChange={setConfirmInstall}>
        <Modal className="settings-confirm-modal">
          <Dialog className="settings-confirm" title={text.aboutUpdateInstall} aria-label={text.aboutUpdateInstall}>
            <p className="settings-row__desc">{text.aboutUpdateInstallConfirm}</p>
            <div className="settings-actions">
              <Button variant="secondary" onPress={() => setConfirmInstall(false)}>
                {text.cancel}
              </Button>
              <Button variant="primary" data-testid="v3-about-update-install-confirm" onPress={install}>
                {text.aboutUpdateInstall}
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </section>
  )
}
