import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { modelErrorText } from '../../../../shared/model-errors'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import type {
  AttachmentUsage,
  BuiltinCapabilityView,
  PackageActionResultView,
  PackageListingView
} from '../../../../shared/ipc'
import { Button, Disclosure, SettingRow } from '../ui'
import { useConfirm } from '../ui/confirm'
import { isCurrentGeneration } from './review2-settings-guards'

const BUILTIN_TEXT: Record<string, { name: MessageKey; desc: MessageKey }> = {
  'task-plan': { name: 'pkg.builtin.task-plan', desc: 'pkg.builtin.task-planDesc' },
  browser: { name: 'pkg.builtin.browser', desc: 'pkg.builtin.browserDesc' },
  question: { name: 'pkg.builtin.question', desc: 'pkg.builtin.questionDesc' },
  'response-detail': { name: 'pkg.builtin.response-detail', desc: 'pkg.builtin.response-detailDesc' },
  language: { name: 'pkg.builtin.language', desc: 'pkg.builtin.languageDesc' },
  preamble: { name: 'pkg.builtin.preamble', desc: 'pkg.builtin.preambleDesc' },
  'capability-guide': { name: 'pkg.builtin.capability-guide', desc: 'pkg.builtin.capability-guideDesc' },
  'codemode-policy': { name: 'pkg.builtin.codemode-policy', desc: 'pkg.builtin.codemode-policyDesc' },
  commandcode: { name: 'pkg.builtin.commandcode', desc: 'pkg.builtin.commandcodeDesc' },
  context: { name: 'pkg.builtin.context', desc: 'pkg.builtin.contextDesc' },
  'context-inspect': { name: 'pkg.builtin.context-inspect', desc: 'pkg.builtin.context-inspectDesc' },
  'context-trim': { name: 'pkg.builtin.context', desc: 'pkg.builtin.contextDesc' },
  'danger-guard': { name: 'pkg.builtin.danger-guard', desc: 'pkg.builtin.danger-guardDesc' },
  'shell-fallback': { name: 'pkg.builtin.shell-fallback', desc: 'pkg.builtin.shell-fallbackDesc' }
}

export function PackagesTab({ selectedSource = '', selectionKey = 0, showBuiltin = true }: { selectedSource?: string; selectionKey?: number; showBuiltin?: boolean }): React.JSX.Element {
  const t = useT()
  const confirm = useConfirm()
  const cwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd ?? '')
  const [listing, setListing] = useState<PackageListingView | null>(null)
  const [builtin, setBuiltin] = useState<BuiltinCapabilityView[]>([])
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState<PackageActionResultView | null>(null)
  const [source, setSource] = useState('')
  const [local, setLocal] = useState(false)
  useEffect(() => { if (selectedSource) setSource(selectedSource) }, [selectedSource, selectionKey])

  const [attach, setAttach] = useState<AttachmentUsage | null>(null)
  const [attachBusy, setAttachBusy] = useState(false)
  const [attachNote, setAttachNote] = useState('')
  const loadGeneration = useRef(0)
  const mounted = useRef(true)
  const attachGeneration = useRef(0)

  useEffect(() => {
    mounted.current = true
    const generation = ++attachGeneration.current
    void window.yan.attachments.usage().then((usage) => {
      if (isCurrentGeneration(attachGeneration.current, generation)) { setAttach(usage); setAttachNote('') }
    }).catch((error) => {
      if (generation === attachGeneration.current) setAttachNote(`${t('pkg.failed')}: ${modelErrorText(error)}`)
    })
    return () => { mounted.current = false; attachGeneration.current++; loadGeneration.current++ }
  }, [t])

  const cleanAttachments = async (): Promise<void> => {
    if (!attach) return
    const size = t('pkg.attachSize', { files: attach.files, size: fmtSize(attach.bytes) })
    if (!(await confirm({ title: t('pkg.attachClean'), body: `${t('pkg.attachDesc')}\n${t('pkg.attachCleanNote')}`, detail: size, confirmLabel: t('pkg.attachClean'), tone: 'danger' }))) return
    setAttachBusy(true)
    setAttachNote(t('pkg.attachScanning'))
    try {
      const res = await window.yan.attachments.prune()
      setAttach(await window.yan.attachments.usage())
      setAttachNote(
        res.removed
          ? t('pkg.attachDone', { n: res.removed, size: fmtSize(res.bytes) })
          : t('pkg.attachNone')
      )
    } catch (error) {
      const reason = modelErrorText(error).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
      setAttachNote(`${t('pkg.failed')}: ${reason} ${t('pkg.attachRetry')}`)
    } finally {
      setAttachBusy(false)
    }
  }
  const [openDetail, setOpenDetail] = useState('')
  const [showRaw, setShowRaw] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current
    try {
      const next = await window.yan.packages.list(cwd)
      if (isCurrentGeneration(loadGeneration.current, generation)) setListing(next)
    } catch (e) {
      if (!isCurrentGeneration(loadGeneration.current, generation)) return
      setListing({
        ok: false,
        agentDir: '',
        userSettings: '',
        projectSettings: '',
        entries: [],
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }, [cwd])

  useEffect(() => {
    void load()
    return () => { loadGeneration.current++ }
  }, [load])

  useEffect(() => {
    void (async () => {
      try {
        setBuiltin(await window.yan.builtinCapabilities.list())
      } catch {
        setBuiltin([])
      }
    })()
  }, [])

  const run = async (kind: 'install' | 'remove' | 'update', src: string, targetLocal: boolean): Promise<void> => {
    const generation = loadGeneration.current
    setBusy(`${kind}:${targetLocal ? 'project' : 'user'}:${src}`)
    setShowRaw(false)
    let res: PackageActionResultView
    try { res = await window.yan.packages.action({ kind, source: src, local: targetLocal, cwd }) }
    catch (error) { res = { ok: false, error: error instanceof Error ? error.message : String(error) } }
    if (!mounted.current) return
    if (generation !== loadGeneration.current) { setBusy(''); return }
    setResult(res)
    setBusy('')
    if (res.listing) setListing(res.listing)
    else await load()
    if (res.ok && kind === 'install' && mounted.current) setSource('')
  }

  return (
    <div className="ui-rows" data-testid="set-packages">
      <SettingRow col data-testid="pkg-install" name={t('pkg.install')} desc={t('pkg.installDesc')}>
        <div className="pkg-install-row">
          <input
            className="ui-input"
            data-testid="pkg-source"
            placeholder="npm:pi-zh-cn"
            value={source}
            spellCheck={false}
            onChange={(e) => setSource(e.target.value)}
          />
          <label className="pkg-local" title={t('pkg.localHint')}>
            <input
              type="checkbox"
              checked={local}
              data-testid="pkg-local"
              onChange={(e) => setLocal(e.target.checked)}
            />
            <span>{t('pkg.local')}</span>
          </label>
          <Button size="sm" type="button" data-testid="pkg-install-btn" disabled={!!busy || !source.trim()} onClick={() => void run('install', source.trim(), local)}>
            {busy.startsWith('install') ? t('pkg.working') : t('pkg.installBtn')}
          </Button>
          <Button size="sm" variant="ghost" type="button" data-testid="set-pi-catalog-open" title={t('pkg.catalogDesc')} onClick={() => void window.yan.browser.open('https://pi.dev/packages')}>
            {t('pkg.catalog')}
          </Button>
        </div>
      </SettingRow>

      {result ? (
        <div className={result.ok ? 'pkg-ok' : 'pkg-fail'} data-testid="pkg-result">
          <div className="pkg-result-line">
            <Icon name={result.ok ? 'check-circle' : 'alert-circle'} size={12} />
            <span>{result.ok ? (result.output ?? 'ok') : (result.error ?? t('pkg.failed'))}</span>
          </div>
          {result.detail ? (
            <>
              <button
                type="button"
                className="gwrite-fail-toggle"
                data-testid="pkg-detail-toggle"
                onClick={() => setShowRaw((v) => !v)}
              >
                <Icon name="chevron-right" size={12} className={showRaw ? 'open' : ''} />
                <span>{showRaw ? t('pkg.hideRaw') : t('pkg.showRaw')}</span>
              </button>
              {showRaw ? <pre className="gwrite-fail-raw">{result.detail}</pre> : null}
            </>
          ) : null}
        </div>
      ) : null}

      <div className="ui-row col" data-testid="pkg-list">
        <div className="ui-row-label">
          <div className="ui-row-name" title={t('pkg.location', { dir: listing?.agentDir ?? '—' })}>{t('pkg.installed')}</div>
        </div>
        {!listing || listing.entries.length === 0 ? (
          <div className="ui-row-desc" data-testid="pkg-empty">
            {listing?.ok === false ? (listing.error ?? t('pkg.listFailed')) : t('pkg.empty')}
          </div>
        ) : (
          <div className="pkg-list">
            {listing.entries.map((e) => (
              <div className="pkg-item" key={`${e.scope}:${e.source}`} data-testid="pkg-item">
                <div className="pkg-item-main">
                  <span className="pkg-name" data-testid="pkg-name" title={e.name}>
                    {e.name}
                  </span>
                  {e.version ? <span className="pkg-ver">{e.version}</span> : null}
                  <span className={`pkg-scope ${e.scope}`}>{e.scope === 'project' ? t('pkg.scopeProject') : t('pkg.scopeUser')}</span>
                  {!e.installed ? <span className="pkg-missing">{t('pkg.missing')}</span> : null}
                  <span className="pkg-spacer" />
                  <button
                    type="button"
                    className="env-mini"
                    data-testid="pkg-detail"
                    onClick={() => setOpenDetail(openDetail === `${e.scope}:${e.source}` ? '' : `${e.scope}:${e.source}`)}
                  >
                    {openDetail === `${e.scope}:${e.source}` ? t('pkg.hideDetail') : t('pkg.detail')}
                  </button>
                  <button
                    type="button"
                    className="env-mini"
                    data-testid="pkg-update"
                    disabled={!!busy}
                    onClick={() => void run('update', e.source, e.scope === 'project')}
                  >
                    {t('pkg.update')}
                  </button>
                  <button
                    type="button"
                    className="env-mini"
                    data-testid="pkg-remove"
                    disabled={!!busy}
                    onClick={() => void run('remove', e.source, e.scope === 'project')}
                  >
                    {t('pkg.remove')}
                  </button>
                </div>

                {openDetail === `${e.scope}:${e.source}` ? (
                  <div className="pkg-detail" data-testid="pkg-detail-body">
                    <div className="pkg-detail-line">{e.description ?? t('pkg.noDesc')}</div>
                    <div className="pkg-detail-line pkg-dim">{t('pkg.sourceLine', { src: e.source })}</div>
                    {e.repository ? <div className="pkg-detail-line pkg-dim">{t('pkg.repoLine', { url: e.repository })}</div> : null}
                    {e.license ? <div className="pkg-detail-line pkg-dim">{t('pkg.licenseLine', { license: e.license })}</div> : null}
                    <div className="pkg-detail-warn" data-testid="pkg-warn">
                      {t('pkg.warn')}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {showBuiltin && builtin.length > 0 ? (
        <Disclosure title={t('pkg.builtinCount', { n: builtin.length })} testId="set-builtin-caps">
          <div className="ui-row-desc">{t('pkg.builtinDesc')}</div>
          <div className="pkg-list">
            {builtin.map((cap) => {
              const text = BUILTIN_TEXT[cap.id]
              return (
                <div className="pkg-item" key={cap.id} data-testid="builtin-cap" data-cap-id={cap.id}>
                  <div className="pkg-item-main">
                    <span className="pkg-name" data-testid="builtin-cap-name">
                      {text ? t(text.name) : (cap.file ?? cap.id)}
                    </span>
                    <span className="pkg-scope user">{t('pkg.builtinBadge')}</span>
                    {cap.file ? <span className="pkg-ver">{cap.file}</span> : null}
                  </div>
                  <div className="pkg-detail-line pkg-dim">
                    {text ? t(text.desc) : t('pkg.builtinNoDesc')}
                  </div>
                </div>
              )
            })}
          </div>
        </Disclosure>
      ) : null}

      <SettingRow
        data-testid="set-attachments"
        name={t('pkg.attach')}
        desc={
          <>
            <span data-testid="set-attach-size">{attach ? t('pkg.attachSize', { files: attach.files, size: fmtSize(attach.bytes) }) : '—'}</span>
            {attachNote ? <span className="set-line" data-testid="set-attach-note">{attachNote}</span> : null}
          </>
        }
      >
        <Button size="sm" type="button" title={t('pkg.attachDesc')} data-testid="set-attach-clean" disabled={attachBusy || !attach || attach.files === 0} onClick={() => void cleanAttachments()}>
          {attachBusy ? t('pkg.working') : t('pkg.attachClean')}
        </Button>
      </SettingRow>
    </div>
  )
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
