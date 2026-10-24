import { useCallback, useEffect, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import { Archive, Camera, Copy, Download, FileText, FolderOpen, Image, LayoutDashboard, Package, Puzzle, RefreshCw, RotateCcw, SlidersHorizontal, Sparkles, SquarePen, Trash2, Wrench } from 'lucide-react'
import { Badge } from '@yan/ui/Badge'
import { Button } from '@yan/ui/Button'
import { IconButton } from '@yan/ui/IconButton'
import { ListBoxItem } from '@yan/ui/ListBox'
import { Notice } from '@yan/ui/Notice'
import { ProgressBar } from '@yan/ui/Progress'
import { Select } from '@yan/ui/Select'
import { SettingRow, SettingSection } from '@yan/ui/SettingRow'
import { Skeleton } from '@yan/ui/Skeleton'
import { Switch } from '@yan/ui/Switch'
import { TextField } from '@yan/ui/TextField'
import type { FolderTarget, InstanceInfo, JavaEntry, LauncherSettings, TaskInfo } from '../../shared/api.ts'
import type { CrashDiagnosis, CrashRecordSummary } from '../../shared/crash-api.ts'
import type { InstanceOverride, InstanceOverview } from '../../shared/mods-api.ts'
import type { InstanceIconOption, InstanceTrashRecord, ResourcePackEntry, SaveEntry, ScreenshotEntry, ServerEntry, ShaderPackEntry, VersionResources } from '../../shared/version-api.ts'
import { forgetInstanceIcons, InstanceIcon } from './InstanceIcon.tsx'
import { LOADER_LABEL, memoryLabel } from './labels.ts'
import { cleanError, formatSize, ModList } from './ModList.tsx'
import { ConfirmDialog, Sheet } from './overlays.tsx'
import { EmptyBlock, PageHead, SubNavLayout, type SubNavGroup } from './SubNavLayout.tsx'

type Section = 'overview' | 'settings' | 'repair' | 'mods' | 'resourcepacks' | 'shaderpacks' | 'saves' | 'screenshots' | 'records'

const GROUPS: SubNavGroup<Section>[] = [
  {
    label: '游戏',
    items: [
      { id: 'overview', label: '概览', icon: <LayoutDashboard size={16} /> },
      { id: 'settings', label: '设置', icon: <SlidersHorizontal size={16} /> },
      { id: 'repair', label: '修复', icon: <Wrench size={16} /> }
    ]
  },
  {
    label: '资源',
    items: [
      { id: 'mods', label: 'Mod', icon: <Puzzle size={16} /> },
      { id: 'resourcepacks', label: '资源包', icon: <Package size={16} /> },
      { id: 'shaderpacks', label: '光影', icon: <Sparkles size={16} /> },
      { id: 'saves', label: '存档', icon: <Archive size={16} /> },
      { id: 'screenshots', label: '截图', icon: <Camera size={16} /> }
    ]
  },
  {
    label: '记录',
    items: [{ id: 'records', label: '日志与崩溃', icon: <FileText size={16} /> }]
  }
]

interface Props {
  folder: string
  versionId: string
  settings: LauncherSettings
  onBack(): void
  onOpenLogs(): void
  onRenamed(id: string): void
}

function repairPercent(task: TaskInfo | null): number | null {
  if (!task?.progress || task.progress.total <= 0) return null
  return Math.min(100, (task.progress.done / task.progress.total) * 100)
}

function timeLabel(value: number | null): string {
  if (!value) return '还没玩过'
  const date = new Date(value)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function RowsSkeleton({ label }: { label: string }): ReactElement {
  return (
    <div className="l4-rows" aria-busy="true" aria-label={label}>
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} shape="rect" height={44} />
      ))}
    </div>
  )
}

function useVersionResources(folder: string, versionId: string, enabled: boolean): {
  data: VersionResources | null
  loading: boolean
  error: string
  reload(): void
  replace(next: VersionResources): void
} {
  const [data, setData] = useState<VersionResources | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const reload = useCallback((): void => {
    setLoading(true)
    setError('')
    void window.craft.versionResources(folder, versionId).then(
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
    if (!enabled) return
    setData(null)
    reload()
  }, [enabled, reload])

  return { data, loading, error, reload, replace: setData }
}

function RepairPane({ folder, versionId }: { folder: string; versionId: string }): ReactElement {
  const [taskId, setTaskId] = useState<string | null>(null)
  const [task, setTask] = useState<TaskInfo | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setTaskId(null)
    setTask(null)
    setError('')
  }, [folder, versionId])

  useEffect(() => {
    if (!taskId) return
    let alive = true
    void window.craft.tasks().then((items) => {
      if (alive) setTask(items.find((item) => item.id === taskId) ?? null)
    })
    const stop = window.craft.onTask((next) => {
      if (next.id === taskId) setTask(next)
    })
    return () => {
      alive = false
      stop()
    }
  }, [taskId])

  const start = async (): Promise<void> => {
    setError('')
    setTask(null)
    setTaskId(null)
    try {
      setTaskId(await window.craft.repair(folder, versionId))
    } catch (cause) {
      setError(cleanError(cause))
    }
  }

  const progress = repairPercent(task)

  return (
    <>
      <PageHead title="修复" description="逐个核对这个版本的文件，只补缺失或校验失败的部分。" />
      {error ? (
        <Notice tone="fail" compact>
          {error}
        </Notice>
      ) : null}
      {task ? (
        <div className="install-progress" data-state={task.state}>
          {task.state === 'running' ? <ProgressBar aria-label="修复进度" label={task.detail ?? '正在检查并修复'} showValue value={progress ?? 0} isIndeterminate={progress === null} tone="run" /> : null}
          {task.state === 'done' ? <Notice tone="ok" compact>{task.detail ?? '文件完整'}</Notice> : null}
          {task.state === 'cancelled' ? (
            <Notice tone="stall" compact>
              修复已取消
            </Notice>
          ) : null}
          {task.state === 'failed' ? <Notice tone="fail" compact>{task.error ?? '修复失败'}</Notice> : null}
        </div>
      ) : null}
      <EmptyBlock
        icon={<Wrench size={20} />}
        title="检查并修复"
        actions={
          <Button variant="primary" icon={<Wrench size={14} />} isDisabled={task?.state === 'running'} onPress={() => void start()}>
            {task?.state === 'running' ? '正在修复…' : '检查并修复'}
          </Button>
        }
      >
        会核对客户端 jar、库、素材与加载器文件，缺失的重新下载。游戏正在运行时先停止再修复。
      </EmptyBlock>
    </>
  )
}

interface OverridePaneProps {
  folder: string
  versionId: string
  overview: InstanceOverview
  javas: JavaEntry[]
  onSaved(next: InstanceOverride): void
}

function serverHint(minecraftVersion: string | null): string {
  const match = /^(\d+)\.(\d+)/.exec(minecraftVersion ?? '')
  const major = match ? Number(match[1]) : 0
  const minor = match ? Number(match[2]) : 0
  const quickPlay = major > 1 || (major === 1 && minor >= 20)
  return quickPlay ? '启动时加 --quickPlayMultiplayer 直接进服务器（1.20 及以上）' : '启动时加 --server 与 --port 直接进服务器'
}

function OverridePane({ folder, versionId, overview, javas, onSaved }: OverridePaneProps): ReactElement {
  const [draft, setDraft] = useState<InstanceOverride>(overview.override)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [servers, setServers] = useState<ServerEntry[]>([])

  useEffect(() => setDraft(overview.override), [overview.override])

  useEffect(() => {
    let alive = true
    void window.craft.versionResources(folder, versionId).then(
      (result) => alive && setServers(result.servers),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [folder, versionId])

  const patch = (next: Partial<InstanceOverride>): void => setDraft((current) => ({ ...current, ...next }))

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const saved = await window.craft.updateInstanceSettings(folder, versionId, draft)
      setDraft(saved)
      onSaved(saved)
    } catch (cause) {
      setError(cleanError(cause))
    } finally {
      setSaving(false)
    }
  }

  const javaValue = draft.javaPath ?? 'follow'
  const effective = overview.effective
  const serverValue = draft.server && servers.some((item) => item.ip === draft.server) ? draft.server : 'custom'

  return (
    <>
      <PageHead
        title="版本设置"
        description="这里的设置只对这个版本生效；关掉「跟随全局」才覆盖全局值。"
        actions={
          <Button variant="primary" size="sm" isDisabled={saving} onPress={() => void save()}>
            {saving ? '正在保存…' : '保存'}
          </Button>
        }
      />
      {error ? (
        <Notice tone="fail" compact>
          {error}
        </Notice>
      ) : null}
      <SettingSection title="Java" description={`当前生效：${effective.javaPath ?? '自动挑选'}${overview.source.java === 'pcl' ? '（来自 PCL 设置）' : overview.source.java === 'global' ? '（跟随全局）' : ''}`}>
        <SettingRow label="指定 Java" description={draft.javaPath ? undefined : `自动：按版本要求挑 ${overview.javaMajor ? `Java ${overview.javaMajor}` : '合适的 Java'}`}>
          <Select
            aria-label="指定 Java"
            selectedKey={javaValue}
            onSelectionChange={(key) => patch({ javaPath: key === 'follow' || key == null ? null : String(key) })}
          >
            {[{ path: 'follow', label: '跟随全局（自动挑选）' }, ...javas.map((java) => ({ path: java.path, label: `Java ${java.majorVersion} · ${java.path}` }))].map((item) => (
              <ListBoxItem key={item.path} id={item.path} textValue={item.label}>
                {item.label}
              </ListBoxItem>
            ))}
          </Select>
        </SettingRow>
        <SettingRow label="最大内存" description={`跟随全局时用 ${memoryLabel(overview.effective.maxMemoryMb)}`}>
          <TextField
            aria-label="最大内存（MB）"
            size="sm"
            inputMode="numeric"
            value={draft.maxMemoryMb === null ? '' : String(draft.maxMemoryMb)}
            placeholder={String(overview.effective.maxMemoryMb)}
            onChange={(value) => {
              const parsed = Number(value.replace(/[^0-9]/g, ''))
              patch({ maxMemoryMb: value.trim() && Number.isFinite(parsed) && parsed >= 512 ? Math.round(parsed) : null })
            }}
          />
        </SettingRow>
        <SettingRow label="JVM 参数" description="留空跟随全局。">
          <TextField aria-label="JVM 参数" size="sm" value={draft.jvmArgs ?? ''} placeholder="例如 -XX:+UseG1GC" onChange={(value) => patch({ jvmArgs: value.trim() ? value : null })} />
        </SettingRow>
        <SettingRow label="游戏参数" description="留空跟随全局。">
          <TextField aria-label="游戏参数" size="sm" value={draft.gameArgs ?? ''} placeholder="例如 --width 1280" onChange={(value) => patch({ gameArgs: value.trim() ? value : null })} />
        </SettingRow>
      </SettingSection>
      <SettingSection title="窗口">
        <SettingRow label="窗口大小" description={overview.source.window === 'instance' ? '使用这个版本自己的窗口大小' : '跟随全局（由游戏自己决定）'}>
          <span className="override-pair">
            <TextField
              aria-label="窗口宽"
              size="sm"
              inputMode="numeric"
              value={draft.windowWidth === null ? '' : String(draft.windowWidth)}
              placeholder="宽"
              onChange={(value) => {
                const parsed = Number(value.replace(/[^0-9]/g, ''))
                patch({ windowWidth: value.trim() && parsed >= 320 ? Math.round(parsed) : null })
              }}
            />
            <TextField
              aria-label="窗口高"
              size="sm"
              inputMode="numeric"
              value={draft.windowHeight === null ? '' : String(draft.windowHeight)}
              placeholder="高"
              onChange={(value) => {
                const parsed = Number(value.replace(/[^0-9]/g, ''))
                patch({ windowHeight: value.trim() && parsed >= 320 ? Math.round(parsed) : null })
              }}
            />
          </span>
        </SettingRow>
        <SettingRow label="全屏启动" description={draft.fullscreen === null ? '跟随全局' : draft.fullscreen ? '全屏' : '窗口'}>
          <Switch isSelected={draft.fullscreen === true} onChange={(next) => patch({ fullscreen: next })}>
            全屏
          </Switch>
        </SettingRow>
      </SettingSection>
      <SettingSection title="启动后自动进入的服务器" description={serverHint(overview.minecraftVersion)}>
        <SettingRow label="服务器地址" description="留空则不自动进入。服务器列表来自这个版本的 servers.dat。">
          <TextField aria-label="服务器地址" size="sm" value={draft.server ?? ''} placeholder="例如 play.example.com" onChange={(value) => patch({ server: value.trim() ? value.trim() : null })} />
        </SettingRow>
        {servers.length > 0 ? (
          <SettingRow label="从服务器列表选" description={`servers.dat 里有 ${servers.length} 个服务器`}>
            <Select
              aria-label="从服务器列表选"
              selectedKey={serverValue}
              onSelectionChange={(key) => {
                if (key == null || key === 'custom') return
                patch({ server: String(key) })
              }}
            >
              {[{ ip: 'custom', name: '手动填写' }, ...servers].map((server) => (
                <ListBoxItem key={server.ip} id={server.ip} textValue={`${server.name} ${server.ip}`}>
                  {`${server.name} · ${server.ip}`}
                </ListBoxItem>
              ))}
            </Select>
          </SettingRow>
        ) : null}
        <SettingRow label="自动进入" description={draft.autoEnter === false ? '启动后停在标题界面' : '启动后直接连接这个服务器'}>
          <Switch aria-label="自动进入服务器" isSelected={draft.autoEnter !== false} onChange={(next) => patch({ autoEnter: next })}>
            自动进入
          </Switch>
        </SettingRow>
        <SettingRow label="当前生效" description={effective.server ?? '没有设置服务器'}>
          <Badge tone={effective.server && draft.autoEnter !== false ? 'accent' : 'neutral'}>{effective.server ? (draft.autoEnter !== false ? '会进服' : '不进服') : '不自动进入'}</Badge>
        </SettingRow>
      </SettingSection>
      <SettingSection title="隔离">
        <SettingRow label="版本隔离" description={overview.isolated ? '存档、mods、配置都在版本目录里' : '与游戏目录共用存档和配置'}>
          <Badge tone={overview.isolated ? 'accent' : 'neutral'}>{overview.isolated ? '已隔离' : '共用'}</Badge>
        </SettingRow>
        <SettingRow label="目录" description={overview.gameDir} />
      </SettingSection>
    </>
  )
}

interface OverviewPaneProps {
  overview: InstanceOverview
  trash: InstanceTrashRecord[]
  onOpen(target: FolderTarget): Promise<void>
  onGo(section: Section): void
  onRename(): void
  onCopy(): void
  onDelete(): void
  onIcon(): void
  onRestore(id: string): void
}

function problemAction(kind: InstanceOverview['problems'][number]['kind']): { label: string; section: Section } {
  if (kind === 'files' || kind === 'json') return { label: '去修复', section: 'repair' }
  if (kind === 'deps') return { label: '看 Mod', section: 'mods' }
  return { label: '去设置', section: 'settings' }
}

function OverviewPane({ overview, trash, onOpen, onGo, onRename, onCopy, onDelete, onIcon, onRestore }: OverviewPaneProps): ReactElement {
  return (
    <>
      <PageHead
        title={overview.versionId}
        description={`${LOADER_LABEL[overview.loader as InstanceInfo['loader']] ?? overview.loader}${overview.loaderVersion ? ` ${overview.loaderVersion}` : ''} · MC ${overview.minecraftVersion ?? '?'}`}
        actions={
          <>
            <Button size="sm" icon={<FolderOpen size={14} />} onPress={() => void onOpen('version')}>
              版本文件夹
            </Button>
            <Button size="sm" icon={<FolderOpen size={14} />} onPress={() => void onOpen('game')}>
              游戏文件夹
            </Button>
          </>
        }
      />
      {overview.problems.length > 0 ? (
        <div className="overview-problems">
          {overview.problems.map((problem) => {
            const action = problemAction(problem.kind)
            return (
              <Notice
                key={`${problem.kind}-${problem.text}`}
                tone={problem.kind === 'files' || problem.kind === 'json' ? 'fail' : 'stall'}
                compact
                action={
                  <Button size="sm" onPress={() => onGo(action.section)}>
                    {action.label}
                  </Button>
                }
              >
                {problem.text}
              </Notice>
            )
          })}
        </div>
      ) : (
        <Notice tone="ok" compact>
          没有发现需要处理的问题。
        </Notice>
      )}
      <SettingSection title="版本信息">
        <SettingRow label="Minecraft">{overview.minecraftVersion ?? '未知'}</SettingRow>
        <SettingRow label="加载器">
          {LOADER_LABEL[overview.loader as InstanceInfo['loader']] ?? overview.loader}
          {overview.loaderVersion ? ` ${overview.loaderVersion}` : ''}
        </SettingRow>
        <SettingRow label="Mod">{overview.modCount > 0 ? `${overview.modCount} 个` : '没有'}</SettingRow>
        <SettingRow label="占用空间">{formatSize(overview.sizeBytes)}</SettingRow>
        <SettingRow label="版本隔离">
          <Badge tone={overview.isolated ? 'accent' : 'neutral'}>{overview.isolated ? '已隔离' : '共用'}</Badge>
        </SettingRow>
        <SettingRow label="最近游玩">{timeLabel(overview.lastPlayedAt)}</SettingRow>
        <SettingRow label="需要 Java">{overview.javaMajor ? `Java ${overview.javaMajor}` : '按版本自动判断'}</SettingRow>
      </SettingSection>
      <SettingSection title="版本操作" description="游戏运行中不能重命名、复制或删除。">
        <SettingRow label="更换图标" description="可以用本地图片、这个版本里某个 Mod 的图标、存档图标或服务器图标。">
          <Button size="sm" icon={<Image size={14} />} onPress={onIcon}>
            更换图标
          </Button>
        </SettingRow>
        <SettingRow label="重命名" description="同时改文件夹、版本 json 与 jar 名，PCL 子目录跟着文件夹一起改。">
          <Button size="sm" icon={<SquarePen size={14} />} onPress={onRename}>
            重命名
          </Button>
        </SettingRow>
        <SettingRow label="复制为新版本" description="连同隔离的 mods、存档与截图一起复制一份。">
          <Button size="sm" icon={<Copy size={14} />} onPress={onCopy}>
            复制为新版本
          </Button>
        </SettingRow>
        <SettingRow label="删除" description="移到游戏目录的 .trash/instances，不会永久删除。">
          <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onPress={onDelete}>
            删除到回收站
          </Button>
        </SettingRow>
      </SettingSection>
      {trash.length > 0 ? (
        <SettingSection title="回收站" description="删除的版本留在这里，可以恢复。">
          {trash.map((item) => (
            <SettingRow key={item.id} label={item.versionId} description={`${timeLabel(item.at)} · ${formatSize(item.size)}`}>
              <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onPress={() => onRestore(item.id)}>
                恢复
              </Button>
            </SettingRow>
          ))}
        </SettingSection>
      ) : null}
      <SettingSection title="启动设置">
        <SettingRow label="Java" description={overview.source.java === 'instance' ? '这个版本单独指定' : '跟随全局'}>
          {overview.effective.javaPath ?? '自动挑选'}
        </SettingRow>
        <SettingRow label="最大内存" description={overview.source.memory === 'instance' ? '这个版本单独指定' : '跟随全局'}>
          {memoryLabel(overview.effective.maxMemoryMb)}
        </SettingRow>
        <SettingRow label="自动进服" description={overview.effective.server ?? '没有设置'}>
          <Badge tone={overview.effective.server ? 'accent' : 'neutral'}>{overview.effective.server ? '已设置' : '未设置'}</Badge>
        </SettingRow>
        <SettingRow label="游戏目录" description={overview.gameDir} />
      </SettingSection>
    </>
  )
}

interface ResourcePacksProps {
  folder: string
  versionId: string
  onOpen(target: FolderTarget): Promise<void>
}

function packIcon(pack: ResourcePackEntry): ReactElement {
  if (pack.icon) return <img className="mod-row__icon" src={pack.icon} alt="" width={32} height={32} />
  return (
    <span className="res-icon res-icon--generated" style={{ '--hue': String(pack.name.length * 37 % 360) } as CSSProperties} aria-hidden="true">
      <Package size={16} />
    </span>
  )
}

function ResourcePacksPane({ folder, versionId, onOpen }: ResourcePacksProps): ReactElement {
  const { data, loading, error, reload, replace } = useVersionResources(folder, versionId, true)
  const [pending, setPending] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ResourcePackEntry | null>(null)
  const [notice, setNotice] = useState('')

  const toggle = async (pack: ResourcePackEntry): Promise<void> => {
    setPending(pack.file)
    setNotice('')
    try {
      replace(await window.craft.resourceToggle(folder, versionId, pack.file, !pack.enabled))
      setNotice(`${pack.name} ${pack.enabled ? '已停用' : '已启用'}，下次启动生效`)
    } catch (cause) {
      setNotice(cleanError(cause))
    } finally {
      setPending(null)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    const pack = deleting
    if (!pack) return
    setDeleting(null)
    try {
      replace(await window.craft.resourceDelete(folder, versionId, 'resourcepacks', pack.file))
      setNotice(`${pack.name} 已移到 .trash/resourcepacks`)
    } catch (cause) {
      setNotice(cleanError(cause))
    }
  }

  const packs = data?.resourcepacks ?? []
  const onRowKey = (event: KeyboardEvent<HTMLDivElement>, pack: ResourcePackEntry): void => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      void toggle(pack)
    }
    if (event.key === 'Delete') {
      event.preventDefault()
      setDeleting(pack)
    }
  }

  return (
    <>
      <PageHead
        title="资源包"
        description={data ? `共 ${packs.length} 个，启用 ${packs.filter((pack) => pack.enabled).length} 个` : '读取 resourcepacks 文件夹，可以启用、停用与删除。'}
        actions={
          <>
            <Button size="sm" icon={<RefreshCw size={14} />} onPress={reload}>
              刷新
            </Button>
            <Button size="sm" icon={<FolderOpen size={14} />} onPress={() => void onOpen('resourcepacks')}>
              打开文件夹
            </Button>
          </>
        }
      />
      {notice ? (
        <Notice tone="stall" compact>
          {notice}
        </Notice>
      ) : null}
      {loading && !data ? (
        <RowsSkeleton label="正在读取资源包" />
      ) : error ? (
        <Notice
          tone="fail"
          compact
          action={
            <Button size="sm" onPress={reload}>
              重试
            </Button>
          }
        >
          {error}
        </Notice>
      ) : packs.length === 0 ? (
        <EmptyBlock
          icon={<Package size={20} />}
          title="resourcepacks 里还没有资源包"
          actions={
            <Button variant="primary" icon={<FolderOpen size={14} />} onPress={() => void onOpen('resourcepacks')}>
              打开文件夹
            </Button>
          }
        >
          把 .zip 资源包放进这个文件夹，再回到这里启用。启停会写进 options.txt，下次启动生效。
        </EmptyBlock>
      ) : (
        <ul className="mod-list" aria-label="资源包">
          {packs.map((pack) => (
            <li key={pack.file}>
              <div className="mod-row" data-disabled={pack.enabled ? undefined : '1'} tabIndex={0} role="group" aria-label={pack.name} onKeyDown={(event) => onRowKey(event, pack)}>
                {packIcon(pack)}
                <span className="mod-row__main">
                  <span className="mod-row__name" title={pack.name}>
                    {pack.name}
                  </span>
                  <span className="mod-row__meta">
                    {pack.file} · {formatSize(pack.size)}
                    {pack.format ? ` · 格式 ${pack.format}` : ''}
                    {pack.enabled ? '' : ' · 已停用'}
                  </span>
                </span>
                <span className="mod-row__badges">{pack.enabled ? <Badge tone="accent">已启用</Badge> : <Badge>已停用</Badge>}</span>
                <span className="mod-row__actions">
                  <Switch aria-label={`启用 ${pack.name}`} isSelected={pack.enabled} isDisabled={pending === pack.file} onChange={() => void toggle(pack)} />
                  <IconButton aria-label={`删除 ${pack.name}`} size="sm" onPress={() => setDeleting(pack)}>
                    <Trash2 size={15} />
                  </IconButton>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!deleting} title="删除这个资源包？" confirmLabel="移到 .trash" danger onCancel={() => setDeleting(null)} onConfirm={() => void confirmDelete()}>
        {deleting ? `${deleting.name}（${deleting.file}）会移到游戏目录的 .trash/resourcepacks，不会永久删除；它也会从已启用列表里去掉。` : ''}
      </ConfirmDialog>
    </>
  )
}

function ShaderPacksPane({ folder, versionId, onOpen }: ResourcePacksProps): ReactElement {
  const { data, loading, error, reload, replace } = useVersionResources(folder, versionId, true)
  const [deleting, setDeleting] = useState<ShaderPackEntry | null>(null)
  const [notice, setNotice] = useState('')

  const confirmDelete = async (): Promise<void> => {
    const pack = deleting
    if (!pack) return
    setDeleting(null)
    try {
      replace(await window.craft.resourceDelete(folder, versionId, 'shaderpacks', pack.file))
      setNotice(`${pack.name} 已移到 .trash/shaderpacks`)
    } catch (cause) {
      setNotice(cleanError(cause))
    }
  }

  const packs = data?.shaderpacks ?? []

  return (
    <>
      <PageHead
        title="光影"
        description={data ? `共 ${packs.length} 个光影包` : '读取 shaderpacks 文件夹，可以打开文件夹与删除。'}
        actions={
          <>
            <Button size="sm" icon={<RefreshCw size={14} />} onPress={reload}>
              刷新
            </Button>
            <Button size="sm" icon={<FolderOpen size={14} />} onPress={() => void onOpen('shaderpacks')}>
              打开文件夹
            </Button>
          </>
        }
      />
      {notice ? (
        <Notice tone="stall" compact>
          {notice}
        </Notice>
      ) : null}
      {loading && !data ? (
        <RowsSkeleton label="正在读取光影" />
      ) : error ? (
        <Notice
          tone="fail"
          compact
          action={
            <Button size="sm" onPress={reload}>
              重试
            </Button>
          }
        >
          {error}
        </Notice>
      ) : packs.length === 0 ? (
        <EmptyBlock
          icon={<Sparkles size={20} />}
          title="shaderpacks 里还没有光影"
          actions={
            <Button variant="primary" icon={<FolderOpen size={14} />} onPress={() => void onOpen('shaderpacks')}>
              打开文件夹
            </Button>
          }
        >
          把光影包放进这个文件夹，然后在游戏里用光影设置挑选。启用开关由光影 Mod 管理。
        </EmptyBlock>
      ) : (
        <ul className="mod-list" aria-label="光影">
          {packs.map((pack) => (
            <li key={pack.file}>
              <div
                className="mod-row"
                tabIndex={0}
                role="group"
                aria-label={pack.name}
                onKeyDown={(event) => {
                  if (event.key === 'Delete') {
                    event.preventDefault()
                    setDeleting(pack)
                  }
                }}
              >
                <span className="res-icon res-icon--generated" aria-hidden="true">
                  <Sparkles size={16} />
                </span>
                <span className="mod-row__main">
                  <span className="mod-row__name" title={pack.name}>
                    {pack.name}
                  </span>
                  <span className="mod-row__meta">
                    {pack.file} · {formatSize(pack.size)}
                  </span>
                </span>
                <span className="mod-row__badges" />
                <span className="mod-row__actions">
                  <IconButton aria-label={`删除 ${pack.name}`} size="sm" onPress={() => setDeleting(pack)}>
                    <Trash2 size={15} />
                  </IconButton>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!deleting} title="删除这个光影包？" confirmLabel="移到 .trash" danger onCancel={() => setDeleting(null)} onConfirm={() => void confirmDelete()}>
        {deleting ? `${deleting.name}（${deleting.file}）会移到游戏目录的 .trash/shaderpacks，不会永久删除。` : ''}
      </ConfirmDialog>
    </>
  )
}

function SavesPane({ folder, versionId, onOpen }: ResourcePacksProps): ReactElement {
  const { data, loading, error, reload, replace } = useVersionResources(folder, versionId, true)
  const [deleting, setDeleting] = useState<SaveEntry | null>(null)
  const [notice, setNotice] = useState('')

  const confirmDelete = async (): Promise<void> => {
    const save = deleting
    if (!save) return
    setDeleting(null)
    try {
      replace(await window.craft.resourceDelete(folder, versionId, 'saves', save.folder))
      setNotice(`${save.name} 已移到 .trash/saves`)
    } catch (cause) {
      setNotice(cleanError(cause))
    }
  }

  const saves = data?.saves ?? []

  return (
    <>
      <PageHead
        title="存档"
        description={data ? `共 ${saves.length} 个存档` : '读取 saves 文件夹，显示名称、最后游玩时间与大小。'}
        actions={
          <>
            <Button size="sm" icon={<RefreshCw size={14} />} onPress={reload}>
              刷新
            </Button>
            <Button size="sm" icon={<FolderOpen size={14} />} onPress={() => void onOpen('saves')}>
              打开文件夹
            </Button>
          </>
        }
      />
      {notice ? (
        <Notice tone="stall" compact>
          {notice}
        </Notice>
      ) : null}
      {loading && !data ? (
        <RowsSkeleton label="正在读取存档" />
      ) : error ? (
        <Notice
          tone="fail"
          compact
          action={
            <Button size="sm" onPress={reload}>
              重试
            </Button>
          }
        >
          {error}
        </Notice>
      ) : saves.length === 0 ? (
        <EmptyBlock
          icon={<Archive size={20} />}
          title="saves 里还没有存档"
          actions={
            <Button variant="primary" icon={<FolderOpen size={14} />} onPress={() => void onOpen('saves')}>
              打开文件夹
            </Button>
          }
        >
          进游戏新建一个世界，或把别的存档文件夹放进来。
        </EmptyBlock>
      ) : (
        <ul className="mod-list" aria-label="存档">
          {saves.map((save) => (
            <li key={save.folder}>
              <div className="mod-row" tabIndex={0} role="group" aria-label={save.name}>
                {save.icon ? <img className="mod-row__icon" src={save.icon} alt="" width={32} height={32} /> : <span className="res-icon res-icon--generated" aria-hidden="true"><Archive size={16} /></span>}
                <span className="mod-row__main">
                  <span className="mod-row__name" title={save.folder}>
                    {save.name}
                  </span>
                  <span className="mod-row__meta">
                    {save.folder} · 最后游玩 {timeLabel(save.lastPlayed)} · {formatSize(save.size)}
                  </span>
                </span>
                <span className="mod-row__badges">{save.gameVersion ? <Badge>{save.gameVersion}</Badge> : null}</span>
                <span className="mod-row__actions">
                  <IconButton aria-label={`删除 ${save.name}`} size="sm" onPress={() => setDeleting(save)}>
                    <Trash2 size={15} />
                  </IconButton>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!deleting} title="删除这个存档？" confirmLabel="移到 .trash" danger onCancel={() => setDeleting(null)} onConfirm={() => void confirmDelete()}>
        {deleting ? `${deleting.name}（${deleting.folder}）会移到游戏目录的 .trash/saves，不会永久删除。` : ''}
      </ConfirmDialog>
    </>
  )
}

function ScreenshotsPane({ folder, versionId, onOpen }: ResourcePacksProps): ReactElement {
  const [shots, setShots] = useState<ScreenshotEntry[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<ScreenshotEntry | null>(null)

  const load = useCallback((): void => {
    setShots(null)
    setError('')
    void window.craft.versionScreenshots(folder, versionId).then(setShots, (cause: unknown) => setError(cleanError(cause)))
  }, [folder, versionId])

  useEffect(() => load(), [load])

  return (
    <>
      <PageHead
        title="截图"
        description={shots ? `共 ${shots.length} 张截图，点开看大图` : '读取 screenshots 文件夹，缩略图点开看大图。'}
        actions={
          <>
            <Button size="sm" icon={<RefreshCw size={14} />} onPress={load}>
              刷新
            </Button>
            <Button size="sm" icon={<FolderOpen size={14} />} onPress={() => void onOpen('screenshots')}>
              打开文件夹
            </Button>
          </>
        }
      />
      {error ? (
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
      ) : shots === null ? (
        <div className="l4-shots" aria-busy="true" aria-label="正在读取截图">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} shape="rect" height={96} />
          ))}
        </div>
      ) : shots.length === 0 ? (
        <EmptyBlock
          icon={<Camera size={20} />}
          title="screenshots 里还没有截图"
          actions={
            <Button variant="primary" icon={<FolderOpen size={14} />} onPress={() => void onOpen('screenshots')}>
              打开文件夹
            </Button>
          }
        >
          游戏里按 F2 截的图会出现在这里。
        </EmptyBlock>
      ) : (
        <div className="l4-shots" aria-label="截图">
          {shots.map((shot) => (
            <button key={shot.file} type="button" className="l4-shot" onClick={() => setOpen(shot)} aria-label={`打开 ${shot.file}`}>
              <img src={shot.dataUrl} alt="" />
              <span className="l4-shot__meta">
                {timeLabel(shot.at)}
                {shot.width && shot.height ? ` · ${shot.width}×${shot.height}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
      <Sheet open={!!open} title={open?.file ?? ''} onClose={() => setOpen(null)}>
        {open ? (
          <div className="l4-shot-view">
            <img src={open.dataUrl} alt={open.file} />
            <p className="page__muted">
              {timeLabel(open.at)} · {open.width && open.height ? `${open.width}×${open.height} · ` : ''}
              {formatSize(open.size)}
            </p>
          </div>
        ) : null}
      </Sheet>
    </>
  )
}

interface RecordsProps {
  folder: string
  versionId: string
  onOpenLogs(): void
  onOpen(target: FolderTarget): Promise<void>
}

function RecordsPane({ folder, versionId, onOpenLogs, onOpen }: RecordsProps): ReactElement {
  const [records, setRecords] = useState<CrashRecordSummary[] | null>(null)
  const [detail, setDetail] = useState<CrashDiagnosis | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback((): void => {
    setRecords(null)
    setError('')
    void Promise.all([window.craft.crashList(folder, versionId), window.craft.crashLatest(folder, versionId)]).then(
      ([list, latest]) => {
        setRecords(list)
        setDetail(latest)
      },
      (cause: unknown) => setError(cleanError(cause))
    )
  }, [folder, versionId])

  useEffect(() => load(), [load])

  const openRecord = async (id: string): Promise<void> => {
    setNotice('')
    try {
      setDetail(await window.craft.crashGet(folder, versionId, id))
    } catch (cause) {
      setNotice(cleanError(cause))
    }
  }

  const exportRecord = async (id: string): Promise<void> => {
    setBusy(true)
    setNotice('')
    try {
      const result = await window.craft.crashExport(folder, versionId, id)
      setNotice(result ? `诊断包已导出：${result.path}` : '找不到这份崩溃记录')
    } catch (cause) {
      setNotice(cleanError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead
        title="日志与崩溃"
        description="每次崩溃都保存在数据目录的 crash 文件夹，可以看结论、证据与嫌疑 Mod，也可以导出诊断包。"
        actions={
          <>
            <Button size="sm" icon={<FileText size={14} />} onPress={onOpenLogs}>
              本次游戏日志
            </Button>
            <Button size="sm" icon={<FolderOpen size={14} />} onPress={() => void onOpen('logs')}>
              打开日志文件夹
            </Button>
            <Button size="sm" icon={<Download size={14} />} isDisabled={busy || !detail} onPress={() => detail && void exportRecord(detail.id)}>
              导出报告
            </Button>
          </>
        }
      />
      {notice ? (
        <Notice tone="stall" compact>
          {notice}
        </Notice>
      ) : null}
      {error ? (
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
      ) : records === null ? (
        <RowsSkeleton label="正在读取崩溃记录" />
      ) : records.length === 0 ? (
        <EmptyBlock
          icon={<FileText size={20} />}
          title="还没有崩溃记录"
          actions={
            <Button variant="primary" icon={<FileText size={14} />} onPress={onOpenLogs}>
              看本次游戏日志
            </Button>
          }
        >
          游戏非正常退出时会自动收集日志、崩溃报告与启动参数，结论会出现在崩溃对话框和这里。
        </EmptyBlock>
      ) : (
        <>
          {detail ? (
            <SettingSection title="最近一次崩溃" description={`${timeLabel(detail.at)} · 退出码 ${detail.exitCode ?? '未知'}`}>
              <SettingRow label="结论" description={detail.note ?? undefined}>
                {detail.rule ? `${detail.rule.title}（置信度${detail.rule.confidence === 'high' ? '高' : '中'}）` : '没认出原因'}
              </SettingRow>
              {detail.evidence.length > 0 ? (
                <SettingRow label="证据" description={`命中 ${detail.evidence.length} 行日志`}>
                  <pre className="l4-evidence">{detail.evidence.slice(0, 5).map((line) => `[${line.source}] ${line.text}`).join('\n')}</pre>
                </SettingRow>
              ) : null}
              <SettingRow label="嫌疑 Mod" description={detail.suspects.length > 0 ? detail.suspects.map((item) => `${item.name}（${item.hits} 次）`).join('、') : '没有对上号'} />
              {detail.recordDir ? <SettingRow label="记录目录" description={detail.recordDir} /> : null}
            </SettingSection>
          ) : null}
          <ul className="mod-list" aria-label="崩溃记录">
            {records.map((record) => (
              <li key={record.id}>
                <div className="mod-row" tabIndex={0} role="group" aria-label={record.title} data-selected={detail?.id === record.id ? '1' : undefined}>
                  <span className="res-icon res-icon--generated" aria-hidden="true">
                    <FileText size={16} />
                  </span>
                  <span className="mod-row__main">
                    <span className="mod-row__name" title={record.title}>
                      {record.title}
                    </span>
                    <span className="mod-row__meta">
                      {timeLabel(record.at)} · 退出码 {record.exitCode ?? '未知'}
                      {record.ruleId ? ` · ${record.ruleId}` : ''}
                    </span>
                  </span>
                  <span className="mod-row__badges">{detail?.id === record.id ? <Badge tone="accent">正在查看</Badge> : null}</span>
                  <span className="mod-row__actions">
                    <Button size="sm" variant="ghost" onPress={() => void openRecord(record.id)}>
                      看结论
                    </Button>
                    <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void exportRecord(record.id)}>
                      导出
                    </Button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <SettingSection title="文件夹">
        <SettingRow label="游戏日志" description="logs">
          <Button size="sm" variant="ghost" icon={<FolderOpen size={14} />} onPress={() => void onOpen('logs')}>
            打开
          </Button>
        </SettingRow>
        <SettingRow label="崩溃报告" description="crash-reports">
          <Button size="sm" variant="ghost" icon={<FolderOpen size={14} />} onPress={() => void onOpen('crash-reports')}>
            打开
          </Button>
        </SettingRow>
      </SettingSection>
    </>
  )
}

function IconGrid({ options, onPick }: { options: InstanceIconOption[]; onPick(option: InstanceIconOption): void }): ReactElement {
  return (
    <div className="l4-icons" aria-label="可用的图标">
      {options.map((option) => (
        <button key={`${option.kind}-${option.ref}`} type="button" className="l4-icon-option" onClick={() => onPick(option)} title={option.label}>
          <img src={option.preview} alt="" width={32} height={32} />
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  )
}

export function VersionPage({ folder, versionId, settings, onBack, onOpenLogs, onRenamed }: Props): ReactElement {
  const [section, setSection] = useState<Section>('overview')
  const [instance, setInstance] = useState<InstanceInfo | null | undefined>(undefined)
  const [overview, setOverview] = useState<InstanceOverview | null>(null)
  const [javas, setJavas] = useState<JavaEntry[]>([])
  const [notice, setNotice] = useState('')
  const [trash, setTrash] = useState<InstanceTrashRecord[]>([])
  const [iconVersion, setIconVersion] = useState(0)

  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState(versionId)
  const [copyOpen, setCopyOpen] = useState(false)
  const [copyValue, setCopyValue] = useState(`${versionId}-副本`)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState('')
  const [iconOpen, setIconOpen] = useState(false)
  const [iconOptions, setIconOptions] = useState<InstanceIconOption[] | null>(null)
  const [iconError, setIconError] = useState('')

  const loadInstance = useCallback((): void => {
    void window.craft.instances(folder).then(
      (list) => setInstance(list.find((item) => item.id === versionId) ?? null),
      () => setInstance(null)
    )
    void window.craft.instanceOverview(folder, versionId).then(setOverview, () => setOverview(null))
    void window.craft.trashedInstances(folder).then(setTrash, () => setTrash([]))
  }, [folder, versionId])

  useEffect(() => {
    setInstance(undefined)
    setOverview(null)
    setNotice('')
    loadInstance()
  }, [loadInstance])

  useEffect(() => {
    let alive = true
    void window.craft.javas().then(
      (list) => alive && setJavas(list),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => setNotice(''), [section])

  const open = async (target: FolderTarget, name?: string): Promise<void> => {
    setNotice('')
    try {
      const path = await window.craft.openFolder(folder, versionId, target)
      if (!path) setNotice(`${name ?? target}文件夹还不存在，游戏运行过一次后会自动创建。`)
    } catch (cause) {
      setNotice(cleanError(cause))
    }
  }

  const openButton = (target: FolderTarget, name: string, primary = false): ReactElement => (
    <Button variant={primary ? 'primary' : 'secondary'} size="sm" icon={<FolderOpen size={14} />} onPress={() => void open(target, name)}>
      打开{name}文件夹
    </Button>
  )

  const startRename = (): void => {
    setRenameValue(versionId)
    setDialogError('')
    setRenameOpen(true)
  }

  const startCopy = (): void => {
    setCopyValue(`${versionId}-副本`)
    setDialogError('')
    setCopyOpen(true)
  }

  const submitRename = async (): Promise<void> => {
    setBusy(true)
    setDialogError('')
    try {
      const result = await window.craft.renameInstance(folder, versionId, renameValue.trim())
      forgetInstanceIcons()
      setRenameOpen(false)
      onRenamed(result.id)
    } catch (cause) {
      setDialogError(cleanError(cause))
    } finally {
      setBusy(false)
    }
  }

  const submitCopy = async (): Promise<void> => {
    setBusy(true)
    setDialogError('')
    try {
      const result = await window.craft.copyInstance(folder, versionId, copyValue.trim() || null)
      setCopyOpen(false)
      setNotice(`已复制为 ${result.id}（${formatSize(result.size)}），在启动页的版本列表里能看到`)
      loadInstance()
    } catch (cause) {
      setDialogError(cleanError(cause))
    } finally {
      setBusy(false)
    }
  }

  const submitDelete = async (): Promise<void> => {
    setBusy(true)
    setDialogError('')
    try {
      await window.craft.deleteInstance(folder, versionId)
      forgetInstanceIcons()
      setDeleteOpen(false)
      onBack()
    } catch (cause) {
      setDialogError(cleanError(cause))
    } finally {
      setBusy(false)
    }
  }

  const restore = async (id: string): Promise<void> => {
    setNotice('')
    try {
      const restored = await window.craft.restoreInstance(folder, id)
      setNotice(`${restored} 已从回收站恢复`)
      loadInstance()
    } catch (cause) {
      setNotice(cleanError(cause))
    }
  }

  const loadIconOptions = (): void => {
    setIconOptions(null)
    setIconError('')
    void window.craft.instanceIconOptions(folder, versionId).then(setIconOptions, (cause: unknown) => {
      setIconOptions([])
      setIconError(cleanError(cause))
    })
  }

  const openIconSheet = (): void => {
    setIconOpen(true)
    loadIconOptions()
  }

  const applyIcon = async (kind: string, ref: string | null): Promise<void> => {
    setIconError('')
    try {
      await window.craft.setInstanceIcon(folder, versionId, kind, ref)
      forgetInstanceIcons()
      setIconVersion((value) => value + 1)
      setIconOpen(false)
      setNotice('图标已更换')
    } catch (cause) {
      setIconError(cleanError(cause))
    }
  }

  const pickIconFile = async (): Promise<void> => {
    setIconError('')
    try {
      const path = await window.craft.pickImage()
      if (!path) return
      await applyIcon('file', path)
    } catch (cause) {
      setIconError(cleanError(cause))
    }
  }

  const clearIcon = async (): Promise<void> => {
    setIconError('')
    try {
      await window.craft.clearInstanceIcon(folder, versionId)
      forgetInstanceIcons()
      setIconVersion((value) => value + 1)
      setIconOpen(false)
      setNotice('已清除自定义图标')
    } catch (cause) {
      setIconError(cleanError(cause))
    }
  }

  const header = (
    <div className="version-head">
      <InstanceIcon key={iconVersion} folder={folder} versionId={versionId} size={28} />
      <span className="version-head__text">
        <span className="version-head__name" title={versionId}>
          {versionId}
        </span>
        <span className="version-head__meta">{instance ? `${LOADER_LABEL[instance.loader]} · ${instance.minecraftVersion ?? '?'}` : ''}</span>
      </span>
    </div>
  )

  return (
    <SubNavLayout label="版本管理" groups={GROUPS} active={section} onChange={(id) => setSection(id)} header={header} onBack={onBack} backLabel="返回版本列表">
      <div className="subpage">
        {notice ? (
          <Notice tone="stall" compact>
            {notice}
          </Notice>
        ) : null}
        {instance === undefined ? (
          <RowsSkeleton label="正在读取版本" />
        ) : instance === null ? (
          <EmptyBlock title="找不到这个版本" actions={<Button onPress={onBack}>返回版本列表</Button>}>
            它可能已被移走或删除。
          </EmptyBlock>
        ) : section === 'overview' ? (
          overview ? (
            <OverviewPane
              overview={overview}
              trash={trash}
              onOpen={open}
              onGo={setSection}
              onRename={startRename}
              onCopy={startCopy}
              onDelete={() => {
                setDialogError('')
                setDeleteOpen(true)
              }}
              onIcon={openIconSheet}
              onRestore={(id) => void restore(id)}
            />
          ) : (
            <>
              <PageHead title={instance.id} description={`${LOADER_LABEL[instance.loader]} · MC ${instance.minecraftVersion ?? '?'}`} actions={<>{openButton('version', '版本')}{openButton('game', '游戏')}</>} />
              {instance.error ? (
                <Notice tone="fail" compact>
                  {instance.error}
                </Notice>
              ) : null}
              <SettingSection title="版本信息">
                <SettingRow label="Minecraft">{instance.minecraftVersion ?? '未知'}</SettingRow>
                <SettingRow label="加载器">
                  {LOADER_LABEL[instance.loader]}
                  {instance.loaderVersion ? ` ${instance.loaderVersion}` : ''}
                </SettingRow>
                <SettingRow label="需要 Java">{instance.javaMajor ? `Java ${instance.javaMajor}` : '按版本自动判断'}</SettingRow>
                <SettingRow label="Mod">{instance.modCount > 0 ? `${instance.modCount} 个` : '没有'}</SettingRow>
              </SettingSection>
              <SettingSection title="目录">
                <SettingRow label="游戏目录" description={instance.gameDir}>
                  {instance.isolated ? <Badge tone="accent">版本隔离</Badge> : <Badge>共用</Badge>}
                </SettingRow>
              </SettingSection>
            </>
          )
        ) : section === 'settings' ? (
          overview ? (
            <OverridePane
              folder={folder}
              versionId={versionId}
              overview={overview}
              javas={javas}
              onSaved={() => {
                setNotice('设置已保存，启动时生效')
                loadInstance()
              }}
            />
          ) : (
            <>
              <PageHead title="版本设置" description="正在读取这个版本的设置…" />
              <SettingSection title="正在使用的值">
                <SettingRow label="最大内存">{memoryLabel(settings.maxMemoryMb)}</SettingRow>
                <SettingRow label="Java" description={instance.preferredJava ?? '自动挑选'} />
              </SettingSection>
            </>
          )
        ) : section === 'repair' ? (
          <RepairPane folder={folder} versionId={versionId} />
        ) : section === 'mods' ? (
          <ModList folder={folder} versionId={versionId} loader={instance.loader} onOpenFolder={(target) => open(target)} />
        ) : section === 'resourcepacks' ? (
          <ResourcePacksPane folder={folder} versionId={versionId} onOpen={open} />
        ) : section === 'shaderpacks' ? (
          <ShaderPacksPane folder={folder} versionId={versionId} onOpen={open} />
        ) : section === 'saves' ? (
          <SavesPane folder={folder} versionId={versionId} onOpen={open} />
        ) : section === 'screenshots' ? (
          <ScreenshotsPane folder={folder} versionId={versionId} onOpen={open} />
        ) : (
          <RecordsPane folder={folder} versionId={versionId} onOpenLogs={onOpenLogs} onOpen={open} />
        )}
      </div>
      <ConfirmDialog
        open={renameOpen}
        title="重命名这个版本"
        confirmLabel={busy ? '正在改名…' : '重命名'}
        busy={busy}
        onCancel={() => setRenameOpen(false)}
        onConfirm={() => void submitRename()}
      >
        <span className="l4-dialog">
          <span>文件夹、版本 json 与 jar 会一起改名，PCL 子目录跟着文件夹走。游戏运行中不能改名。</span>
          <TextField aria-label="新版本名" size="sm" value={renameValue} onChange={setRenameValue} />
          {dialogError ? <Notice tone="fail" compact>{dialogError}</Notice> : null}
        </span>
      </ConfirmDialog>
      <ConfirmDialog
        open={copyOpen}
        title="复制为新版本"
        confirmLabel={busy ? '正在复制…' : '复制'}
        busy={busy}
        onCancel={() => setCopyOpen(false)}
        onConfirm={() => void submitCopy()}
      >
        <span className="l4-dialog">
          <span>连隔离目录里的 mods、存档与截图一起复制。重名时自动加序号。</span>
          <TextField aria-label="新版本名" size="sm" value={copyValue} onChange={setCopyValue} />
          {dialogError ? <Notice tone="fail" compact>{dialogError}</Notice> : null}
        </span>
      </ConfirmDialog>
      <ConfirmDialog
        open={deleteOpen}
        title="删除这个版本？"
        confirmLabel={busy ? '正在删除…' : '移到回收站'}
        danger
        busy={busy}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void submitDelete()}
      >
        <span className="l4-dialog">
          <span>{versionId} 会移到游戏目录的 .trash/instances，不会永久删除；版本设置和自定义图标一起移走，概览页的回收站里可以恢复。</span>
          {dialogError ? <Notice tone="fail" compact>{dialogError}</Notice> : null}
        </span>
      </ConfirmDialog>
      <Sheet open={iconOpen} title="更换实例图标" onClose={() => setIconOpen(false)}>
        <div className="l4-icons-body">
          <p className="page__muted">按顺序优先：自定义图标 → 整合包自带 → PCL Logo → 加载器图标 → 原版方块贴图 → 生成的像素图标。这里选的自定义图标排在最前。</p>
          {iconError ? (
            <Notice tone="fail" compact>
              {iconError}
            </Notice>
          ) : null}
          <div className="l4-icons-actions">
            <Button size="sm" variant="primary" icon={<Image size={14} />} onPress={() => void pickIconFile()}>
              用本地图片
            </Button>
            <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onPress={() => void clearIcon()}>
              清除自定义图标
            </Button>
          </div>
          {iconOptions === null ? (
            <RowsSkeleton label="正在读取可用图标" />
          ) : iconOptions.length === 0 ? (
            <p className="page__muted">这个版本里没有能用来自动提取图标的 Mod、存档或服务器，可以用本地图片。</p>
          ) : (
            <IconGrid options={iconOptions} onPick={(option) => void applyIcon(option.kind, option.ref)} />
          )}
        </div>
      </Sheet>
    </SubNavLayout>
  )
}
