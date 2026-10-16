/**
 * pi 插件包 / 砚内置能力面板（S2，供「扩展」与「市场」共用）。
 *
 * 与 v2 `PackagesTab` 的语义一致，但重画为 v3 版面，并只复用正式 IPC：
 *   · 列表来自 `packages.list(cwd)`；安装 / 更新 / 卸载走 `packages.action`；
 *   · 「安装成功」= pi CLI 返回成功，「加载成功」= 磁盘上真能读到（`installed`）；
 *     不显示「当前会话可用」——那需要 pi 重载，不假装已发生。
 *   · 内置能力随砚分发，**没有卸载按钮**，与用户装的包分开展示。
 *
 * 不自动拉远端：本面板只读本地列表；`packages.search` 只由市场分页在用户点搜索时调用。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useT } from '../../../i18n'
import type { MessageKey } from '../../../i18n'
import { useStore } from '../../../state/store'
import type {
  BuiltinCapabilityView,
  PackageActionResultView,
  PackageEntryView,
  PackageListingView
} from '../../../../../shared/ipc'
import { Badge, Button, Checkbox, Skeleton, TextField } from '../../../ui'
import { useCapsText } from './text'
import { useConfirm } from './confirm'
import { createOperationTracker, runGuardedOperation, type OperationTracker } from './operation-state'
import { Actions, Empty, Group, Item, ItemHead, Meta, Note, Panel, Warn } from './parts'

/**
 * 内置能力 id → i18n 键。与主进程 `builtinCapabilities()` 的 id 对齐；
 * 对不上就退而成显示文件名（看得见的缺口，不是静默空白）。
 */
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

export interface PackagesPanelProps {
  /** 市场「选择」后预填的来源。 */
  initialSource?: string
  /** 变化时重新套用 `initialSource`（同一来源可再次选择）。 */
  selectionKey?: number
  showBuiltin?: boolean
  /** 面板顶部的一段说明（可放回退 / 语义提示）。 */
  note?: ReactNode
}

export function PackagesPanel({
  initialSource = '',
  selectionKey = 0,
  showBuiltin = true,
  note
}: PackagesPanelProps): ReactElement {
  const t = useT()
  const text = useCapsText()
  const confirm = useConfirm()
  const cwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd ?? '')
  const [listing, setListing] = useState<PackageListingView | null>(null)
  const [builtin, setBuiltin] = useState<BuiltinCapabilityView[]>([])
  const [builtinLoaded, setBuiltinLoaded] = useState(false)
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState<PackageActionResultView | null>(null)
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
      /* 项目 / 挂载变化：未完成操作的结果不再属于当前上下文。 */
      tracker.invalidateScope()
    }
  }, [load, tracker])

  useEffect(() => {
    void (async () => {
      try {
        const next = await window.yan.builtinCapabilities.list()
        if (mounted.current) setBuiltin(next)
      } catch {
        if (mounted.current) setBuiltin([])
      } finally {
        if (mounted.current) setBuiltinLoaded(true)
      }
    })()
  }, [])

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
      /* 按本次操作自己的 token 设置 / 清除 busy：旧操作的 finally 不会解锁新操作。 */
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
        setResult(action)
        if (action.listing) setListing(action.listing)
        else await load()
        if (action.ok && kind === 'install') setSource('')
      },
      /* 过期结果只在当前上下文提示，不冒充当前项目成功，也不静默丢弃。 */
      onStale: () => setStaleNotice(text('pkgStaleResult'))
    })
  }

  return (
    <Panel label={t('pkg.install')}>
      {note ? <Note>{note}</Note> : null}
      <Group title={t('pkg.install')} desc={t('pkg.installDesc')}>
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
            size="sm"
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
        {staleNotice ? <Warn>{staleNotice}</Warn> : null}
        {result ? (
          <div className={result.ok ? 'caps-result' : 'caps-result'} data-testid="caps-pkg-result">
            <Badge tone={result.ok ? 'run' : 'fail'}>{result.ok ? t('pkg.installBtn') : t('pkg.failed')}</Badge>
            <Meta>{result.ok ? (result.output ?? 'ok') : (result.error ?? t('pkg.failed'))}</Meta>
            {result.detail ? (
              <>
                <Button size="sm" variant="ghost" onPress={() => setShowRaw((value) => !value)} data-testid="caps-pkg-detail-toggle">
                  {showRaw ? t('pkg.hideRaw') : t('pkg.showRaw')}
                </Button>
                {showRaw ? <pre className="caps-raw">{result.detail}</pre> : null}
              </>
            ) : null}
          </div>
        ) : null}
      </Group>

      <Group title={t('pkg.installed')}>
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
      </Group>

      {showBuiltin && builtinLoaded && builtin.length > 0 ? (
        <Group title={t('pkg.builtinCount', { n: builtin.length })} desc={t('pkg.builtinDesc')}>
          <div className="caps-list" data-testid="caps-builtin-list">
            {builtin.map((cap) => {
              const label = BUILTIN_TEXT[cap.id]
              return (
                <Item key={cap.id} testId="caps-builtin">
                  <ItemHead>
                    <span className="caps-name">{label ? t(label.name) : (cap.file ?? cap.id)}</span>
                    <Badge tone="neutral">{t('pkg.builtinBadge')}</Badge>
                    {cap.file ? <span className="caps-tag">{cap.file}</span> : null}
                  </ItemHead>
                  <Meta>{label ? t(label.desc) : t('pkg.builtinNoDesc')}</Meta>
                </Item>
              )
            })}
          </div>
        </Group>
      ) : null}
    </Panel>
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
    <Item testId="caps-pkg-item">
      <ItemHead>
        <span className="caps-name" title={entry.name}>
          {entry.name}
        </span>
        {entry.version ? <span className="caps-tag">{entry.version}</span> : null}
        <Badge tone="neutral">{entry.scope === 'project' ? t('pkg.scopeProject') : t('pkg.scopeUser')}</Badge>
        {!entry.installed ? <Badge tone="fail">{t('pkg.missing')}</Badge> : null}
        <span className="caps-spacer" />
        <Actions>
          <Button size="sm" variant="ghost" onPress={onToggle} data-testid="caps-pkg-detail">
            {open ? t('pkg.hideDetail') : t('pkg.detail')}
          </Button>
          <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => onRun('update')} data-testid="caps-pkg-update">
            {t('pkg.update')}
          </Button>
          <Button size="sm" variant="danger" isDisabled={busy} onPress={() => onRun('remove')} data-testid="caps-pkg-remove">
            {t('pkg.remove')}
          </Button>
        </Actions>
      </ItemHead>
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
    </Item>
  )
}
