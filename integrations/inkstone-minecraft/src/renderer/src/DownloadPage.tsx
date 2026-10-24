import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { Boxes, Package, Pickaxe, Puzzle, Sparkles } from 'lucide-react'
import { Badge } from '@yan/ui/Badge'
import { Button } from '@yan/ui/Button'
import { ListBoxItem } from '@yan/ui/ListBox'
import { Notice } from '@yan/ui/Notice'
import { ProgressBar } from '@yan/ui/Progress'
import { Select } from '@yan/ui/Select'
import { Switch } from '@yan/ui/Switch'
import { SearchField, TextField } from '@yan/ui/TextField'
import type { InstallKind, LauncherSettings, LoaderVersions, MinecraftVersionEntry, MinecraftVersionList, TaskInfo, TaskProgress } from '../../shared/api.ts'
import { EmptyBlock, PageHead, SubNavLayout, type SubNavGroup } from './SubNavLayout.tsx'
import { ModSearch } from './ModSearch.tsx'

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

const PAGES: Record<Exclude<Section, 'minecraft'>, { title: string; description: string; icon: ReactNode; empty: string }> = {
  mods: {
    title: 'Mod',
    description: '从 Modrinth 搜索并安装到指定版本。',
    icon: <Puzzle size={20} />,
    empty: '搜索、筛选加载器与游戏版本、自动处理前置会在这里。'
  },
  resourcepacks: {
    title: '资源包',
    description: '从 Modrinth 搜索资源包。',
    icon: <Package size={20} />,
    empty: '资源包搜索会在这里。'
  },
  shaderpacks: {
    title: '光影',
    description: '从 Modrinth 搜索光影包。',
    icon: <Sparkles size={20} />,
    empty: '光影搜索会在这里，并提示需要的光影加载器。'
  },
  modpacks: {
    title: '整合包',
    description: '安装 Modrinth 整合包，或导入本地 .mrpack 与 CurseForge 整合包。',
    icon: <Boxes size={20} />,
    empty: '整合包搜索与导入会在这里。'
  }
}

const GROUP_FILTERS: { id: VersionGroup; label: string }[] = [
  { id: 'release', label: '正式版' },
  { id: 'snapshot', label: '快照' },
  { id: 'old', label: '远古' }
]

const GROUP_LABEL: Record<VersionGroup, string> = { release: '正式版', snapshot: '快照', old: '远古' }

const KIND_LABEL: Record<InstallKind, string> = { vanilla: '原版', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }

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
  const busy = task?.state === 'running'
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
  const page = section === 'minecraft' ? null : PAGES[section]

  return (
    <SubNavLayout label="下载" groups={GROUPS} active={section} onChange={(id) => setSection(id)}>
      <div className="subpage">
        {section === 'mods' ? (
          <ModSearch />
        ) : page ? (
          <>
            <PageHead title={page.title} description={page.description} />
            <EmptyBlock icon={page.icon} title="还在开发中">
              {page.empty}
            </EmptyBlock>
          </>
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
                        <Select aria-label="Forge 版本" selectedKey={forgeVersion} onSelectionChange={(key) => key != null && setForgeVersion(String(key))}>
                          {(forge?.loaders ?? []).map((item) => (
                            <ListBoxItem key={item.version} id={item.version} textValue={item.version}>
                              {item.version}
                            </ListBoxItem>
                          ))}
                        </Select>
                        <p className="page__muted">与 Fabric、Quilt 互斥，一个版本只能选一个加载器。</p>
                        <p className="page__muted">安装时用 Java 运行官方安装处理器，Java 不够会提示去设置添加。</p>
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
                        <Select aria-label="NeoForge 版本" selectedKey={neoforgeVersion} onSelectionChange={(key) => key != null && setNeoForgeVersion(String(key))}>
                          {(neoforge?.loaders ?? []).map((item) => (
                            <ListBoxItem key={item.version} id={item.version} textValue={item.version}>
                              {item.stable ? item.version : `${item.version}（测试版）`}
                            </ListBoxItem>
                          ))}
                        </Select>
                        <p className="page__muted">与 Fabric、Quilt 互斥，一个版本只能选一个加载器。</p>
                        <p className="page__muted">安装时用 Java 运行官方安装处理器，Java 不够会提示去设置添加。</p>
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
                        {task.state === 'running' ? (
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
                            安装已取消
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
