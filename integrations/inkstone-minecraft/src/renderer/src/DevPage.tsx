import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Camera, FileWarning, FolderOpen, FolderPlus, Hammer, Hand, MousePointerClick, Play, RefreshCw, RotateCcw, Send, Square, Terminal, Trash2, Upload } from 'lucide-react'
import { Badge, type BadgeTone } from '@yan/ui/Badge'
import { Button } from '@yan/ui/Button'
import { Checkbox } from '@yan/ui/Checkbox'
import { IconButton } from '@yan/ui/IconButton'
import { ListBoxItem } from '@yan/ui/ListBox'
import { Notice, type NoticeTone } from '@yan/ui/Notice'
import { Select } from '@yan/ui/Select'
import { SettingRow, SettingSection } from '@yan/ui/SettingRow'
import { TextField } from '@yan/ui/TextField'
import type { ApplyResult, CrashSummary, DevRunState, DevSessionInfo, DevStatusSnapshot, FabricVersionSet, MappingFlavor } from '../../shared/dev-api.ts'
import { PageHead, SubNavLayout, type SubNavGroup } from './SubNavLayout.tsx'

type Section = 'project' | 'run' | 'logs' | 'crashes'

const GROUPS: SubNavGroup<Section>[] = [
  {
    label: '项目',
    items: [{ id: 'project', label: '项目', icon: <FolderOpen size={16} /> }]
  },
  {
    label: '开发循环',
    items: [
      { id: 'run', label: '运行', icon: <Play size={16} /> },
      { id: 'logs', label: '日志', icon: <Terminal size={16} /> },
      { id: 'crashes', label: '崩溃', icon: <FileWarning size={16} /> }
    ]
  }
]

const RECENT_KEY = 'craft-dev:recent-projects'
const MAX_LOG_LINES = 2000
const RECENT_LIMIT = 8

const STATE_LABEL: Record<DevRunState, string> = {
  idle: '未启动',
  building: '构建中',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  exited: '已退出',
  crashed: '已崩溃'
}

const STATE_TONE: Record<DevRunState, BadgeTone> = {
  idle: 'neutral',
  building: 'run',
  starting: 'run',
  running: 'ok',
  stopping: 'ask',
  exited: 'neutral',
  crashed: 'fail'
}

const MAPPINGS: { id: MappingFlavor; label: string }[] = [
  { id: 'yarn', label: 'yarn' },
  { id: 'mojmap', label: 'mojmap' }
]

interface Note {
  tone: NoticeTone
  text: string
}

function sameDir(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function errorText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const cleaned = message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '').trim()
  return cleaned || fallback
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} 秒`
}

function restartDetail(result: ApplyResult): string {
  return (result.hotswap?.restartReasons ?? [])
    .map((item) => item.detail.trim())
    .filter((item) => item.length > 0)
    .join('；')
}

function applySummary(result: ApplyResult): string {
  const parts: string[] = [result.build.ok ? `编译 ${seconds(result.build.durationMs)}` : '编译失败']
  const swapped = result.hotswap?.swapped.length ?? 0
  const resources = result.changedAssets.length + result.changedData.length
  if (swapped > 0) parts.push(`热替换 ${swapped} 个类`)
  if (result.changedAssets.length > 0) parts.push(`资源改动 ${result.changedAssets.length} 个`)
  if (result.changedData.length > 0) parts.push(`数据改动 ${result.changedData.length} 个`)
  if (swapped === 0 && resources === 0 && !result.hotswap?.restartNeeded) parts.push('没有改动')
  if (result.resourcesReloaded) parts.push('资源已重载')
  if (result.dataReloaded) parts.push('数据已重载')
  const detail = restartDetail(result)
  if (result.restarted) parts.push(detail ? `已自动重启（${detail}）` : '已自动重启')
  else if (result.restartNeeded) parts.push(detail ? `需要重启（${detail}）` : '需要重启')
  return parts.join('，')
}

function timeText(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { hour12: false })
}

export function DevPage(): ReactElement {
  const [section, setSection] = useState<Section>('project')
  const [recent, setRecent] = useState<string[]>(() => readRecent())
  const [projectDir, setProjectDir] = useState<string | null>(null)
  const [status, setStatus] = useState<DevStatusSnapshot | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [shot, setShot] = useState<string | null>(null)
  const [crashes, setCrashes] = useState<CrashSummary[] | null>(null)
  const [autoRestart, setAutoRestart] = useState(true)
  const [command, setCommand] = useState('/time set day')
  const [output, setOutput] = useState<string[]>([])
  const [minecraft, setMinecraft] = useState('1.21.1')
  const [modId, setModId] = useState('mymod')
  const [packageName, setPackageName] = useState('com.example.mymod')
  const [modName, setModName] = useState('My Mod')
  const [targetDir, setTargetDir] = useState('')
  const [mappings, setMappings] = useState<MappingFlavor>('yarn')
  const [versions, setVersions] = useState<FabricVersionSet | null>(null)
  const [created, setCreated] = useState<string | null>(null)

  const projectRef = useRef<string | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    projectRef.current = projectDir
  }, [projectDir])

  useEffect(() => {
    const offSession = window.craftDev.onSession((session: DevSessionInfo) => {
      setStatus((prev) => (prev && sameDir(prev.session.projectDir, session.projectDir) && sameDir(session.projectDir, projectRef.current) ? { ...prev, session } : prev))
    })
    const offLog = window.craftDev.onLog((event) => {
      if (!sameDir(event.projectDir, projectRef.current)) return
      const fresh = event.text.split(/\r?\n/).filter((line) => line.length > 0)
      if (fresh.length === 0) return
      setLines((prev) => {
        const next = [...prev, ...fresh]
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
      })
    })
    return () => {
      offSession()
      offLog()
    }
  }, [])

  useEffect(() => {
    if (!projectDir) {
      setStatus(null)
      return
    }
    let alive = true
    setStatus(null)
    setLines([])
    setShot(null)
    setCrashes(null)
    setOutput([])
    setNote(null)
    void window.craftDev.status(projectDir).then(
      (snapshot) => {
        if (alive) setStatus(snapshot)
      },
      (error: unknown) => {
        if (alive) setNote({ tone: 'fail', text: errorText(error, '读取项目状态失败') })
      }
    )
    void window.craftDev.logs({ projectDir, lines: 200 }).then(
      (rows) => {
        if (alive && rows.length > 0) setLines(rows.slice(-MAX_LOG_LINES))
      },
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [projectDir])

  useEffect(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [lines, section])

  useEffect(() => {
    if (section !== 'crashes' || !projectDir) return
    let alive = true
    void window.craftDev.crashes(projectDir).then(
      (list) => {
        if (alive) setCrashes(list)
      },
      (error: unknown) => {
        if (alive) setNote({ tone: 'fail', text: errorText(error, '读取崩溃摘要失败') })
      }
    )
    return () => {
      alive = false
    }
  }, [section, projectDir])

  const remember = useCallback((dir: string): void => {
    setRecent((prev) => {
      const next = [dir, ...prev.filter((item) => !sameDir(item, dir))].slice(0, RECENT_LIMIT)
      try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
      } catch {
        undefined
      }
      return next
    })
  }, [])

  const selectProject = useCallback(
    (dir: string): void => {
      remember(dir)
      setProjectDir(dir)
      setSection('run')
    },
    [remember]
  )

  const run = useCallback(async (key: string, task: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setNote(null)
    try {
      await task()
    } catch (error) {
      setNote({ tone: 'fail', text: errorText(error, '操作失败') })
    } finally {
      setBusy(null)
    }
  }, [])

  const pickProject = useCallback(async (): Promise<void> => {
    try {
      const dir = await window.craftDev.pickProject()
      if (dir) selectProject(dir)
    } catch (error) {
      setNote({ tone: 'fail', text: errorText(error, '选择目录失败') })
    }
  }, [selectProject])

  const pickTarget = useCallback(async (): Promise<void> => {
    try {
      const dir = await window.craftDev.pickProject()
      if (dir) setTargetDir(dir)
    } catch (error) {
      setNote({ tone: 'fail', text: errorText(error, '选择目录失败') })
    }
  }, [])

  const session = status?.session ?? null
  const jbr = status?.jbr ?? null
  const state: DevRunState = session?.state ?? 'idle'
  const control = session?.control ?? null
  const owner = control?.owner ?? 'agent'
  const controlReady = state === 'running' && session?.companionReady === true
  const sessionMessage = session && (state === 'building' || state === 'starting' || state === 'stopping' || state === 'crashed') ? session.message : null
  const disabled = busy !== null

  const build = (): void => {
    if (!projectDir) return
    void run('build', async () => {
      const result = await window.craftDev.build(projectDir)
      setNote(result.ok ? { tone: 'ok', text: `构建完成，用时 ${seconds(result.durationMs)}` } : { tone: 'fail', text: result.errors[0] ?? '构建失败，请看日志' })
    })
  }

  const launch = (): void => {
    if (!projectDir) return
    void run('launch', async () => {
      const next = await window.craftDev.launch({ projectDir })
      setStatus((prev) => (prev ? { ...prev, session: next } : prev))
      setNote({ tone: 'info', text: '已发出启动命令，日志会持续刷新' })
    })
  }

  const stop = (): void => {
    if (!projectDir) return
    void run('stop', async () => {
      const next = await window.craftDev.stop(projectDir)
      setStatus((prev) => (prev ? { ...prev, session: next } : prev))
      setNote({ tone: 'info', text: '已停止开发客户端' })
    })
  }

  const restart = (): void => {
    if (!projectDir) return
    void run('restart', async () => {
      const next = await window.craftDev.restart({ projectDir })
      setStatus((prev) => (prev ? { ...prev, session: next } : prev))
      setNote({ tone: 'info', text: '已发出重启命令' })
    })
  }

  const switchControl = (next: 'agent' | 'user'): void => {
    if (!projectDir) return
    void run('control', async () => {
      const updated = await window.craftDev.setControl(projectDir, next)
      setStatus((prev) => (prev ? { ...prev, session: updated } : prev))
      setNote({ tone: 'ok', text: next === 'user' ? '已切换到你来操作，Agent 的写操作会被拒绝' : '已交还 Agent 控制' })
    })
  }

  const apply = (): void => {
    if (!projectDir) return
    void run('apply', async () => {
      const result = await window.craftDev.apply(projectDir, autoRestart)
      const notes = result.notes.filter((item) => item.trim()).join('；')
      const text = `${applySummary(result)}${notes ? `。${notes}` : ''}`
      setNote({ tone: result.build.ok ? (result.restartNeeded && !result.restarted ? 'ask' : 'ok') : 'fail', text })
    })
  }

  const reload = (): void => {
    if (!projectDir) return
    void run('reload', async () => {
      const result = await window.craftDev.reloadResources(projectDir)
      setNote({ tone: result.resourcesReloaded ? 'ok' : 'ask', text: applySummary(result) })
    })
  }

  const send = (): void => {
    if (!projectDir || !command.trim()) return
    void run('command', async () => {
      const result = await window.craftDev.command(projectDir, command.trim())
      const rows = result.ok ? result.output : [result.error ?? '命令执行失败']
      setOutput(rows.length > 0 ? rows : ['已执行，游戏没有返回文字。命令可能打开了游戏界面，用截图查看。'])
      setNote(result.ok ? { tone: 'ok', text: `已执行 ${result.command}` } : { tone: 'fail', text: result.error ?? '命令执行失败' })
    })
  }

  const screenshot = (): void => {
    if (!projectDir) return
    void run('shot', async () => {
      const dataUrl = await window.craftDev.screenshot(projectDir)
      setShot(dataUrl)
      setNote({ tone: 'ok', text: '已取到游戏截图' })
    })
  }

  const loadVersions = (): void => {
    void run('versions', async () => {
      const set = await window.craftDev.fabricVersions(minecraft.trim(), mappings)
      setVersions(set)
      setNote({ tone: 'ok', text: `Loader ${set.loader}，Gradle ${set.gradle}` })
    })
  }

  const create = (): void => {
    void run('create', async () => {
      const result = await window.craftDev.createFabricProject({
        minecraftVersion: minecraft.trim(),
        modId: modId.trim(),
        packageName: packageName.trim(),
        modName: modName.trim() || undefined,
        targetDir: targetDir.trim(),
        mappings,
        versions: versions ?? undefined
      })
      setVersions(result.versions)
      setCreated(result.projectDir)
      setNote({ tone: 'ok', text: `已创建 ${result.files.length} 个文件，项目已选中` })
      selectProject(result.projectDir)
    })
  }

  const refreshCrashes = (): void => {
    if (!projectDir) return
    void run('crashes', async () => {
      const list = await window.craftDev.crashes(projectDir)
      setCrashes(list)
      setNote({ tone: list.length ? 'ask' : 'ok', text: list.length ? `找到 ${list.length} 份崩溃报告` : '没有崩溃报告' })
    })
  }

  const busyLabel = (key: string, label: string): string => (busy === key ? '进行中…' : label)

  return (
    <SubNavLayout<Section> label="开发" groups={GROUPS} active={section} onChange={setSection}>
      <div className="subpage">
        <PageHead
          title={section === 'project' ? '开发项目' : section === 'run' ? '开发运行' : section === 'logs' ? '开发日志' : '崩溃报告'}
          description={projectDir ?? '选择或新建一个 Fabric mod 项目'}
          actions={
            <Button size="sm" icon={<FolderOpen size={14} />} isDisabled={disabled} onPress={() => void pickProject()}>
              选择项目目录
            </Button>
          }
        />
        {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}

        {section === 'project' ? (
          <>
            <SettingSection title="最近项目">
              {recent.length === 0 ? <SettingRow label="还没有打开过项目" description="用右上角的选择项目目录，或在下面新建。" /> : null}
              {recent.map((dir) => (
                <SettingRow key={dir} label={dir.split(/[\\/]/).filter(Boolean).pop() ?? dir} description={dir}>
                  {sameDir(dir, projectDir) ? <Badge tone="accent">当前</Badge> : null}
                  <Button size="sm" variant="ghost" isDisabled={disabled} onPress={() => selectProject(dir)}>
                    打开
                  </Button>
                  <IconButton
                    aria-label={`从最近项目移除 ${dir}`}
                    size="sm"
                    onPress={() => {
                      setRecent((prev) => {
                        const next = prev.filter((item) => item !== dir)
                        try {
                          window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
                        } catch {
                          undefined
                        }
                        return next
                      })
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </SettingRow>
              ))}
            </SettingSection>
            <SettingSection title="新建 Fabric 项目" description="版本号从 Fabric 与 Gradle 官方元数据读取，创建前先点读取版本。">
              <div className="dev-form">
                <TextField label="Minecraft 版本" size="sm" value={minecraft} onChange={setMinecraft} />
                <TextField label="mod id" size="sm" value={modId} onChange={setModId} />
                <TextField label="包名" size="sm" value={packageName} onChange={setPackageName} />
                <TextField label="显示名" size="sm" value={modName} onChange={setModName} />
                <TextField label="目标目录" size="sm" value={targetDir} onChange={setTargetDir} />
                <div className="dev-field">
                  <span className="dev-field__label">映射</span>
                  <Select aria-label="映射" selectedKey={mappings} onSelectionChange={(key) => key != null && setMappings(key as MappingFlavor)}>
                    {MAPPINGS.map((item) => (
                      <ListBoxItem key={item.id} id={item.id} textValue={item.label}>
                        {item.label}
                      </ListBoxItem>
                    ))}
                  </Select>
                </div>
              </div>
              <div className="dev-actions">
                <Button size="sm" icon={<RefreshCw size={14} />} isDisabled={disabled} onPress={loadVersions}>
                  {busyLabel('versions', '读取版本')}
                </Button>
                <Button size="sm" variant="ghost" icon={<FolderOpen size={14} />} isDisabled={disabled} onPress={() => void pickTarget()}>
                  选择目标目录
                </Button>
                <Button size="sm" variant="primary" icon={<FolderPlus size={14} />} isDisabled={disabled} onPress={create}>
                  {busyLabel('create', '新建项目')}
                </Button>
              </div>
              {versions ? (
                <div className="dev-meta">
                  <span>Loader {versions.loader}</span>
                  <span>Yarn {versions.yarn ?? '无'}</span>
                  <span>Fabric API {versions.fabricApi}</span>
                  <span>Loom {versions.loom}</span>
                  <span>Gradle {versions.gradle}</span>
                  <span>Java {versions.javaRelease}</span>
                </div>
              ) : (
                <p className="dev-muted">还没有读取版本。读取后新建会直接用这一组版本号。</p>
              )}
              {created ? <p className="dev-muted">刚创建：{created}</p> : null}
            </SettingSection>
          </>
        ) : null}

        {section === 'run' ? (
          projectDir ? (
            <>
              <SettingSection title="会话">
                <SettingRow
                  label={
                    <span className="dev-state__label">
                      状态 <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
                    </span>
                  }
                  description={sessionMessage ? <span className="dev-message">{sessionMessage}</span> : undefined}
                >
                  <span className="dev-mono">{session?.pid ? `pid ${session.pid}` : '没有进程'}</span>
                </SettingRow>
                <SettingRow label="Minecraft 版本" description={session?.world ? `测试世界 ${session.world}` : '启动后自动建平坦测试世界'}>
                  <span className="dev-mono">{session?.minecraftVersion ?? '未知'}</span>
                </SettingRow>
                <SettingRow label="Java 运行时" description={session?.javaPath ?? '启动时按版本自动挑选'} />
                <SettingRow label="热替换能力">
                  <Badge tone={session?.mixinHotswap ? 'ok' : 'neutral'}>{session?.mixinHotswap ? 'Mixin 方法体可热替换' : '没有挂 Mixin agent'}</Badge>
                  <Badge tone={session?.enhancedRedefinition ? 'ok' : 'neutral'}>{session?.enhancedRedefinition ? 'JBR 增强重定义' : '仅方法体'}</Badge>
                  <Badge tone={session?.jbr ? 'accent' : 'neutral'}>{session?.jbr ? 'JBR' : '普通 JDK'}</Badge>
                </SettingRow>
                <SettingRow label="调试与伴随 mod" description={session?.companionReady ? `伴随 mod 端口 ${session.companionPort}` : '伴随 mod 未连接'}>
                  <span className="dev-mono">JDWP {session?.jdwpPort ?? '—'}</span>
                </SettingRow>
                <SettingRow
                  label={
                    <span className="dev-state__label">
                      控制方 <Badge tone={owner === 'user' ? 'accent' : 'ok'}>{owner === 'user' ? '你' : 'Agent'}</Badge>
                    </span>
                  }
                  description={
                    controlReady
                      ? owner === 'user'
                        ? '你正在操作，Agent 的命令和重启会被拒绝；在游戏里按 F8 或点右侧按钮交还'
                        : 'Agent 正在操作，游戏窗口里忽略鼠标键盘（不抓鼠标）；在游戏里按 F8 或点右侧按钮接管'
                      : '启动开发客户端并且伴随 mod 连接后才能切换控制方'
                  }
                >
                  <span className="dev-mono">{control && control.changedAt > 0 ? timeText(control.changedAt) : '—'}</span>
                  {owner === 'user' ? (
                    <Button size="sm" icon={<Hand size={14} />} isDisabled={disabled || !controlReady} onPress={() => switchControl('agent')}>
                      {busyLabel('control', '交还 Agent')}
                    </Button>
                  ) : (
                    <Button size="sm" icon={<MousePointerClick size={14} />} isDisabled={disabled || !controlReady} onPress={() => switchControl('user')}>
                      {busyLabel('control', '我来操作')}
                    </Button>
                  )}
                </SettingRow>
              </SettingSection>

              {jbr && !jbr.found ? (
                <Notice tone="ask" title="没有找到 JetBrains Runtime">
                  普通 JDK 只能热替换方法体，新增方法或字段需要重启。装上 JBR 21 后放到 runtimes 目录，或设置 INKSTONE_JBR 指向它。来源：JetBrains 官方 JBR releases。
                </Notice>
              ) : null}

              <SettingSection title="操作">
                <div className="dev-actions">
                  <Button size="sm" icon={<Hammer size={14} />} isDisabled={disabled} onPress={build}>
                    {busyLabel('build', '构建')}
                  </Button>
                  <Button size="sm" variant="primary" icon={<Play size={14} />} isDisabled={disabled} onPress={launch}>
                    {busyLabel('launch', '启动')}
                  </Button>
                  <Button size="sm" icon={<Square size={14} />} isDisabled={busy === 'stop'} onPress={stop}>
                    {busyLabel('stop', '停止')}
                  </Button>
                  <Button size="sm" icon={<RotateCcw size={14} />} isDisabled={disabled} onPress={restart}>
                    {busyLabel('restart', '重启')}
                  </Button>
                  <Button size="sm" icon={<Upload size={14} />} isDisabled={disabled} onPress={apply}>
                    {busyLabel('apply', '应用改动')}
                  </Button>
                  <Button size="sm" icon={<RefreshCw size={14} />} isDisabled={disabled} onPress={reload}>
                    {busyLabel('reload', '重载资源')}
                  </Button>
                </div>
                <div className="dev-inline">
                  <Checkbox isSelected={autoRestart} onChange={setAutoRestart}>
                    应用后需要重启时自动重启
                  </Checkbox>
                </div>
              </SettingSection>

              <SettingSection title="命令">
                <div className="dev-inline">
                  <TextField aria-label="游戏命令" size="sm" value={command} onChange={setCommand} className="dev-inline__field" />
                  <Button size="sm" icon={<Send size={14} />} isDisabled={disabled} onPress={send}>
                    {busyLabel('command', '执行')}
                  </Button>
                </div>
                {output.length > 0 ? (
                  <div className="dev-output">
                    {output.map((line, index) => (
                      <div key={index} className="dev-output__line">
                        {line}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="dev-muted">命令在开发客户端里执行，权限 4，输出显示在这里。</p>
                )}
              </SettingSection>

              <SettingSection title="截图">
                <div className="dev-actions">
                  <Button size="sm" icon={<Camera size={14} />} isDisabled={disabled} onPress={screenshot}>
                    {busyLabel('shot', '截图')}
                  </Button>
                </div>
                {shot ? <img className="dev-shot" src={shot} alt="游戏截图" /> : <p className="dev-muted">还没有截图，启动后点截图。</p>}
              </SettingSection>
            </>
          ) : (
            <Notice tone="info">先在项目分区选择或新建一个项目。</Notice>
          )
        ) : null}

        {section === 'logs' ? (
          projectDir ? (
            <>
              <div className="dev-actions">
                <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onPress={() => setLines([])}>
                  清空
                </Button>
                <span className="dev-muted">
                  已显示 {lines.length} 行，最多保留 {MAX_LOG_LINES} 行
                </span>
              </div>
              <div className="dev-log" ref={logRef} role="log" aria-label="开发日志">
                {lines.length === 0 ? <div className="dev-log__line dev-muted">还没有日志。启动开发客户端后这里会持续刷新。</div> : null}
                {lines.map((line, index) => (
                  <div key={index} className="dev-log__line">
                    {line}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Notice tone="info">先在项目分区选择或新建一个项目。</Notice>
          )
        ) : null}

        {section === 'crashes' ? (
          projectDir ? (
            <>
              <div className="dev-actions">
                <Button size="sm" icon={<RefreshCw size={14} />} isDisabled={disabled} onPress={refreshCrashes}>
                  {busyLabel('crashes', '刷新摘要')}
                </Button>
                {crashes ? <span className="dev-muted">共 {crashes.length} 份</span> : null}
              </div>
              {crashes === null ? <p className="dev-muted">正在读取崩溃报告…</p> : null}
              {crashes?.length === 0 ? <Notice tone="ok">没有崩溃报告。</Notice> : null}
              {crashes?.map((crash) => (
                <section key={crash.file} className="dev-crash">
                  <header className="dev-crash__head">
                    <span className="dev-crash__file">{crash.file}</span>
                    <span className="dev-muted">{timeText(crash.at)}</span>
                  </header>
                  <p className="dev-crash__text">{crash.description ?? '没有描述'}</p>
                  {crash.exception ? <p className="dev-crash__text">{crash.exception}</p> : null}
                  {crash.suspectFrames.length > 0 ? (
                    <div className="dev-output">
                      {crash.suspectFrames.slice(0, 6).map((frame) => (
                        <div key={frame} className="dev-output__line">
                          {frame}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <details className="dev-crash__more">
                    <summary>报告开头</summary>
                    <pre className="dev-crash__head-text">{crash.head.slice(0, 4000)}</pre>
                  </details>
                </section>
              ))}
            </>
          ) : (
            <Notice tone="info">先在项目分区选择或新建一个项目。</Notice>
          )
        ) : null}
      </div>
    </SubNavLayout>
  )
}
