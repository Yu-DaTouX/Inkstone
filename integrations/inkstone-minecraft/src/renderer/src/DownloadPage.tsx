import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { Boxes, Download, ExternalLink, FileArchive, Package, Pickaxe, Puzzle, Sparkles } from 'lucide-react'
import { Header } from 'react-aria-components'
import { Badge } from '@yan/ui/Badge'
import { Button } from '@yan/ui/Button'
import { ComboBox } from '@yan/ui/ComboBox'
import { ListBoxItem, ListBoxSection } from '@yan/ui/ListBox'
import { Notice } from '@yan/ui/Notice'
import { ProgressBar } from '@yan/ui/Progress'
import { Select } from '@yan/ui/Select'
import { Switch } from '@yan/ui/Switch'
import { SearchField, TextField } from '@yan/ui/TextField'
import type { InstallKind, LauncherSettings, LoaderVersion, LoaderVersions, MinecraftVersionEntry, MinecraftVersionList, TaskInfo, TaskProgress } from '../../shared/api.ts'
import type { ContentCategory, ContentInstallType, ModpackSummary } from '../../shared/download-api.ts'
import type { ModrinthHit, ModrinthProject, ModrinthSearchResult, ModrinthSort, ModrinthVersion } from '../../shared/mods-api.ts'
import { EmptyBlock, PageHead, SubNavLayout, type SubNavGroup } from './SubNavLayout.tsx'
import { ModSearch } from './ModSearch.tsx'
import { Sheet } from './overlays.tsx'

type Section = 'minecraft' | 'mods' | 'resourcepacks' | 'shaderpacks' | 'modpacks'
type VersionGroup = MinecraftVersionEntry['group']

const GROUPS: SubNavGroup<Section>[] = [
  {
    label: '安装',
    items: [{ id: 'minecraft', label: 'Minecraft', icon: <Pickaxe size={16} /> }]
  },
  {
    label: '社区资源',
    items: [
      { id: 'mods', label: 'Mod', icon: <Puzzle size={16} /> },
      { id: 'resourcepacks', label: '资源包', icon: <Package size={16} /> },
      { id: 'shaderpacks', label: '光影', icon: <Sparkles size={16} /> },
      { id: 'modpacks', label: '整合包', icon: <Boxes size={16} /> }
    ]
  }
]

const GROUP_FILTERS: { id: VersionGroup; label: string }[] = [
  { id: 'release', label: '正式版' },
  { id: 'snapshot', label: '快照' },
  { id: 'old', label: '远古' }
]

const GROUP_LABEL: Record<VersionGroup, string> = { release: '正式版', snapshot: '快照', old: '远古' }

const KIND_LABEL: Record<InstallKind, string> = { vanilla: '原版', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }

const SORTS: Array<{ id: ModrinthSort; label: string }> = [
  { id: 'relevance', label: '相关' },
  { id: 'downloads', label: '下载量' },
  { id: 'updated', label: '更新时间' }
]

const CATEGORY_LABELS: Record<string, string> = {
  '16x': '16x',
  '32x': '32x',
  '64x': '64x',
  '128x': '128x',
  '256x': '256x',
  '512x+': '512x+',
  audio: '音效',
  blocks: '方块',
  bloom: '泛光',
  cartoon: '卡通',
  colorful: '鲜艳',
  combat: '战斗',
  'core-shaders': '核心',
  cursed: '搞怪',
  decoration: '装饰',
  entities: '实体',
  environment: '环境',
  'gui-rework': '界面重做',
  'half-tone': '半色调',
  items: '物品',
  locale: '语言',
  low: '低配',
  medium: '中配',
  high: '高配',
  'minecraft-java': 'Java 版',
  models: '模型',
  modded: '整合包',
  'no-lag': '不卡顿',
  'path-tracing': '路径追踪',
  photo: '照片',
  realistic: '写实',
  reflections: '反射',
  screenshot: '截图',
  'semi-realistic': '半写实',
  smooth: '平滑',
  simplified: '简约',
  themed: '主题',
  traditional: '传统',
  tweaks: '细节调整',
  'vanilla-like': '原版风格',
  fonts: '字体'
}

interface LoaderCardProps {
  label: string
  hint: string
  selected: boolean
  disabled: boolean
  onSelect(): void
  children?: ReactNode
}

function LoaderCard({ label, hint, selected, disabled, onSelect, children }: LoaderCardProps): ReactElement {
  return (
    <li className="install-loader" data-selected={selected ? '1' : undefined} data-disabled={disabled ? '1' : undefined}>
      <button type="button" className="install-loader__pick" aria-pressed={selected} disabled={disabled} onClick={onSelect}>
        <span className="install-loader__name">{label}</span>
        <span className="install-loader__hint">{hint}</span>
      </button>
      {selected && children ? <div className="install-loader__extra">{children}</div> : null}
    </li>
  )
}

function cleanError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function percentOf(task: TaskInfo | null): number | null {
  if (!task?.progress || task.progress.total <= 0) return null
  return Math.min(100, (task.progress.done / task.progress.total) * 100)
}

function progressText(progress: TaskProgress | null): string | null {
  if (!progress) return null
  const unit = progress.unit === 'steps' ? '步骤' : progress.unit === 'files' ? '文件' : '数量'
  return `${unit} ${progress.done}/${progress.total}`
}

function downloadsLabel(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

function numberCompare(a: string, b: string): number {
  const left = a.split(/[.-]/).map((part) => Number.parseInt(part, 10))
  const right = b.split(/[.-]/).map((part) => Number.parseInt(part, 10))
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = Number.isFinite(left[index]) ? left[index] : 0
    const y = Number.isFinite(right[index]) ? right[index] : 0
    if (x !== y) return x - y
  }
  return 0
}

interface VersionBucket {
  id: string
  label: string
  items: LoaderVersion[]
}

export function groupLoaderVersions(versions: LoaderVersion[], recommended: string | null): VersionBucket[] {
  const buckets: VersionBucket[] = []
  const recommendedItem = recommended ? versions.find((item) => item.version === recommended) : undefined
  if (recommendedItem) buckets.push({ id: 'recommended', label: '推荐', items: [recommendedItem] })
  const latest = [...versions].sort((a, b) => numberCompare(b.version, a.version))[0]
  if (latest && latest.version !== recommendedItem?.version) buckets.push({ id: 'latest', label: '最新', items: [latest] })
  const shown = new Set(buckets.flatMap((bucket) => bucket.items.map((item) => item.version)))
  const groups = new Map<string, LoaderVersion[]>()
  for (const item of versions) {
    if (shown.has(item.version)) continue
    const prefix = item.version.split('.').slice(0, 2).join('.')
    const list = groups.get(prefix) ?? []
    list.push(item)
    groups.set(prefix, list)
  }
  for (const [prefix, items] of [...groups.entries()].sort((a, b) => numberCompare(b[0], a[0]))) {
    buckets.push({ id: `g-${prefix}`, label: `${prefix}${/^\d/.test(prefix) ? '.x' : ''}`, items: [...items].sort((a, b) => numberCompare(b.version, a.version)) })
  }
  return buckets
}

function LoaderVersionPicker(props: { label: string; versions: LoaderVersion[]; recommended: string | null; selected: string | null; onSelect(version: string): void }): ReactElement {
  const buckets = useMemo(() => groupLoaderVersions(props.versions, props.recommended), [props.versions, props.recommended])
  return (
    <ComboBox
      aria-label={`${props.label} 版本`}
      selectedKey={props.selected}
      onSelectionChange={(key) => key != null && props.onSelect(String(key))}
      inputPlaceholder="搜索版本号"
      listClassName="l5-versions"
    >
      {buckets.map((bucket) => (
        <ListBoxSection key={bucket.id} id={bucket.id}>
          <Header className="l5-versions__label">{bucket.label}</Header>
          {bucket.items.map((item) => (
            <ListBoxItem key={item.version} id={item.version} textValue={`${item.version} ${bucket.label}`}>
              <span className="l5-versions__row">
                <span>{item.version}</span>
                {item.version === props.recommended ? <Badge tone="accent">推荐</Badge> : null}
                {item.stable ? null : <span className="page__muted">测试版</span>}
              </span>
            </ListBoxItem>
          ))}
        </ListBoxSection>
      ))}
    </ComboBox>
  )
}

interface ContentBrowserProps {
  projectType: ContentInstallType
  title: string
  description: string
  icon: ReactNode
  emptyTitle: string
}

function ContentBrowser({ projectType, title, description, icon, emptyTitle }: ContentBrowserProps): ReactElement {
  const [settings, setSettings] = useState<LauncherSettings | null>(null)
  const [instances, setInstances] = useState<Array<{ folder: string; folderName: string; id: string; minecraftVersion: string | null; loader: string }>>([])
  const [targetKey, setTargetKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searchText, setSearchText] = useState('')
  const [sort, setSort] = useState<ModrinthSort>('relevance')
  const [category, setCategory] = useState<string | null>(null)
  const [categories, setCategories] = useState<ContentCategory[]>([])
  const [minecraft, setMinecraft] = useState('')
  const [results, setResults] = useState<ModrinthSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [openHit, setOpenHit] = useState<ModrinthHit | null>(null)
  const [project, setProject] = useState<ModrinthProject | null>(null)
  const [versions, setVersions] = useState<ModrinthVersion[] | null>(null)
  const [versionError, setVersionError] = useState('')
  const [installing, setInstalling] = useState<string | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [task, setTask] = useState<TaskInfo | null>(null)

  useEffect(() => {
    let alive = true
    void window.craft.settings().then(
      (loaded) => alive && setSettings(loaded),
      () => alive && setSettings(null)
    )
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    void window.craft.downloadCategories(projectType).then(
      (list) => alive && setCategories(list),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [projectType])

  useEffect(() => {
    if (!settings) return
    const folder = settings.selectedFolder ?? settings.folders[0]?.path
    if (!folder) return
    let alive = true
    void window.craft.instances(folder).then(
      (list) =>
        alive &&
        setInstances(
          list.map((item) => ({
            folder: item.folder,
            folderName: settings.folders.find((entry) => entry.path === item.folder)?.name ?? item.folder,
            id: item.id,
            minecraftVersion: item.minecraftVersion,
            loader: item.loader
          }))
        ),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [settings])

  useEffect(() => {
    if (targetKey && instances.some((item) => `${item.folder}|${item.id}` === targetKey)) return
    const preferred = settings?.selectedVersion ? instances.find((item) => item.id === settings.selectedVersion) : undefined
    const next = preferred ?? instances[0]
    if (!next) return
    setTargetKey(`${next.folder}|${next.id}`)
    setMinecraft(next.minecraftVersion ?? '')
  }, [instances, settings, targetKey])

  const target = instances.find((item) => `${item.folder}|${item.id}` === targetKey) ?? null

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
        setNotice(next.detail ?? '已安装')
        setInstalling(null)
      }
      if (next.state === 'failed') {
        setNotice(next.error ?? '安装失败')
        setInstalling(null)
      }
      if (next.state === 'cancelled') {
        setNotice(next.detail ?? '安装已取消')
        setInstalling(null)
      }
    })
    return () => {
      alive = false
      stop()
    }
  }, [taskId])

  const search = useCallback(
    (offset: number): void => {
      setLoading(true)
      setError('')
      void window.craft
        .downloadSearch({ projectType, query: searchText, category, loader: null, minecraft: minecraft.trim() || null, sort, limit: 20, offset })
        .then(
          (result) => {
            setResults(result)
            setLoading(false)
          },
          (cause: unknown) => {
            setError(cleanError(cause))
            setLoading(false)
          }
        )
    },
    [category, minecraft, projectType, searchText, sort]
  )

  useEffect(() => {
    const timer = setTimeout(() => setSearchText(query), 350)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!settings) return
    search(0)
  }, [settings, sort, category, minecraft, searchText, search])

  const openProject = async (hit: ModrinthHit): Promise<void> => {
    setOpenHit(hit)
    setProject(null)
    setVersions(null)
    setVersionError('')
    try {
      const [detail, list] = await Promise.all([
        window.craft.modProject(hit.projectId).catch(() => null),
        window.craft.downloadVersions(hit.projectId, null, minecraft.trim() || null).catch((cause: unknown) => {
          setVersionError(cleanError(cause))
          return []
        })
      ])
      setProject(detail)
      setVersions(list)
    } catch (cause) {
      setVersionError(cleanError(cause))
    }
  }

  const install = async (version: ModrinthVersion): Promise<void> => {
    if (!target) {
      setNotice('先选一个要装到的版本')
      return
    }
    setNotice('')
    setInstalling(version.id)
    try {
      setTaskId(await window.craft.downloadInstall({ folder: target.folder, versionId: target.id, projectType, versionFileId: version.id }))
    } catch (cause) {
      setInstalling(null)
      setNotice(cleanError(cause))
    }
  }

  const label = projectType === 'shader' ? '光影' : '资源包'
  const hits = results?.hits ?? []

  return (
    <>
      <PageHead
        title={title}
        description={description}
        actions={
          <Button size="sm" icon={<Download size={14} />} onPress={() => search(0)} isDisabled={loading}>
            搜索
          </Button>
        }
      />
      {notice ? (
        <Notice tone={/失败|不可用/.test(notice) ? 'fail' : 'stall'} compact>
          {notice}
        </Notice>
      ) : null}
      {task && (task.state === 'running' || task.state === 'queued') ? (
        <div className="install-progress" data-state={task.state}>
          <ProgressBar
            aria-label="安装进度"
            label={task.detail ?? task.title}
            showValue
            value={task.progress && task.progress.total > 0 ? Math.min(100, (task.progress.done / task.progress.total) * 100) : 0}
            isIndeterminate={!task.progress || task.progress.total <= 0}
            tone="run"
          />
        </div>
      ) : null}
      {instances.length === 0 ? (
        <EmptyBlock icon={icon} title={emptyTitle}>
          先在「安装 Minecraft」里装一个版本，再回来这里。
        </EmptyBlock>
      ) : (
        <>
          <div className="l5-filters">
            <SearchField aria-label={`搜索${label}`} placeholder={`搜索 Modrinth 的${label}`} value={query} onChange={setQuery} onSubmit={() => search(0)} />
            <Select aria-label="游戏版本" selectedKey={minecraft || null} onSelectionChange={(key) => key != null && setMinecraft(String(key))} placeholder="游戏版本">
              {[...new Set(instances.map((item) => item.minecraftVersion).filter((value): value is string => !!value))].map((value) => (
                <ListBoxItem key={value} id={value} textValue={value}>
                  {value}
                </ListBoxItem>
              ))}
            </Select>
            <Select aria-label="分类" selectedKey={category ?? 'all'} onSelectionChange={(key) => key != null && setCategory(String(key) === 'all' ? null : String(key))}>
              <ListBoxItem id="all" textValue="全部分类">
                全部分类
              </ListBoxItem>
              {categories.map((item) => (
                <ListBoxItem key={item.name} id={item.name} textValue={CATEGORY_LABELS[item.name] ?? item.name}>
                  {CATEGORY_LABELS[item.name] ?? item.name}
                </ListBoxItem>
              ))}
            </Select>
            <Select aria-label="排序" selectedKey={sort} onSelectionChange={(key) => key != null && setSort(String(key) as ModrinthSort)}>
              {SORTS.map((item) => (
                <ListBoxItem key={item.id} id={item.id} textValue={item.label}>
                  {item.label}
                </ListBoxItem>
              ))}
            </Select>
            <Select aria-label="安装到" selectedKey={targetKey} onSelectionChange={(key) => key != null && setTargetKey(String(key))}>
              {instances.map((item) => (
                <ListBoxItem key={`${item.folder}|${item.id}`} id={`${item.folder}|${item.id}`} textValue={`${item.folderName} ${item.id}`}>
                  {`${item.folderName} · ${item.id}`}
                </ListBoxItem>
              ))}
            </Select>
          </div>
          {target ? (
            <p className="page__muted">
              装到 {target.folderName} · {target.id} 的 {projectType === 'shader' ? 'shaderpacks' : 'resourcepacks'} 目录。
            </p>
          ) : null}
          {loading ? <p className="page__muted">正在搜索 Modrinth…</p> : null}
          {error ? (
            <Notice
              tone="fail"
              compact
              action={
                <Button size="sm" onPress={() => search(0)}>
                  重试
                </Button>
              }
            >
              {error}
            </Notice>
          ) : null}
          {!loading && !error && hits.length === 0 ? <p className="page__muted">没有找到{label}，换个关键词或清掉分类再试。</p> : null}
          {hits.length > 0 ? (
            <ul className="install-list" aria-label={`${label}搜索结果`}>
              {hits.map((hit) => (
                <li key={hit.projectId}>
                  <button type="button" className="install-row" data-selected={openHit?.projectId === hit.projectId ? '1' : undefined} onClick={() => void openProject(hit)}>
                    <span className="install-row__icon" aria-hidden="true">
                      {hit.iconUrl ? <img className="mod-row__icon" src={hit.iconUrl} alt="" width={32} height={32} /> : icon}
                    </span>
                    <span className="install-row__main">
                      <span className="install-row__name">{hit.title}</span>
                      <span className="install-row__meta">
                        {hit.description} · {hit.author}
                      </span>
                    </span>
                    <span className="install-row__meta">
                      {downloadsLabel(hit.downloads)} 次下载 · {hit.updated.slice(0, 10)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      <Sheet
        open={!!openHit}
        title={openHit?.title ?? `${label}详情`}
        actions={
          openHit ? (
            <Button size="sm" variant="ghost" icon={<ExternalLink size={14} />} onPress={() => void window.craft.openUrl(`https://modrinth.com/project/${openHit.slug || openHit.projectId}`)}>
              打开 Modrinth 页面
            </Button>
          ) : null
        }
        onClose={() => setOpenHit(null)}
      >
        <div className="mod-sheet">
          <p className="page__muted">{target ? `装到 ${target.folderName} · ${target.id}（MC ${target.minecraftVersion ?? '版本未知'}）` : '先选一个要装到的版本'}</p>
          {project ? (
            <div className="mod-search__detail">
              <p className="page__muted">{project.description}</p>
              <div className="mod-search__badges">
                {project.categories.slice(0, 8).map((name) => (
                  <Badge key={name}>{CATEGORY_LABELS[name] ?? name}</Badge>
                ))}
              </div>
            </div>
          ) : null}
          {versionError ? (
            <Notice tone="fail" compact>
              {versionError}
            </Notice>
          ) : null}
          {versions === null ? (
            <p className="page__muted">正在读取版本…</p>
          ) : versions.length === 0 ? (
            <p className="page__muted">没有支持 MC {minecraft || '这个游戏版本'} 的文件。</p>
          ) : (
            <ul className="install-list" aria-label={`${label}版本`}>
              {versions.map((version) => (
                <li key={version.id}>
                  <div className="install-row" role="group" aria-label={version.name}>
                    <span className="install-row__icon" aria-hidden="true">
                      <Download size={16} />
                    </span>
                    <span className="install-row__main">
                      <span className="install-row__name">{version.versionNumber}</span>
                      <span className="install-row__meta">
                        {version.gameVersions.slice(0, 4).join('、')} · {Math.max(1, Math.round(version.file.size / 1024))} KB
                        {projectType === 'shader' && version.loaders.length > 0 ? ` · ${version.loaders.join('、')}` : ''}
                      </span>
                    </span>
                    <Button size="sm" variant="primary" isDisabled={!target || installing === version.id} onPress={() => void install(version)}>
                      {installing === version.id ? '正在安装…' : '安装'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Sheet>
    </>
  )
}

function ModpackImport(): ReactElement {
  const [settings, setSettings] = useState<LauncherSettings | null>(null)
  const [folderChoice, setFolderChoice] = useState<string | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [summary, setSummary] = useState<ModpackSummary | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [name, setName] = useState('')
  const [customName, setCustomName] = useState(false)
  const [error, setError] = useState('')
  const [taskId, setTaskId] = useState<string | null>(null)
  const [task, setTask] = useState<TaskInfo | null>(null)

  useEffect(() => {
    let alive = true
    void window.craft.settings().then(
      (loaded) => alive && setSettings(loaded),
      () => alive && setSettings(null)
    )
    return () => {
      alive = false
    }
  }, [])

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
      if (next.id === taskId) setTask(next)
    })
    return () => {
      alive = false
      stop()
    }
  }, [taskId])

  const defaultName = summary ? `${summary.name ?? 'Modrinth 整合包'}${summary.versionId ? ` ${summary.versionId}` : ''}` : ''

  useEffect(() => {
    if (!customName) setName(defaultName)
  }, [customName, defaultName])

  const folder = folderChoice ?? settings?.selectedFolder ?? settings?.folders[0]?.path ?? null
  const busy = task?.state === 'running' || task?.state === 'queued'
  const canImport = !!folder && !!path && !!summary && name.trim().length > 0 && !busy

  const pick = async (): Promise<void> => {
    setError('')
    const picked = await window.craft.pickModpack()
    if (!picked) return
    setPath(picked)
    setSummary(null)
    setCustomName(false)
    await read(picked)
  }

  const read = async (target = path): Promise<void> => {
    if (!target) return
    setError('')
    setSummary(null)
    setInspecting(true)
    try {
      const value = await window.craft.inspectModpack(target)
      setSummary(value)
      setName(`${value.name ?? 'Modrinth 整合包'}${value.versionId ? ` ${value.versionId}` : ''}`)
    } catch (cause) {
      setError(cleanError(cause))
    } finally {
      setInspecting(false)
    }
  }

  const start = async (): Promise<void> => {
    if (!folder || !path) return
    setError('')
    setTask(null)
    setTaskId(null)
    try {
      setTaskId(await window.craft.importModpack({ folder, path, ...(name.trim() ? { name: name.trim() } : {}) }))
    } catch (cause) {
      setError(cleanError(cause))
    }
  }

  const progress = percentOf(task)
  const loaderLabel = summary ? (summary.loader === 'vanilla' ? '原版' : `${KIND_LABEL[summary.loader as InstallKind]} ${summary.loaderVersion ?? ''}`.trim()) : ''

  return (
    <>
      <PageHead title="整合包" description="导入 Modrinth 格式的 .mrpack，按包里的清单装好游戏、加载器与文件。" />
      <div className="install-step">
        <h2 className="install-step__title">选择整合包文件</h2>
        <div className="install-form">
          <TextField
            label="整合包路径"
            value={path ?? ''}
            placeholder="选择 .mrpack 文件，或直接填路径"
            onChange={(value) => {
              setPath(value.trim() ? value : null)
              setSummary(null)
            }}
          />
        </div>
        <div className="install-actions">
          <Button size="sm" icon={<FileArchive size={14} />} onPress={() => void pick()}>
            选择 .mrpack
          </Button>
          <Button size="sm" variant="ghost" isDisabled={!path || inspecting} onPress={() => void read()}>
            读取清单
          </Button>
          <span className="page__muted">支持 Modrinth 格式，CurseForge 整合包还没接。</span>
        </div>
        {inspecting ? <p className="page__muted">正在读取整合包清单…</p> : null}
        {summary ? (
          <ul className="install-list" aria-label="整合包信息">
            <li>
              <div className="install-row" role="group">
                <span className="install-row__icon" aria-hidden="true">
                  <Boxes size={16} />
                </span>
                <span className="install-row__main">
                  <span className="install-row__name">{summary.name ?? '未命名整合包'}</span>
                  <span className="install-row__meta">
                    {summary.versionId ?? '版本未知'} · MC {summary.minecraft} · {loaderLabel || '原版'} · {summary.files} 个文件 · {summary.overrides} 个覆盖文件
                  </span>
                </span>
              </div>
            </li>
          </ul>
        ) : null}
        {error ? (
          <Notice tone="fail" compact>
            {error}
          </Notice>
        ) : null}
      </div>
      {summary ? (
        <div className="install-step">
          <h2 className="install-step__title">安装到</h2>
          <div className="install-form">
            <TextField
              label="版本名称"
              value={name}
              placeholder={defaultName}
              onChange={(value) => {
                setCustomName(true)
                setName(value)
              }}
            />
            {settings && settings.folders.length === 0 ? (
              <p className="page__muted">添加游戏目录后才能导入。</p>
            ) : (
              <Select label="游戏目录" selectedKey={folder} onSelectionChange={(key) => key != null && setFolderChoice(String(key))}>
                {(settings?.folders ?? []).map((item) => (
                  <ListBoxItem key={item.path} id={item.path} textValue={item.name}>
                    {item.name}
                  </ListBoxItem>
                ))}
              </Select>
            )}
          </div>
          <div className="install-actions">
            <Button variant="primary" icon={<Download size={14} />} isDisabled={!canImport} onPress={() => void start()}>
              导入并安装
            </Button>
            <span className="page__muted">
              会装 MC {summary.minecraft} 与 {loaderLabel || '原版'}，再把 {summary.files} 个文件放进版本目录
            </span>
          </div>
          {task ? (
            <div className="install-progress" data-state={task.state} data-unit={task.progress?.unit ?? undefined}>
              {task.state === 'running' || task.state === 'queued' ? (
                <>
                  <ProgressBar aria-label="导入进度" label={task.detail ?? '正在导入'} showValue value={progress ?? 0} isIndeterminate={progress === null} tone="run" />
                  <div className="install-actions">
                    <span className="page__muted">{progressText(task.progress) ?? '正在准备'}</span>
                    <Button size="sm" variant="ghost" onPress={() => void window.craft.cancelTask(task.id)}>
                      取消导入
                    </Button>
                  </div>
                </>
              ) : null}
              {task.state === 'done' ? (
                <Notice tone="ok" compact>
                  {task.detail ?? '已导入'}，到启动页选择就能启动
                </Notice>
              ) : null}
              {task.state === 'cancelled' ? (
                <Notice tone="stall" compact>
                  {task.detail ?? '导入已取消'}
                </Notice>
              ) : null}
              {task.state === 'failed' ? (
                <Notice
                  tone="fail"
                  compact
                  action={
                    <Button size="sm" onPress={() => void start()}>
                      重试
                    </Button>
                  }
                >
                  {task.error ?? '导入失败'}
                </Notice>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

export function DownloadPage(): ReactElement {
  const [section, setSection] = useState<Section>('minecraft')
  const [settings, setSettings] = useState<LauncherSettings | null>(null)
  const [list, setList] = useState<MinecraftVersionList | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [group, setGroup] = useState<VersionGroup>('release')
  const [query, setQuery] = useState('')
  const [minecraft, setMinecraft] = useState<string | null>(null)
  const [kind, setKind] = useState<InstallKind>('vanilla')
  const [fabric, setFabric] = useState<LoaderVersions | null>(null)
  const [quilt, setQuilt] = useState<LoaderVersions | null>(null)
  const [forge, setForge] = useState<LoaderVersions | null>(null)
  const [neoforge, setNeoForge] = useState<LoaderVersions | null>(null)
  const [loadersLoading, setLoadersLoading] = useState(false)
  const [loadersError, setLoadersError] = useState('')
  const [forgeError, setForgeError] = useState('')
  const [neoforgeError, setNeoForgeError] = useState('')
  const [fabricVersion, setFabricVersion] = useState<string | null>(null)
  const [quiltVersion, setQuiltVersion] = useState<string | null>(null)
  const [forgeVersion, setForgeVersion] = useState<string | null>(null)
  const [neoforgeVersion, setNeoForgeVersion] = useState<string | null>(null)
  const [companions, setCompanions] = useState(true)
  const [folderChoice, setFolderChoice] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [customName, setCustomName] = useState(false)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [task, setTask] = useState<TaskInfo | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void window.craft.settings().then(
      (loaded) => alive && setSettings(loaded),
      () => alive && setSettings(null)
    )
    return () => {
      alive = false
    }
  }, [])

  const loadList = useCallback((): void => {
    setListLoading(true)
    setListError('')
    void window.craft.minecraftVersions().then(
      (value) => {
        setList(value)
        setListLoading(false)
      },
      (cause: unknown) => {
        setListError(cleanError(cause))
        setListLoading(false)
      }
    )
  }, [])

  useEffect(loadList, [loadList])

  useEffect(() => {
    if (!minecraft) {
      setFabric(null)
      setQuilt(null)
      setForge(null)
      setNeoForge(null)
      return
    }
    let alive = true
    setLoadersLoading(true)
    setLoadersError('')
    setForgeError('')
    setNeoForgeError('')
    setFabric(null)
    setQuilt(null)
    setForge(null)
    setNeoForge(null)
    void Promise.allSettled([
      window.craft.loaderVersions('fabric', minecraft),
      window.craft.loaderVersions('quilt', minecraft),
      window.craft.loaderVersions('forge', minecraft),
      window.craft.loaderVersions('neoforge', minecraft)
    ]).then(([fabricResult, quiltResult, forgeResult, neoforgeResult]) => {
      if (!alive) return
      if (fabricResult.status === 'fulfilled') setFabric(fabricResult.value)
      if (quiltResult.status === 'fulfilled') setQuilt(quiltResult.value)
      if (forgeResult.status === 'fulfilled') setForge(forgeResult.value)
      else setForgeError(cleanError(forgeResult.reason))
      if (neoforgeResult.status === 'fulfilled') setNeoForge(neoforgeResult.value)
      else setNeoForgeError(cleanError(neoforgeResult.reason))
      const rejected = [fabricResult, quiltResult].find((result) => result.status === 'rejected')
      if (rejected && rejected.status === 'rejected') setLoadersError(cleanError(rejected.reason))
      setLoadersLoading(false)
    })
    return () => {
      alive = false
    }
  }, [minecraft])

  useEffect(() => {
    setFabricVersion((current) => (current && fabric?.loaders.some((item) => item.version === current) ? current : (fabric?.recommended ?? null)))
  }, [fabric])

  useEffect(() => {
    setQuiltVersion((current) => (current && quilt?.loaders.some((item) => item.version === current) ? current : (quilt?.recommended ?? null)))
  }, [quilt])

  useEffect(() => {
    setForgeVersion((current) => (current && forge?.loaders.some((item) => item.version === current) ? current : (forge?.recommended ?? null)))
  }, [forge])

  useEffect(() => {
    setNeoForgeVersion((current) => (current && neoforge?.loaders.some((item) => item.version === current) ? current : (neoforge?.recommended ?? null)))
  }, [neoforge])

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
      if (next.id === taskId) setTask(next)
    })
    return () => {
      alive = false
      stop()
    }
  }, [taskId])

  const loaderVersion =
    kind === 'fabric' ? fabricVersion : kind === 'quilt' ? quiltVersion : kind === 'forge' ? forgeVersion : kind === 'neoforge' ? neoforgeVersion : null
  const defaultName = minecraft ? (kind === 'vanilla' ? minecraft : `${minecraft}-${KIND_LABEL[kind]} ${loaderVersion ?? ''}`.trim()) : ''

  useEffect(() => {
    if (!customName) setName(defaultName)
  }, [customName, defaultName])

  const folder = folderChoice ?? settings?.selectedFolder ?? settings?.folders[0]?.path ?? null
  const busy = task?.state === 'running' || task?.state === 'queued'
  const canInstall = !!folder && !!minecraft && name.trim().length > 0 && (kind === 'vanilla' || !!loaderVersion) && !busy

  const visible = useMemo(() => {
    if (!list) return []
    const needle = query.trim().toLowerCase()
    const filtered = list.versions.filter((entry) => entry.group === group && (!needle || entry.id.toLowerCase().includes(needle)))
    if (group !== 'release') return filtered
    return [...filtered].sort((a, b) => Number(b.latest) - Number(a.latest))
  }, [group, list, query])

  const pickVersion = (id: string): void => {
    setMinecraft(id)
    setCustomName(false)
    setError('')
    setTaskId(null)
  }

  const start = async (): Promise<void> => {
    if (!folder || !minecraft) return
    setError('')
    setTask(null)
    setTaskId(null)
    try {
      const id = await window.craft.install({
        folder,
        kind,
        minecraft,
        ...(loaderVersion ? { loader: loaderVersion } : {}),
        ...(kind === 'fabric' || kind === 'quilt' ? { companions } : {}),
        ...(name.trim() ? { name: name.trim() } : {})
      })
      setTaskId(id)
    } catch (cause) {
      setError(cleanError(cause))
    }
  }

  const cancel = (): void => {
    if (taskId) void window.craft.cancelTask(taskId)
  }

  const progress = percentOf(task)

  return (
    <SubNavLayout label="下载" groups={GROUPS} active={section} onChange={(id) => setSection(id)}>
      <div className="subpage">
        {section === 'mods' ? (
          <ModSearch />
        ) : section === 'resourcepacks' ? (
          <ContentBrowser
            projectType="resourcepack"
            title="资源包"
            description="从 Modrinth 搜索资源包，装到所选版本的 resourcepacks 目录。"
            icon={<Package size={16} />}
            emptyTitle="还没有能装资源包的版本"
          />
        ) : section === 'shaderpacks' ? (
          <ContentBrowser
            projectType="shader"
            title="光影"
            description="从 Modrinth 搜索光影，装到所选版本的 shaderpacks 目录。"
            icon={<Sparkles size={16} />}
            emptyTitle="还没有能装光影的版本"
          />
        ) : section === 'modpacks' ? (
          <ModpackImport />
        ) : (
          <>
            <PageHead title="安装 Minecraft" description="选好游戏版本与加载器，安装完成后可在启动页选择。默认从 BMCLAPI 下载，失败时换官方源。" />
            {settings === null ? (
              <p className="page__muted">正在读取设置…</p>
            ) : (
              <>
                {settings.folders.length === 0 ? (
                  <Notice tone="stall" compact>
                    还没有游戏目录，先到设置 → 游戏目录里添加一个，再回来安装。
                  </Notice>
                ) : null}
                <section className="install-step" aria-labelledby="install-version-title">
                  <h2 className="install-step__title" id="install-version-title">
                    选择游戏版本
                  </h2>
                  <div className="install-toolbar">
                    <div className="install-filter" role="group" aria-label="版本类型">
                      {GROUP_FILTERS.map((item) => (
                        <Button key={item.id} size="sm" variant={group === item.id ? 'secondary' : 'ghost'} aria-pressed={group === item.id} onPress={() => setGroup(item.id)}>
                          {item.label}
                        </Button>
                      ))}
                    </div>
                    <SearchField aria-label="搜索版本" className="install-search" placeholder="搜索版本" value={query} onChange={setQuery} />
                  </div>
                  {listLoading ? (
                    <p className="page__muted">正在获取版本清单…</p>
                  ) : listError ? (
                    <Notice
                      tone="fail"
                      compact
                      action={
                        <Button size="sm" onPress={loadList}>
                          重试
                        </Button>
                      }
                    >
                      {listError}
                    </Notice>
                  ) : visible.length === 0 ? (
                    <p className="page__muted">{query ? '没有匹配的版本。' : '这一类还没有版本。'}</p>
                  ) : (
                    <ul className="install-list" aria-label="Minecraft 版本">
                      {visible.map((entry) => (
                        <li key={entry.id}>
                          <button
                            type="button"
                            className="install-row"
                            aria-pressed={minecraft === entry.id}
                            data-selected={minecraft === entry.id ? '1' : undefined}
                            onClick={() => pickVersion(entry.id)}
                          >
                            <span className="install-row__icon" aria-hidden="true">
                              <Boxes size={16} />
                            </span>
                            <span className="install-row__main">
                              <span className="install-row__name">{entry.id}</span>
                              <span className="install-row__meta">
                                {GROUP_LABEL[entry.group]} · {entry.releaseTime ? entry.releaseTime.slice(0, 10) : '时间未知'}
                              </span>
                            </span>
                            {entry.latest ? <Badge tone="accent">最新</Badge> : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                {minecraft ? (
                  <section className="install-step" aria-labelledby="install-loader-title">
                    <h2 className="install-step__title" id="install-loader-title">
                      选择加载器
                    </h2>
                    {loadersLoading ? <p className="page__muted">正在获取加载器版本…</p> : null}
                    {loadersError ? (
                      <Notice tone="fail" compact>
                        {loadersError}
                      </Notice>
                    ) : null}
                    <ul className="install-loaders" aria-label="加载器">
                      <LoaderCard label="原版" hint="Minecraft 官方版本" selected={kind === 'vanilla'} disabled={false} onSelect={() => setKind('vanilla')} />
                      <LoaderCard
                        label="Fabric"
                        hint={fabric ? (fabric.loaders.length > 0 ? `${fabric.loaders.length} 个版本，推荐 ${fabric.recommended ?? '未定'}` : (fabric.reason ?? '没有可用版本')) : loadersLoading ? '正在获取版本…' : '没有可用版本'}
                        selected={kind === 'fabric'}
                        disabled={!fabric || fabric.loaders.length === 0}
                        onSelect={() => setKind('fabric')}
                      >
                        <Select aria-label="Fabric 版本" selectedKey={fabricVersion} onSelectionChange={(key) => key != null && setFabricVersion(String(key))}>
                          {(fabric?.loaders ?? []).map((item) => (
                            <ListBoxItem key={item.version} id={item.version} textValue={item.version}>
                              {item.stable ? item.version : `${item.version}（测试版）`}
                            </ListBoxItem>
                          ))}
                        </Select>
                        <Switch isSelected={companions} onChange={setCompanions}>
                          同时安装 Fabric API
                        </Switch>
                      </LoaderCard>
                      <LoaderCard
                        label="Quilt"
                        hint={quilt ? (quilt.loaders.length > 0 ? `${quilt.loaders.length} 个版本，推荐 ${quilt.recommended ?? '未定'}` : (quilt.reason ?? '没有可用版本')) : loadersLoading ? '正在获取版本…' : '没有可用版本'}
                        selected={kind === 'quilt'}
                        disabled={!quilt || quilt.loaders.length === 0}
                        onSelect={() => setKind('quilt')}
                      >
                        <Select aria-label="Quilt 版本" selectedKey={quiltVersion} onSelectionChange={(key) => key != null && setQuiltVersion(String(key))}>
                          {(quilt?.loaders ?? []).map((item) => (
                            <ListBoxItem key={item.version} id={item.version} textValue={item.version}>
                              {item.version}
                            </ListBoxItem>
                          ))}
                        </Select>
                        <Switch isSelected={companions} onChange={setCompanions}>
                          同时安装 QSL
                        </Switch>
                      </LoaderCard>
                      <LoaderCard
                        label="Forge"
                        hint={
                          forge
                            ? forge.loaders.length > 0
                              ? `${forge.loaders.length} 个版本，推荐 ${forge.recommended ?? '未定'}`
                              : (forge.reason ?? '没有可用版本')
                            : forgeError || (loadersLoading ? '正在获取版本…' : '没有可用版本')
                        }
                        selected={kind === 'forge'}
                        disabled={!forge || forge.loaders.length === 0}
                        onSelect={() => setKind('forge')}
                      >
                        <LoaderVersionPicker label="Forge" versions={forge?.loaders ?? []} recommended={forge?.recommended ?? null} selected={forgeVersion} onSelect={setForgeVersion} />
                        <p className="page__muted">按推荐 / 最新与版本分组，输入版本号可搜索。与 Fabric、Quilt 互斥。</p>
                        <p className="page__muted">安装时用 Java 运行官方安装处理器，会读设置里添加的 Java。</p>
                      </LoaderCard>
                      <LoaderCard
                        label="NeoForge"
                        hint={
                          neoforge
                            ? neoforge.loaders.length > 0
                              ? `${neoforge.loaders.length} 个版本，推荐 ${neoforge.recommended ?? '未定'}`
                              : (neoforge.reason ?? '没有可用版本')
                            : neoforgeError || (loadersLoading ? '正在获取版本…' : '没有可用版本')
                        }
                        selected={kind === 'neoforge'}
                        disabled={!neoforge || neoforge.loaders.length === 0}
                        onSelect={() => setKind('neoforge')}
                      >
                        <LoaderVersionPicker label="NeoForge" versions={neoforge?.loaders ?? []} recommended={neoforge?.recommended ?? null} selected={neoforgeVersion} onSelect={setNeoForgeVersion} />
                        <p className="page__muted">按推荐 / 最新与版本分组，输入版本号可搜索。与 Fabric、Quilt 互斥。</p>
                        <p className="page__muted">安装时用 Java 运行官方安装处理器，会读设置里添加的 Java。</p>
                      </LoaderCard>
                    </ul>
                  </section>
                ) : null}
                {minecraft ? (
                  <section className="install-step" aria-labelledby="install-target-title">
                    <h2 className="install-step__title" id="install-target-title">
                      名称与目录
                    </h2>
                    <div className="install-form">
                      <TextField
                        label="版本名称"
                        value={name}
                        placeholder={defaultName}
                        onChange={(value) => {
                          setCustomName(true)
                          setName(value)
                        }}
                      />
                      {settings.folders.length === 0 ? (
                        <p className="page__muted">添加游戏目录后才能安装。</p>
                      ) : (
                        <Select label="游戏目录" selectedKey={folder} onSelectionChange={(key) => key != null && setFolderChoice(String(key))}>
                          {settings.folders.map((item) => (
                            <ListBoxItem key={item.path} id={item.path} textValue={item.name}>
                              {item.name}
                            </ListBoxItem>
                          ))}
                        </Select>
                      )}
                    </div>
                    <div className="install-actions">
                      <Button variant="primary" icon={<Pickaxe size={14} />} isDisabled={!canInstall} onPress={() => void start()}>
                        安装
                      </Button>
                      <span className="page__muted">
                        {kind === 'vanilla' ? '原版' : `${KIND_LABEL[kind]} ${loaderVersion ?? ''}`} · {minecraft}
                      </span>
                    </div>
                    {task ? (
                      <div className="install-progress" data-state={task.state} data-unit={task.progress?.unit ?? undefined}>
                        {task.state === 'running' || task.state === 'queued' ? (
                          <>
                            <ProgressBar aria-label="安装进度" label={task.detail ?? '正在安装'} showValue value={progress ?? 0} isIndeterminate={progress === null} tone="run" />
                            <div className="install-actions">
                              <span className="page__muted">{progressText(task.progress) ?? '正在准备'}</span>
                              <Button size="sm" variant="ghost" onPress={cancel}>
                                取消安装
                              </Button>
                            </div>
                          </>
                        ) : null}
                        {task.state === 'done' ? (
                          <Notice tone="ok" compact>
                            {task.detail ?? '已安装'}，可在启动页选择
                          </Notice>
                        ) : null}
                        {task.state === 'cancelled' ? (
                          <Notice tone="stall" compact>
                            {task.detail && task.detail.startsWith('已取消') ? task.detail : '安装已取消'}
                          </Notice>
                        ) : null}
                        {task.state === 'failed' ? (
                          <Notice
                            tone="fail"
                            compact
                            action={
                              <Button size="sm" onPress={() => void start()}>
                                重试
                              </Button>
                            }
                          >
                            {task.error ?? '安装失败'}
                          </Notice>
                        ) : null}
                      </div>
                    ) : null}
                    {error ? (
                      <Notice
                        tone="fail"
                        compact
                        action={
                          <Button size="sm" onPress={() => void start()}>
                            重试
                          </Button>
                        }
                      >
                        {error}
                      </Notice>
                    ) : null}
                  </section>
                ) : null}
              </>
            )}
          </>
        )}
      </div>
    </SubNavLayout>
  )
}
