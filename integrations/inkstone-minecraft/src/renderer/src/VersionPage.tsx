import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Archive, Camera, FileText, FolderOpen, Image, LayoutDashboard, Package, Puzzle, SlidersHorizontal, Sparkles, Wrench } from 'lucide-react'
import { Badge } from '@yan/ui/Badge'
import { Button } from '@yan/ui/Button'
import { ListBoxItem } from '@yan/ui/ListBox'
import { Notice } from '@yan/ui/Notice'
import { ProgressBar } from '@yan/ui/Progress'
import { Select } from '@yan/ui/Select'
import { SettingRow, SettingSection } from '@yan/ui/SettingRow'
import { Switch } from '@yan/ui/Switch'
import { TextField } from '@yan/ui/TextField'
import type { FolderTarget, InstanceInfo, JavaEntry, LauncherSettings, TaskInfo } from '../../shared/api.ts'
import type { InstanceOverride, InstanceOverview } from '../../shared/mods-api.ts'
import { InstanceIcon } from './InstanceIcon.tsx'
import { instanceMeta, LOADER_LABEL, memoryLabel } from './labels.ts'
import { cleanError, formatSize, ModList } from './ModList.tsx'
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

const RESOURCE_PAGES: Partial<Record<Section, { target: FolderTarget; title: string; empty: string; icon: ReactNode }>> = {
  resourcepacks: { target: 'resourcepacks', title: '资源包', empty: '资源包列表与启用顺序会在这里。', icon: <Package size={20} /> },
  shaderpacks: { target: 'shaderpacks', title: '光影', empty: '光影包列表会在这里。', icon: <Sparkles size={20} /> },
  saves: { target: 'saves', title: '存档', empty: '存档列表、备份与导入会在这里。', icon: <Archive size={20} /> },
  screenshots: { target: 'screenshots', title: '截图', empty: '截图墙会在这里。', icon: <Image size={20} /> }
}

interface Props {
  folder: string
  versionId: string
  settings: LauncherSettings
  onBack(): void
  onOpenLogs(): void
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

function OverridePane({ folder, versionId, overview, javas, onSaved }: OverridePaneProps): ReactElement {
  const [draft, setDraft] = useState<InstanceOverride>(overview.override)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => setDraft(overview.override), [overview.override])

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
        <SettingRow label="启动后进入服务器" description="填服务器地址，留空则不自动进入。">
          <TextField aria-label="服务器地址" size="sm" value={draft.server ?? ''} placeholder="例如 play.example.com" onChange={(value) => patch({ server: value.trim() ? value.trim() : null })} />
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
  onOpen(target: FolderTarget): Promise<void>
  onGo(section: Section): void
}

function OverviewPane({ overview, onOpen, onGo }: OverviewPaneProps): ReactElement {
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
          {overview.problems.map((problem) => (
            <Notice
              key={`${problem.kind}-${problem.text}`}
              tone={problem.kind === 'files' || problem.kind === 'json' ? 'fail' : 'stall'}
              compact
              action={
                <Button size="sm" onPress={() => onGo(problem.kind === 'files' || problem.kind === 'json' ? 'repair' : problem.kind === 'deps' ? 'mods' : 'settings')}>
                  {problem.kind === 'files' || problem.kind === 'json' ? '去修复' : problem.kind === 'deps' ? '看 Mod' : '去设置'}
                </Button>
              }
            >
              {problem.text}
            </Notice>
          ))}
        </div>
      ) : null}
      <SettingSection title="版本信息">
        <SettingRow label="Minecraft">{overview.minecraftVersion ?? '未知'}</SettingRow>
        <SettingRow label="加载器">
          {LOADER_LABEL[overview.loader as InstanceInfo['loader']] ?? overview.loader}
          {overview.loaderVersion ? ` ${overview.loaderVersion}` : ''}
        </SettingRow>
        <SettingRow label="Mod">{overview.modCount > 0 ? `${overview.modCount} 个` : '没有'}</SettingRow>
        <SettingRow label="占用空间">{formatSize(overview.sizeBytes)}</SettingRow>
        <SettingRow label="需要 Java">{overview.javaMajor ? `Java ${overview.javaMajor}` : '按版本自动判断'}</SettingRow>
        <SettingRow label="最近游玩">{timeLabel(overview.lastPlayedAt)}</SettingRow>
      </SettingSection>
      <SettingSection title="启动设置">
        <SettingRow label="Java" description={overview.source.java === 'instance' ? '这个版本单独指定' : '跟随全局'}>
          {overview.effective.javaPath ?? '自动挑选'}
        </SettingRow>
        <SettingRow label="最大内存" description={overview.source.memory === 'instance' ? '这个版本单独指定' : '跟随全局'}>
          {memoryLabel(overview.effective.maxMemoryMb)}
        </SettingRow>
        <SettingRow label="版本隔离">
          <Badge tone={overview.isolated ? 'accent' : 'neutral'}>{overview.isolated ? '已隔离' : '共用'}</Badge>
        </SettingRow>
        <SettingRow label="游戏目录" description={overview.gameDir} />
      </SettingSection>
    </>
  )
}

export function VersionPage({ folder, versionId, settings, onBack, onOpenLogs }: Props): ReactElement {
  const [section, setSection] = useState<Section>('overview')
  const [instance, setInstance] = useState<InstanceInfo | null | undefined>(undefined)
  const [overview, setOverview] = useState<InstanceOverview | null>(null)
  const [javas, setJavas] = useState<JavaEntry[]>([])
  const [notice, setNotice] = useState('')

  const loadInstance = useCallback((): void => {
    void window.craft.instances(folder).then(
      (list) => setInstance(list.find((item) => item.id === versionId) ?? null),
      () => setInstance(null)
    )
    void window.craft.instanceOverview(folder, versionId).then(setOverview, () => setOverview(null))
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
      setNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const openButton = (target: FolderTarget, name: string, primary = false): ReactElement => (
    <Button variant={primary ? 'primary' : 'secondary'} size="sm" icon={<FolderOpen size={14} />} onPress={() => void open(target, name)}>
      打开{name}文件夹
    </Button>
  )

  const header = (
    <div className="version-head">
      <InstanceIcon folder={folder} versionId={versionId} size={28} />
      <span className="version-head__text">
        <span className="version-head__name" title={versionId}>
          {versionId}
        </span>
        <span className="version-head__meta">{instance ? `${LOADER_LABEL[instance.loader]} · ${instance.minecraftVersion ?? '?'}` : ''}</span>
      </span>
    </div>
  )

  const resource = RESOURCE_PAGES[section]

  return (
    <SubNavLayout label="版本管理" groups={GROUPS} active={section} onChange={(id) => setSection(id)} header={header} onBack={onBack} backLabel="返回版本列表">
      <div className="subpage">
        {notice ? (
          <Notice tone="stall" compact>
            {notice}
          </Notice>
        ) : null}
        {instance === undefined ? (
          <p className="page__muted">正在读取版本…</p>
        ) : instance === null ? (
          <EmptyBlock title="找不到这个版本" actions={<Button onPress={onBack}>返回版本列表</Button>}>
            它可能已被移走或删除。
          </EmptyBlock>
        ) : section === 'overview' ? (
          overview ? (
            <OverviewPane overview={overview} onOpen={open} onGo={setSection} />
          ) : (
            <>
              <PageHead title={instance.id} description={instanceMeta(instance)} actions={<>{openButton('version', '版本')}{openButton('game', '游戏')}</>} />
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
        ) : resource ? (
          <>
            <PageHead title={resource.title} actions={openButton(resource.target, resource.title)} />
            <EmptyBlock icon={resource.icon} title="还在开发中" actions={openButton(resource.target, resource.title, true)}>
              {resource.empty}现在可以先打开文件夹手动管理。
            </EmptyBlock>
          </>
        ) : (
          <>
            <PageHead
              title="日志与崩溃"
              actions={
                <Button size="sm" icon={<FileText size={14} />} onPress={onOpenLogs}>
                  本次游戏日志
                </Button>
              }
            />
            <SettingSection title="文件夹">
              <SettingRow label="游戏日志" description="logs">
                {openButton('logs', '日志')}
              </SettingRow>
              <SettingRow label="崩溃报告" description="crash-reports">
                {openButton('crash-reports', '崩溃报告')}
              </SettingRow>
            </SettingSection>
            <EmptyBlock icon={<FileText size={20} />} title="崩溃分析还在开发中">
              之后会列出历次崩溃，并给出可能的原因和处理建议。
            </EmptyBlock>
          </>
        )}
      </div>
    </SubNavLayout>
  )
}
