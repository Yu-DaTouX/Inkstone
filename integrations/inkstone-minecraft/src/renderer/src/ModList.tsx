import { useCallback, useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import { AlertCircle, ArrowUpCircle, ExternalLink, FolderOpen, PackagePlus, RefreshCw, Trash2, Undo2 } from 'lucide-react'
import { Badge } from '@yan/ui/Badge'
import { Button } from '@yan/ui/Button'
import { IconButton } from '@yan/ui/IconButton'
import { Notice } from '@yan/ui/Notice'
import { ProgressBar } from '@yan/ui/Progress'
import { SettingRow, SettingSection } from '@yan/ui/SettingRow'
import { Switch } from '@yan/ui/Switch'
import { SearchField } from '@yan/ui/TextField'
import type { FolderTarget, TaskInfo } from '../../shared/api.ts'
import type { ModEntry, ModListResult, ModUpdateCheckResult, ModUpdateInfo } from '../../shared/mods-api.ts'
import { ConfirmDialog } from './overlays.tsx'
import { EmptyBlock, PageHead } from './SubNavLayout.tsx'

type Filter = 'all' | 'enabled' | 'disabled' | 'updates' | 'issues'

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'disabled', label: '已停用' },
  { id: 'updates', label: '有更新' },
  { id: 'issues', label: '有问题' }
]

const ISSUE_TONE: Record<string, 'stall' | 'fail' | 'ask'> = {
  'missing-dependency': 'stall',
  'mc-mismatch': 'fail',
  'loader-mismatch': 'fail',
  duplicate: 'ask',
  incompatible: 'fail',
  'no-metadata': 'ask'
}

const ISSUE_LABEL: Record<string, string> = {
  'missing-dependency': '缺依赖',
  'mc-mismatch': '版本不符',
  'loader-mismatch': '加载器不符',
  duplicate: '重复',
  incompatible: '不兼容',
  'no-metadata': '无法识别'
}

export function cleanError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function ModIcon({ mod }: { mod: ModEntry }): ReactElement {
  const source = mod.icon ?? mod.remoteIconUrl
  if (source) return <img className="mod-row__icon" src={source} alt="" width={32} height={32} />
  const initial = (mod.name || mod.modId || '?').trim().slice(0, 1).toUpperCase()
  const hue = [...(mod.modId ?? mod.name)].reduce((total, char) => total + char.codePointAt(0)!, 0) % 360
  return (
    <span className="mod-row__icon mod-row__icon--generated" aria-hidden="true" style={{ '--mod-hue': `${hue}` } as CSSProperties}>
      {initial}
    </span>
  )
}

function UpdateBadge({ update }: { update: ModUpdateInfo | undefined }): ReactElement | null {
  if (!update) return null
  return (
    <Badge tone="run" title={`可更新到 ${update.versionNumber}`}>
      有更新
    </Badge>
  )
}

function IssueBadges({ mod }: { mod: ModEntry }): ReactElement {
  return (
    <>
      {mod.issues.map((issue) => (
        <Badge key={`${issue.kind}-${issue.modId ?? issue.text}`} tone={ISSUE_TONE[issue.kind] ?? 'ask'} title={issue.text}>
          {ISSUE_LABEL[issue.kind] ?? '有问题'}
        </Badge>
      ))}
    </>
  )
}

interface Props {
  folder: string
  versionId: string
  loader: string
  onOpenFolder(target: FolderTarget): Promise<void>
}

export function ModList({ folder, versionId, loader, onOpenFolder }: Props): ReactElement {
  const [data, setData] = useState<ModListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [updates, setUpdates] = useState<ModUpdateCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ModEntry | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [task, setTask] = useState<TaskInfo | null>(null)

  const load = useCallback((): void => {
    setLoading(true)
    setError('')
    void window.craft.modList(folder, versionId).then(
      (result) => {
        setData(result)
        setLoading(false)
      },
      (cause: unknown) => {
        setError(cleanError(cause))
        setLoading(false)
      }
    )
  }, [folder, versionId])

  useEffect(() => {
    setData(null)
    setUpdates(null)
    setNotice('')
    load()
  }, [load])

  useEffect(() => {
    if (!taskId) {
      setTask(null)
      return
    }
    let alive = true
    void window.craft.tasks().then((items) => {
      if (alive) setTask(items.find((item) => item.id === taskId) ?? null)
    })
    const stop = window.craft.onTask((next) => {
      if (next.id !== taskId) return
      setTask(next)
      if (next.state === 'done') {
        setNotice(next.detail ?? '已完成')
        load()
      }
      if (next.state === 'failed') setNotice(next.error ?? '操作失败')
    })
    return () => {
      alive = false
      stop()
    }
  }, [taskId, load])

  const updateBySha = useMemo(() => {
    const map = new Map<string, ModUpdateInfo>()
    for (const item of updates?.updates ?? []) map.set(item.sha1, item)
    return map
  }, [updates])

  const visible = useMemo(() => {
    const mods = data?.mods ?? []
    const needle = query.trim().toLowerCase()
    return mods
      .filter((mod) => {
        if (filter === 'enabled' && !mod.enabled) return false
        if (filter === 'disabled' && mod.enabled) return false
        if (filter === 'updates' && !updateBySha.has(mod.sha1)) return false
        if (filter === 'issues' && mod.issues.length === 0) return false
        if (!needle) return true
        return `${mod.name} ${mod.modId ?? ''} ${mod.file}`.toLowerCase().includes(needle)
      })
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, 'zh-CN'))
  }, [data, filter, query, updateBySha])

  const run = async (action: () => Promise<ModListResult>, success?: string): Promise<void> => {
    setNotice('')
    try {
      const result = await action()
      setData(result)
      if (success) setNotice(success)
    } catch (cause) {
      setNotice(cleanError(cause))
    }
  }

  const toggle = async (mod: ModEntry): Promise<void> => {
    setPending(mod.file)
    try {
      await run(() => window.craft.modToggle(folder, versionId, mod.file, !mod.enabled))
    } finally {
      setPending(null)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    const mod = deleting
    if (!mod) return
    setDeleting(null)
    await run(() => window.craft.modRemove(folder, versionId, mod.file), `${mod.name} 已移到 .trash，可恢复`)
  }

  const restore = (id: string): void => {
    void run(() => window.craft.modRestore(folder, versionId, id), '已恢复到 mods')
  }

  const addFiles = async (): Promise<void> => {
    setNotice('')
    try {
      const paths = await window.craft.pickModFiles()
      if (paths.length === 0) return
      const copied = await window.craft.modAddFiles(folder, versionId, paths)
      load()
      setNotice(copied.length > 0 ? `已添加 ${copied.length} 个文件` : '这些文件已经在 mods 里了')
    } catch (cause) {
      setNotice(cleanError(cause))
    }
  }

  const checkUpdates = async (): Promise<void> => {
    setChecking(true)
    setNotice('')
    try {
      const result = await window.craft.modCheckUpdates(folder, versionId)
      setUpdates(result)
      if (result.error) setNotice(result.error)
      else if (result.updates.length === 0)
        setNotice(result.unknown.length > 0 ? `能识别的 Mod 都是最新版本；${result.unknown.length} 个文件不在 Modrinth 上` : '所有 Mod 都是最新版本')
      else setNotice(`${result.updates.length} 个 Mod 可以更新`)
      load()
    } catch (cause) {
      setNotice(cleanError(cause))
    } finally {
      setChecking(false)
    }
  }

  const applyUpdates = async (items: ModUpdateInfo[]): Promise<void> => {
    if (items.length === 0) return
    setNotice('')
    try {
      setTaskId(await window.craft.modUpdate({ folder, versionId, updates: items }))
    } catch (cause) {
      setNotice(cleanError(cause))
    }
  }

  const onRowKey = (event: KeyboardEvent<HTMLDivElement>, mod: ModEntry): void => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      void toggle(mod)
    }
    if (event.key === 'Delete') {
      event.preventDefault()
      setDeleting(mod)
    }
  }

  const counts = data?.counts
  const trash = data?.trash ?? []

  return (
    <>
      <PageHead
        title="Mod"
        description={
          counts
            ? `共 ${counts.total} 个，启用 ${counts.enabled} 个${counts.issues > 0 ? `，${counts.issues} 个有问题` : ''}`
            : '读取 mods 文件夹里的 Mod，支持启用、停用、删除与更新检查。'
        }
        actions={
          <>
            <Button size="sm" icon={<PackagePlus size={14} />} onPress={() => void addFiles()}>
              添加文件
            </Button>
            <Button size="sm" icon={<RefreshCw size={14} />} isDisabled={checking || !counts?.total} onPress={() => void checkUpdates()}>
              {checking ? '正在检查…' : '检查更新'}
            </Button>
            <Button size="sm" variant="primary" icon={<ArrowUpCircle size={14} />} isDisabled={!updates || updates.updates.length === 0 || task?.state === 'running'} onPress={() => void applyUpdates(updates?.updates ?? [])}>
              全部更新
            </Button>
          </>
        }
      />
      {notice ? (
        <Notice tone="stall" compact>
          {notice}
        </Notice>
      ) : null}
      {task && (task.state === 'running' || task.state === 'queued') ? (
        <div className="install-progress" data-state={task.state}>
          <ProgressBar
            aria-label="Mod 任务进度"
            label={task.detail ?? task.title}
            showValue
            value={task.progress && task.progress.total > 0 ? Math.min(100, (task.progress.done / task.progress.total) * 100) : 0}
            isIndeterminate={!task.progress || task.progress.total <= 0}
            tone="run"
          />
        </div>
      ) : null}
      <div className="mod-toolbar">
        <div className="install-filter" role="group" aria-label="筛选">
          {FILTERS.map((item) => (
            <Button key={item.id} size="sm" variant={filter === item.id ? 'secondary' : 'ghost'} aria-pressed={filter === item.id} onPress={() => setFilter(item.id)}>
              {item.label}
            </Button>
          ))}
        </div>
        <div className="mod-toolbar__end">
          <SearchField aria-label="搜索 Mod" className="install-search" placeholder="搜索名称或 modid" value={query} onChange={setQuery} />
          <Button size="sm" variant="ghost" icon={<FolderOpen size={14} />} onPress={() => void onOpenFolder('mods')}>
            打开 mods 文件夹
          </Button>
        </div>
      </div>
      {loading && !data ? (
        <p className="page__muted">正在读取 Mod…</p>
      ) : error ? (
        <Notice
          tone="fail"
          compact
          action={
            <Button size="sm" onPress={load}>
              重试
            </Button>
          }
        >
          {error}
        </Notice>
      ) : (data?.mods.length ?? 0) === 0 ? (
        <EmptyBlock
          icon={<PackagePlus size={20} />}
          title="mods 里还没有 Mod"
          actions={
            <Button variant="primary" icon={<PackagePlus size={14} />} onPress={() => void addFiles()}>
              添加文件
            </Button>
          }
        >
          把 .jar 拖进 mods 文件夹，或在这里添加。也可以在下载页的 Mod 页从 Modrinth 搜索安装。
        </EmptyBlock>
      ) : visible.length === 0 ? (
        <p className="page__muted">没有符合当前筛选的 Mod。</p>
      ) : (
        <ul className="mod-list" aria-label="Mod">
          {visible.map((mod) => {
            const update = updateBySha.get(mod.sha1)
            return (
              <li key={`${mod.file}`}>
                <div
                  className="mod-row"
                  data-disabled={mod.enabled ? undefined : '1'}
                  data-issues={mod.issues.length > 0 ? '1' : undefined}
                  tabIndex={0}
                  role="group"
                  aria-label={mod.name}
                  onKeyDown={(event) => onRowKey(event, mod)}
                >
                  <ModIcon mod={mod} />
                  <span className="mod-row__main">
                    <span className="mod-row__name" title={mod.name}>
                      {mod.name}
                    </span>
                    <span className="mod-row__meta" title={`${mod.modId ?? '未知 mod id'} · ${mod.version ?? '未知版本'} · ${mod.file}`}>
                      {mod.modId ?? '未知'} · {mod.version ?? '未知版本'} · {mod.file} · {formatSize(mod.size)}
                      {mod.enabled ? '' : ' · 已停用'}
                    </span>
                  </span>
                  <span className="mod-row__badges">
                    <UpdateBadge update={update} />
                    {mod.issues.length > 0 ? <AlertCircle size={14} className="mod-row__warn" aria-hidden="true" /> : null}
                    <IssueBadges mod={mod} />
                  </span>
                  <span className="mod-row__actions">
                    {update ? (
                      <IconButton aria-label={`更新 ${mod.name}`} size="sm" onPress={() => void applyUpdates([update])}>
                        <ArrowUpCircle size={15} />
                      </IconButton>
                    ) : null}
                    {mod.projectId ? (
                      <IconButton aria-label={`在 Modrinth 打开 ${mod.name}`} size="sm" onPress={() => void window.craft.openUrl(`https://modrinth.com/project/${mod.projectId}`)}>
                        <ExternalLink size={15} />
                      </IconButton>
                    ) : null}
                    <Switch aria-label={`启用 ${mod.name}`} isSelected={mod.enabled} isDisabled={pending === mod.file} onChange={() => void toggle(mod)} />
                    <IconButton aria-label={`删除 ${mod.name}`} size="sm" onPress={() => setDeleting(mod)}>
                      <Trash2 size={15} />
                    </IconButton>
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {trash.length > 0 ? (
        <SettingSection title="回收站" description="删除的 Mod 移到这里，可以恢复。">
          {trash.map((item) => (
            <SettingRow key={item.id} label={item.name} description={`${item.file} · ${formatSize(item.size)}`}>
              <Button size="sm" variant="ghost" icon={<Undo2 size={14} />} onPress={() => restore(item.id)}>
                恢复
              </Button>
            </SettingRow>
          ))}
        </SettingSection>
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        title="删除这个 Mod？"
        confirmLabel="移到 .trash"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      >
        {deleting ? `${deleting.name}（${deleting.file}）会移到 ${loader === 'vanilla' ? '版本目录' : loader} 的 .trash 文件夹，不会永久删除，可以在回收站里恢复。` : ''}
      </ConfirmDialog>
    </>
  )
}
