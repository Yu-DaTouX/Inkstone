import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import type {
  PackageActionResultView,
  PackageEntryView,
  PackageListingView
} from '../../../../../shared/ipc'
import { Badge, Button, Checkbox, Skeleton, TextField } from '../../../ui'
import { useCapsText } from './text'
import { useConfirm } from './confirm'
import { createOperationTracker, runGuardedOperation, type OperationTracker } from './operation-state'
import { Empty, Entry, Group, Meta, Note, Warn } from './parts'

type PackageActionKind = 'install' | 'remove' | 'update'

const RESULT_LABEL = { install: 'pkg.installBtn', update: 'pkg.update', remove: 'pkg.remove' } as const

interface PackagesPanelProps {
  initialSource?: string
  selectionKey?: number
  mode: 'install' | 'installed'
  note?: ReactNode
}

export function PackagesPanel({
  initialSource = '',
  selectionKey = 0,
  mode,
  note
}: PackagesPanelProps): ReactElement {
  const t = useT()
  const text = useCapsText()
  const confirm = useConfirm()
  const cwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd ?? '')
  const [listing, setListing] = useState<PackageListingView | null>(null)
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState<PackageActionResultView | null>(null)
  const [resultKind, setResultKind] = useState<PackageActionKind>('install')
  const [staleNotice, setStaleNotice] = useState<string | null>(null)
  const [source, setSource] = useState(initialSource)
  const [local, setLocal] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [openDetail, setOpenDetail] = useState('')
  const mounted = useRef(true)
  const generation = useRef(0)
  const tracker = useRef<OperationTracker>(createOperationTracker()).current

  useEffect(() => {
    if (initialSource) setSource(initialSource)
  }, [initialSource, selectionKey])

  const load = useCallback(async (): Promise<void> => {
    const current = ++generation.current
    try {
      const next = await window.yan.packages.list(cwd)
      if (mounted.current && current === generation.current) setListing(next)
    } catch (cause) {
      if (!mounted.current || current !== generation.current) return
      setListing({
        ok: false,
        agentDir: '',
        userSettings: '',
        projectSettings: '',
        entries: [],
        error: cause instanceof Error ? cause.message : String(cause)
      })
    }
  }, [cwd])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      generation.current++
      tracker.invalidateScope()
    }
  }, [load, tracker])

  const run = async (kind: 'install' | 'remove' | 'update', src: string, targetLocal: boolean): Promise<void> => {
    if (kind === 'install') {
      const accepted = await confirm({
        title: t('pkg.install'),
        body: t('pkg.warn'),
        detail: src,
        confirmLabel: t('pkg.installBtn'),
        tone: 'danger'
      })
      if (!accepted) return
    }
    if (kind === 'remove') {
      const accepted = await confirm({
        title: t('pkg.remove'),
        body: t('pkg.remove'),
        detail: src,
        confirmLabel: t('pkg.remove'),
        tone: 'danger'
      })
      if (!accepted) return
    }
    setShowRaw(false)
    setStaleNotice(null)
    await runGuardedOperation<PackageActionResultView>({
      tracker,
      isMounted: () => mounted.current,
      setBusy: (value) =>
        setBusy(value ? `${kind}:${targetLocal ? 'project' : 'user'}:${src}` : ''),
      action: async () => {
        try {
          return await window.yan.packages.action({ kind, source: src, local: targetLocal, cwd })
        } catch (cause) {
          return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
        }
      },
      onResult: async (action) => {
        setResultKind(kind)
        setResult(action)
        if (action.listing) setListing(action.listing)
        else await load()
        if (action.ok && kind === 'install') setSource('')
      },
      onStale: () => setStaleNotice(text('pkgStaleResult'))
    })
  }

  const resultBlock = (
    <>
      {staleNotice ? <Warn>{staleNotice}</Warn> : null}
      {result ? (
        <div className="caps-result" data-testid="caps-pkg-result">
          <Badge tone={result.ok ? 'run' : 'fail'}>{result.ok ? t(RESULT_LABEL[resultKind]) : t('pkg.failed')}</Badge>
          <Meta>{result.ok ? (result.output ?? 'ok') : (result.error ?? t('pkg.failed'))}</Meta>
          {result.detail ? (
            <>
              <Button variant="ghost" onPress={() => setShowRaw((value) => !value)} data-testid="caps-pkg-detail-toggle">
                {showRaw ? t('pkg.hideRaw') : t('pkg.showRaw')}
              </Button>
              {showRaw ? <pre className="caps-raw">{result.detail}</pre> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </>
  )

  if (mode === 'install') {
    return (
      <Group title={t('pkg.install')} desc={t('pkg.installDesc')} settingId="caps-market-install">
        {note ? <Note>{note}</Note> : null}
        <div className="caps-field">
          <TextField
            aria-label={t('pkg.install')}
            className="caps-field-input"
            value={source}
            onChange={setSource}
            placeholder="npm:pi-zh-cn"
            data-testid="caps-pkg-source"
          />
          <Checkbox isSelected={local} onChange={setLocal} data-testid="caps-pkg-local">
            {t('pkg.local')}
          </Checkbox>
          <Button
            variant="primary"
            isDisabled={!!busy || !source.trim()}
            onPress={() => void run('install', source.trim(), local)}
            data-testid="caps-pkg-install-btn"
          >
            {busy.startsWith('install') ? t('pkg.working') : t('pkg.installBtn')}
          </Button>
        </div>
        <Meta title={t('pkg.location', { dir: listing?.agentDir ?? '—' })}>
          {t('pkg.location', { dir: listing?.agentDir ?? '—' })}
        </Meta>
        {resultBlock}
      </Group>
    )
  }

  return (
    <Group title={t('pkg.installed')} desc={t('pkg.location', { dir: listing?.agentDir ?? '—' })} settingId="caps-extensions">
      {note ? <Note>{note}</Note> : null}
      {!listing ? (
        <div className="caps-list" aria-hidden="true">
          <div className="caps-item caps-item--skeleton">
            <Skeleton className="caps-skel caps-skel--title" />
          </div>
        </div>
      ) : listing.entries.length === 0 ? (
        <Empty>{listing.ok === false ? (listing.error ?? t('pkg.listFailed')) : t('pkg.empty')}</Empty>
      ) : (
        <div className="caps-list" data-testid="caps-pkg-list">
          {listing.entries.map((entry) => (
            <PackageItem
              key={`${entry.scope}:${entry.source}`}
              entry={entry}
              busy={!!busy}
              open={openDetail === `${entry.scope}:${entry.source}`}
              onToggle={() =>
                setOpenDetail((value) => (value === `${entry.scope}:${entry.source}` ? '' : `${entry.scope}:${entry.source}`))
              }
              onRun={(kind) => void run(kind, entry.source, entry.scope === 'project')}
            />
          ))}
        </div>
      )}
      {resultBlock}
    </Group>
  )
}

function PackageItem({
  entry,
  busy,
  open,
  onToggle,
  onRun
}: {
  entry: PackageEntryView
  busy: boolean
  open: boolean
  onToggle: () => void
  onRun: (kind: 'update' | 'remove') => void
}): ReactElement {
  const t = useT()
  const text = useCapsText()
  return (
    <Entry
      testId="caps-pkg-item"
      name={entry.name}
      nameTitle={entry.name}
      meta={[
        entry.scope === 'project' ? t('pkg.scopeProject') : t('pkg.scopeUser'),
        entry.version,
        entry.installed ? null : t('pkg.missing')
      ]}
      actions={
        <>
          <Button variant="ghost" onPress={onToggle} data-testid="caps-pkg-detail">
            {open ? t('pkg.hideDetail') : t('pkg.detail')}
          </Button>
          <Button variant="secondary" isDisabled={busy} onPress={() => onRun('update')} data-testid="caps-pkg-update">
            {t('pkg.update')}
          </Button>
          <Button variant="danger" isDisabled={busy} onPress={() => onRun('remove')} data-testid="caps-pkg-remove">
            {t('pkg.remove')}
          </Button>
        </>
      }
    >
      {open ? (
        <div className="caps-detail" data-testid="caps-pkg-detail-body">
          <Meta>{entry.description ?? t('pkg.noDesc')}</Meta>
          <Meta>{t('pkg.sourceLine', { src: entry.source })}</Meta>
          {entry.repository ? <Meta>{t('pkg.repoLine', { url: entry.repository })}</Meta> : null}
          {entry.license ? <Meta>{t('pkg.licenseLine', { license: entry.license })}</Meta> : null}
          <Warn>{t('pkg.warn')}</Warn>
          <Meta>{text('installedNotLoaded')}</Meta>
        </div>
      ) : null}
    </Entry>
  )
}
