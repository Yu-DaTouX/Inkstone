import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { BrandMark } from '../shell/BrandMark'
import { useStore } from '../../state/store'
import type { ToolchainStatus } from '../../../../shared/ipc'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import { Button, IconButton } from '../ui'
import { GitInstallControl } from './GitInstallControl'
import { toolMissingText } from '../../lib/toolchain-text'

function OnboardingRow({ ok, title, desc, action, testId }: { ok: boolean; title: string; desc: React.ReactNode; action?: React.ReactNode; testId: string }) {
  return <div className={`ob-row ${ok ? 'ob-ok' : 'ob-todo'}`} data-testid={testId} data-ok={ok ? '1' : '0'}>
    <span className="ob-check" aria-hidden>{ok ? <Icon name="check" size={12} /> : null}</span>
    <div className="ob-row-main"><div className="ob-row-title">{title}</div><div className="ob-row-desc">{desc}</div></div>
    {action ? <div className="ob-row-act">{action}</div> : null}
  </div>
}

export function Onboarding({ onClose }: { onClose: () => void }) {
  const t = useT()
  const piInfo = useStore((s) => s.piInfo)
  const session = useStore((s) => s.session)
  const conn = useStore((s) => s.conn)
  const models = useStore((s) => s.models)
  const openSettings = useStore((s) => s.openSettings)

  const card = useRef<HTMLDivElement>(null)
  const { isTop } = useModalLayer(true, onClose)
  useFocusTrap(card, true, isTop)

  const [ready, setReady] = useState<{ n: number; total: number; fromEnv: number } | null>(null)
  const [authError, setAuthError] = useState('')
  const authGeneration = useRef(0)
  const toolsGeneration = useRef(0)

  const detect = useCallback(async () => {
    const generation = ++authGeneration.current
    setAuthError('')
    try {
      const list = await window.yan.authProviders(false)
      const okList = list.filter((x) => x.status === 'ready')
      if (generation !== authGeneration.current) return
      setReady({ n: okList.length, total: list.length, fromEnv: okList.filter((x) => x.source === 'env').length })
    } catch (error) {
      if (generation !== authGeneration.current) return
      setReady(null)
      setAuthError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void detect()
    return () => { authGeneration.current++ }
  }, [detect])

  const piOk = !!piInfo?.version
  const connOk = conn === 'ready'
  const modelOk = models.length > 0 && !!session?.model && session.model.id !== 'unknown'
  const authOk = (ready?.n ?? 0) > 0

  const [tools, setTools] = useState<ToolchainStatus | null>(null)
  const detectTools = useCallback(async () => {
    const generation = ++toolsGeneration.current
    try {
      const result = await window.yan.toolchainStatus()
      if (generation === toolsGeneration.current) setTools(result)
    } catch {
      if (generation === toolsGeneration.current) setTools(null)
    }
  }, [])
  useEffect(() => {
    void detectTools()
    return () => { toolsGeneration.current++ }
  }, [detectTools])
  const toolsOk = !tools || (tools.bash.ok && tools.git.ok)

  return (
    <div className="ob-scrim" role="dialog" aria-modal="true" aria-label={t('ob.title')}>
      <div className="ob-card" ref={card} data-testid="onboarding">
        <div className="ob-head">
          <span className="ob-logo">
            <BrandMark size={22} decorative />
          </span>
          <div>
            <div className="ob-title">{t('ob.title')}</div>
            <div className="ob-sub">{t('ob.sub')}</div>
          </div>
          <span className="spacer" />
          <IconButton icon="close" iconSize={14} className="ob-x" label={t('ob.skip')} data-testid="ob-close" onClick={onClose} />
        </div>

        <div className="ob-body">
          <OnboardingRow
            testId="ob-pi"
            ok={piOk}
            title={t('ob.piTitle')}
            desc={
              piOk ? (
                <>
                  {t('ob.piFound')} <code>{piInfo?.version}</code>
                  <span className="ob-src">
                    {' · '}
                    {piInfo?.bundled ? t('ob.piSourceBundled') : t('ob.piSourceExternal')}
                  </span>
                </>
              ) : (
                <>
                  {t('ob.piMissing')} <code>npm i -g @earendil-works/pi-coding-agent</code>
                </>
              )
            }
          />

          <OnboardingRow
            testId="ob-auth"
            ok={authOk}
            title={t('ob.authTitle')}
            desc={
              authOk ? (
                <>
                  {t('ob.authOk', { n: ready?.n ?? 0 })}
                  {ready && ready.fromEnv > 0 ? (
                    <span data-testid="ob-auth-env">
                      {' '}
                      · {t('ob.authEnv', { n: ready.fromEnv })}
                    </span>
                  ) : null}
                </>
              ) : (
                authError ? `${t('ob.recheck')}: ${authError}` : t('ob.authMissing')
              )
            }
            action={
              <>
                <Button className="ob-btn" onClick={() => void detect()} data-testid="ob-recheck-auth">
                  {t('ob.recheck')}
                </Button>
                <Button variant="primary" className="ob-btn" onClick={() => openSettings('auth')} data-testid="ob-open-auth">
                  {t('ob.goAuth')}
                </Button>
              </>
            }
          />

          {tools ? (
            <OnboardingRow
              testId="ob-tools"
              ok={toolsOk}
              title={t('ob.toolsTitle')}
              desc={
                toolsOk
                  ? t('ob.toolsOk')
                  :
                    [tools.bash, tools.git]
                      .filter((tool) => !tool.ok && tool.reason)
                      .map((tool) => toolMissingText(tool.reason, t))
                      .join(' ')
              }
              action={
                <>
                  {!toolsOk && tools.platform === 'win32' ? <GitInstallControl /> : null}
                  <Button className="ob-btn" onClick={() => void detectTools()} data-testid="ob-recheck-tools">
                    {t('ob.recheck')}
                  </Button>
                </>
              }
            />
          ) : null}

          <OnboardingRow
            testId="ob-conn"
            ok={connOk}
            title={t('ob.connTitle')}
            desc={connOk ? t('ob.connOk') : t('ob.connMissing')}
          />

          <OnboardingRow
            testId="ob-models"
            ok={modelOk}
            title={t('ob.modelTitle')}
            desc={modelOk ? t('ob.modelOk', { n: models.length, name: session?.model?.name ?? '' }) : t('ob.modelMissing')}
            action={
              <Button className="ob-btn" onClick={() => openSettings('status')}>
                {t('ob.goStatus')}
              </Button>
            }
          />

          <div className="ob-tips">
            <div className="ob-tip">
              <Icon name="message-dots" size={12} />
              <span>{t('ob.tip1')}</span>
            </div>
            <div className="ob-tip">
              <Icon name="terminal" size={12} />
              <span>{t('ob.tip2')}</span>
            </div>
          </div>
        </div>

        <div className="ob-foot">
          <span className="ob-foot-note">{t('ob.footNote')}</span>
          <span className="spacer" />
          <Button variant="primary" className="ob-btn" onClick={onClose} data-testid="ob-done">
            {t('ob.start')}
          </Button>
        </div>
      </div>
    </div>
  )
}
