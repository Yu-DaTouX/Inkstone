import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { Download, ExternalLink, Puzzle, Search } from 'lucide-react'
import { Badge } from '@yan/ui/Badge'
import { Button } from '@yan/ui/Button'
import { ListBoxItem } from '@yan/ui/ListBox'
import { Notice } from '@yan/ui/Notice'
import { ProgressBar } from '@yan/ui/Progress'
import { Select } from '@yan/ui/Select'
import { SearchField } from '@yan/ui/TextField'
import type { InstanceInfo, LauncherSettings, TaskInfo } from '../../shared/api.ts'
import type { ContentCategory } from '../../shared/download-api.ts'
import type { ModrinthHit, ModrinthProject, ModrinthSearchResult, ModrinthSort, ModrinthVersion } from '../../shared/mods-api.ts'
import { cleanError, formatSize } from './ModList.tsx'
import { Sheet } from './overlays.tsx'
import { EmptyBlock, PageHead } from './SubNavLayout.tsx'

interface Target {
  folder: string
  folderName: string
  id: string
  loader: string
  minecraftVersion: string | null
}

const LOADERS = [
  { id: 'fabric', label: 'Fabric' },
  { id: 'quilt', label: 'Quilt' },
  { id: 'forge', label: 'Forge' },
  { id: 'neoforge', label: 'NeoForge' }
]

const SORTS: Array<{ id: ModrinthSort; label: string }> = [
  { id: 'relevance', label: '相关' },
  { id: 'downloads', label: '下载量' },
  { id: 'updated', label: '更新时间' }
]

const CATEGORY_LABELS: Record<string, string> = {
  adventure: '冒险',
  cursed: '搞怪',
  decoration: '装饰',
  economy: '经济',
  equipment: '装备',
  food: '食物',
  'game-mechanics': '机制',
  library: '前置库',
  magic: '魔法',
  management: '管理',
  minigame: '小游戏',
  mobs: '生物',
  optimization: '优化',
  social: '社交',
  storage: '存储',
  technology: '科技',
  transportation: '交通',
  utility: '实用',
  worldgen: '世界生成'
}

const PAGE_SIZE = 20

function targetKey(target: Target): string {
  return `${target.folder}|${target.id}`
}

function downloadsLabel(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

function categoryLabel(name: string): string {
  return CATEGORY_LABELS[name] ?? name
}

interface Props {
  onInstalled?(versionFileId: string): void
}

export function ModSearch({ onInstalled }: Props = {}): ReactElement {
  const [settings, setSettings] = useState<LauncherSettings | null>(null)
  const [instances, setInstances] = useState<InstanceInfo[]>([])
  const [targetKeyValue, setTargetKeyValue] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searchText, setSearchText] = useState('')
  const [sort, setSort] = useState<ModrinthSort>('relevance')
  const [category, setCategory] = useState<string | null>(null)
  const [categories, setCategories] = useState<ContentCategory[]>([])
  const [loader, setLoader] = useState<string>('fabric')
  const [minecraft, setMinecraft] = useState<string>('')
  const [results, setResults] = useState<ModrinthSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
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
    void window.craft.downloadCategories('mod').then(
      (list) => alive && setCategories(list),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!settings) return
    const folder = settings.selectedFolder ?? settings.folders[0]?.path
    if (!folder) return
    let alive = true
    void window.craft.instances(folder).then(
      (list) => alive && setInstances(list.filter((item) => item.loader !== 'vanilla' && item.loader !== 'unknown')),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [settings])

  const targets = useMemo<Target[]>(() => {
    if (!settings) return []
    const folderName = (path: string): string => settings.folders.find((item) => item.path === path)?.name ?? path
    return instances.map((instance) => ({
      folder: instance.folder,
      folderName: folderName(instance.folder),
      id: instance.id,
      loader: instance.loader,
      minecraftVersion: instance.minecraftVersion
    }))
  }, [instances, settings])

  useEffect(() => {
    if (targetKeyValue && targets.some((target) => targetKey(target) === targetKeyValue)) return
    const preferred = settings?.selectedVersion ? targets.find((target) => target.id === settings.selectedVersion) : undefined
    const next = preferred ?? targets[0]
    if (!next) return
    setTargetKeyValue(targetKey(next))
    setLoader(next.loader)
    setMinecraft(next.minecraftVersion ?? '')
  }, [settings, targetKeyValue, targets])

  const target = targets.find((item) => targetKey(item) === targetKeyValue) ?? null

  const followTarget = (next: Target): void => {
    setTargetKeyValue(targetKey(next))
    setLoader(next.loader)
    setMinecraft(next.minecraftVersion ?? '')
  }

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
        if (installing) onInstalled?.(installing)
      }
      if (next.state === 'failed') {
        setNotice(next.error ?? '安装失败')
        setInstalling(null)
      }
      if (next.state === 'cancelled') {
        setNotice('安装已取消')
        setInstalling(null)
      }
    })
    return () => {
      alive = false
      stop()
    }
  }, [taskId, onInstalled, installing])

  const request = useCallback(
    (offset: number) => ({
      projectType: 'mod' as const,
      query: searchText,
      loader,
      minecraft: minecraft.trim() || null,
      category,
      sort,
      limit: PAGE_SIZE,
      offset
    }),
    [category, loader, minecraft, searchText, sort]
  )

  useEffect(() => {
    const timer = setTimeout(() => setSearchText(query), 350)
    return () => clearTimeout(timer)
  }, [query])

  const search = useCallback(
    (offset: number, append: boolean): void => {
      if (append) setLoadingMore(true)
      else setLoading(true)
      setError('')
      void window.craft.downloadSearch(request(offset)).then(
        (result) => {
          setResults((current) => (append && current ? { ...result, hits: [...current.hits, ...result.hits] } : result))
          setLoading(false)
          setLoadingMore(false)
        },
        (cause: unknown) => {
          setError(cleanError(cause))
          setLoading(false)
          setLoadingMore(false)
        }
      )
    },
    [request]
  )

  useEffect(() => {
    if (!settings) return
    search(0, false)
  }, [settings, loader, minecraft, sort, category, searchText, search])

  const openProject = async (hit: ModrinthHit): Promise<void> => {
    setOpenHit(hit)
    setProject(null)
    setVersions(null)
    setVersionError('')
    try {
      const [detail, list] = await Promise.all([
        window.craft.modProject(hit.projectId).catch(() => null),
        window.craft.downloadVersions(hit.projectId, loader, minecraft.trim() || null).catch((cause: unknown) => {
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
      setTaskId(await window.craft.modInstall({ folder: target.folder, versionId: target.id, versionFileId: version.id }))
    } catch (cause) {
      setInstalling(null)
      setNotice(cleanError(cause))
    }
  }

  const hits = results?.hits ?? []
  const canLoadMore = !!results && results.hits.length < results.totalHits

  return (
    <>
      <PageHead
        title="Mod"
        description="从 Modrinth 搜索 Mod，连同需要的前置一起装进指定版本。"
        actions={
          <Button size="sm" icon={<Search size={14} />} onPress={() => search(0, false)} isDisabled={loading}>
            搜索
          </Button>
        }
      />
      {notice ? (
        <Notice tone={notice.includes('失败') || notice.includes('不可用') ? 'fail' : 'stall'} compact>
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
      {targets.length === 0 ? (
        <EmptyBlock icon={<Puzzle size={20} />} title="还没有能装 Mod 的版本">
          先在下载页装一个 Fabric、Quilt、Forge 或 NeoForge 版本，再回来这里。
        </EmptyBlock>
      ) : (
        <>
          <div className="l5-filters">
            <SearchField aria-label="搜索 Mod" placeholder="搜索 Modrinth" value={query} onChange={setQuery} onSubmit={() => search(0, false)} />
            <Select aria-label="加载器" selectedKey={loader} onSelectionChange={(key) => key != null && setLoader(String(key))}>
              {LOADERS.map((item) => (
                <ListBoxItem key={item.id} id={item.id} textValue={item.label}>
                  {item.label}
                </ListBoxItem>
              ))}
            </Select>
            <Select aria-label="游戏版本" selectedKey={minecraft || null} onSelectionChange={(key) => key != null && setMinecraft(String(key))} placeholder="游戏版本">
              {[...new Set(targets.map((item) => item.minecraftVersion).filter((value): value is string => !!value))].map((value) => (
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
                <ListBoxItem key={item.name} id={item.name} textValue={categoryLabel(item.name)}>
                  {categoryLabel(item.name)}
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
            <Select
              aria-label="安装到"
              selectedKey={targetKeyValue}
              onSelectionChange={(key) => {
                const next = targets.find((item) => targetKey(item) === String(key))
                if (next) followTarget(next)
              }}
            >
              {targets.map((item) => (
                <ListBoxItem key={targetKey(item)} id={targetKey(item)} textValue={`${item.folderName} ${item.id}`}>
                  {`${item.folderName} · ${item.id}`}
                </ListBoxItem>
              ))}
            </Select>
          </div>
          {target ? (
            <p className="page__muted">
              装到 {target.folderName} · {target.id}：{target.loader} {target.minecraftVersion ?? '版本未知'}，搜索按这个加载器与游戏版本筛选。
            </p>
          ) : null}
          {loading ? <p className="page__muted">正在搜索 Modrinth…</p> : null}
          {error ? (
            <Notice
              tone="fail"
              compact
              action={
                <Button size="sm" onPress={() => search(0, false)}>
                  重试
                </Button>
              }
            >
              {error}
            </Notice>
          ) : null}
          {!loading && !error && hits.length === 0 ? <p className="page__muted">没有找到 Mod，换个关键词或清掉分类再试。</p> : null}
          {hits.length > 0 ? (
            <ul className="install-list" aria-label="Modrinth 搜索结果">
              {hits.map((hit) => (
                <li key={hit.projectId}>
                  <button type="button" className="install-row" data-selected={openHit?.projectId === hit.projectId ? '1' : undefined} onClick={() => void openProject(hit)}>
                    <span className="install-row__icon" aria-hidden="true">
                      {hit.iconUrl ? <img className="mod-row__icon" src={hit.iconUrl} alt="" width={32} height={32} /> : <Puzzle size={16} />}
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
          {canLoadMore ? (
            <div className="install-actions">
              <Button size="sm" variant="ghost" isDisabled={loadingMore} onPress={() => search(hits.length, true)}>
                {loadingMore ? '正在加载…' : '加载更多'}
              </Button>
              <span className="page__muted">
                {hits.length} / {results?.totalHits ?? 0}
              </span>
            </div>
          ) : null}
        </>
      )}
      <Sheet
        open={!!openHit}
        title={openHit?.title ?? 'Mod 详情'}
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
          <p className="page__muted">
            {target ? `装到 ${target.folderName} · ${target.id}（${target.loader} ${target.minecraftVersion ?? ''}）` : '先选一个要装到的版本'}
          </p>
          {project ? (
            <div className="mod-search__detail">
              <p className="page__muted">{project.description}</p>
              <div className="mod-search__badges">
                {project.categories.slice(0, 8).map((name) => (
                  <Badge key={name}>{categoryLabel(name)}</Badge>
                ))}
              </div>
              <p className="page__muted">{downloadsLabel(project.downloads)} 次下载</p>
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
            <p className="page__muted">没有支持 {loader} {minecraft || '这个游戏版本'} 的文件。</p>
          ) : (
            <ul className="install-list" aria-label="Mod 版本">
              {versions.map((version) => (
                <li key={version.id}>
                  <div className="install-row" role="group" aria-label={version.name}>
                    <span className="install-row__icon" aria-hidden="true">
                      <Download size={16} />
                    </span>
                    <span className="install-row__main">
                      <span className="install-row__name">{version.versionNumber}</span>
                      <span className="install-row__meta">
                        {version.gameVersions.slice(0, 4).join('、')} · {version.loaders.join('、')} · {formatSize(version.file.size)}
                        {version.dependencies.some((item) => item.kind === 'required') ? ' · 带前置' : ''}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="primary"
                      isDisabled={!target || task?.state === 'running' || installing === version.id}
                      onPress={() => void install(version)}
                    >
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
