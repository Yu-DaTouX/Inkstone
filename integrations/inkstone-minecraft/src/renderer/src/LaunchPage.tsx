import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { FileText, Play } from 'lucide-react'
import { Badge } from '@yan/ui/Badge'
import { Button } from '@yan/ui/Button'
import { Notice } from '@yan/ui/Notice'
import { StatusDot } from '@yan/ui/StatusDot'
import type { InstanceInfo, LauncherSettings, LaunchStatus } from '../../shared/api.ts'
import type { CrashAction, CrashDiagnosis } from '../../shared/crash-api.ts'
import type { PreflightReport } from '../../shared/launch-api.ts'
import { AccountCarousel } from './AccountCarousel.tsx'
import { AddAccount } from './AddAccount.tsx'
import { CrashDialog } from './CrashDialog.tsx'
import { LaunchCard } from './LaunchCard.tsx'
import { canLaunchWith, instanceMeta, STATE_DOT, STATE_LABEL } from './labels.ts'
import { VersionList } from './VersionList.tsx'

interface Props {
  settings: LauncherSettings
  status: LaunchStatus | null
  apply(next: Promise<LauncherSettings>): Promise<void>
  onImport(): void
  onManage(folder: string, versionId: string): void
  onOpenLogs(): void
  onOpenSettings(section: 'accounts' | 'java' | 'game'): void
}

function cleanError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function LaunchPage({ settings, status, apply, onImport, onManage, onOpenLogs, onOpenSettings }: Props): ReactElement {
  const [fresh, setFresh] = useState<LauncherSettings | null>(null)
  const current = fresh ?? settings
  const folder = current.selectedFolder ?? current.folders[0]?.path ?? null
  const [instances, setInstances] = useState<InstanceInfo[] | null>(null)
  const [instancesError, setInstancesError] = useState('')
  const [scan, setScan] = useState(0)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [report, setReport] = useState<PreflightReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [crash, setCrash] = useState<CrashDiagnosis | null>(null)
  const [crashBusy, setCrashBusy] = useState<string | null>(null)
  const [crashResult, setCrashResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [lastCrash, setLastCrash] = useState<CrashDiagnosis | null>(null)
  const [dismissedCrash, setDismissedCrash] = useState<string | null>(null)

  useEffect(() => {
    setFresh(null)
  }, [settings])

  useEffect(() => {
    void window.craft.settings().then(setFresh, () => undefined)
  }, [])

  useEffect(() => {
    setInstances(null)
    setInstancesError('')
    if (!folder) return
    let alive = true
    void window.craft.instances(folder).then(
      (list) => alive && setInstances(list),
      (cause: unknown) => {
        if (!alive) return
        setInstances([])
        setInstancesError(cleanError(cause))
      }
    )
    return () => {
      alive = false
    }
  }, [folder, scan])

  useEffect(
    () =>
      window.craft.onInstancesChanged((changed) => {
        if (!folder || changed.toLowerCase() === folder.toLowerCase()) setScan((value) => value + 1)
        void window.craft.settings().then(setFresh)
      }),
    [folder]
  )

  useEffect(
    () =>
      window.craft.onCrash((diagnosis) => {
        setReport(null)
        setCrashResult(null)
        setCrash(diagnosis)
      }),
    []
  )

  const selected = useMemo(() => instances?.find((item) => item.id === current.selectedVersion) ?? instances?.find((item) => !item.error) ?? null, [instances, current.selectedVersion])
  const account = current.accounts.find((item) => item.id === current.selectedAccountId) ?? null
  const busy = status?.state === 'starting' || status?.state === 'running'
  const showAdd = adding || current.accounts.length === 0
  const blocker = !account ? '先添加一个账号' : !canLaunchWith(account) ? '正版与外置登录还在接入，先切到离线账号启动' : !selected ? '先在右侧选一个版本' : ''
  const steps = status?.steps ?? []
  const warnings = report?.items.filter((item) => item.level === 'warn') ?? []

  useEffect(() => {
    const versionId = selected?.id
    if (!folder || !versionId) {
      setLastCrash(null)
      return
    }
    let alive = true
    void window.craft.crashLatest(folder, versionId).then(
      (value) => alive && setLastCrash(value),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [folder, selected?.id, crash, status?.state])

  const launch = async (versionId: string, ignoreWarnings = false): Promise<void> => {
    if (!folder || !account || !canLaunchWith(account) || busy || checking) return
    setError('')
    if (!ignoreWarnings) {
      setChecking(true)
      setReport(null)
      try {
        const next = await window.craft.preflight({ folder, versionId })
        if (next.blocked || next.items.some((item) => item.level === 'warn')) {
          setReport(next)
          return
        }
      } catch (cause) {
        setError(cleanError(cause))
        return
      } finally {
        setChecking(false)
      }
    }
    setReport(null)
    try {
      if (versionId !== current.selectedVersion) await apply(window.craft.updateSettings({ selectedVersion: versionId, selectedFolder: folder }))
      const result = await window.craft.launch({ folder, versionId, accountId: account.id, ignoreWarnings })
      if (result.state === 'failed' && result.error) setError(result.error)
    } catch (cause) {
      setError(cleanError(cause))
    }
  }

  const runCrashAction = async (action: CrashAction): Promise<void> => {
    if (!crash || !folder) return
    setCrashResult(null)
    if (action.kind === 'mods' || action.kind === 'repair') {
      onManage(folder, crash.versionId)
      setCrash(null)
      return
    }
    setCrashBusy(action.kind)
    try {
      if (action.kind === 'export') {
        const exported = await window.craft.crashExport(folder, crash.versionId, crash.id)
        setCrashResult(exported ? { ok: true, message: `诊断包已导出：${exported.path}` } : { ok: false, message: '找不到这份崩溃记录' })
      } else {
        const result = await window.craft.crashAction({ folder, versionId: crash.versionId, diagnosisId: crash.id, kind: action.kind, value: action.value })
        setCrashResult(result)
        if (result.ok) setDismissedCrash(crash.id)
      }
    } catch (cause) {
      setCrashResult({ ok: false, message: cleanError(cause) })
    } finally {
      setCrashBusy(null)
    }
  }

  return (
    <div className="launch">
      <aside className="launch__side" aria-label="账号与启动">
        <section className="side-account">
          {showAdd ? (
            <AddAccount
              canGoBack={current.accounts.length > 0}
              onBack={() => setAdding(false)}
              onAddOffline={async (name) => {
                await apply(window.craft.addOfflineAccount(name))
                setAdding(false)
              }}
            />
          ) : (
            <AccountCarousel
              accounts={current.accounts}
              selectedId={current.selectedAccountId}
              onSelect={(id) => void apply(window.craft.selectAccount(id))}
              onAdd={() => setAdding(true)}
              onRemove={(id) => void apply(window.craft.removeAccount(id))}
            />
          )}
        </section>
        <section className="side-launch">
          <div className="side-launch__version">
            <span className="side-launch__label">当前版本</span>
            <span className="side-launch__name">{selected?.id ?? '未选择'}</span>
            {selected ? <span className="side-launch__meta">{instanceMeta(selected)}</span> : null}
            {selected?.isolated ? <Badge className="side-launch__badge">版本隔离</Badge> : null}
          </div>
          {busy && status ? (
            <LaunchCard
              status={status}
              steps={steps}
              effective={status.effective ?? null}
              runningSince={status.runningSince ?? null}
              onCancel={() => void window.craft.stop()}
              onStop={() => void window.craft.stop()}
              onLogs={onOpenLogs}
            />
          ) : (
            <>
              <Button
                variant="primary"
                block
                className="side-launch__go"
                icon={<Play size={14} />}
                isDisabled={!!blocker || checking}
                onPress={() => selected && void launch(selected.id)}
              >
                {checking ? '正在检查…' : '启动游戏'}
              </Button>
              <div className="side-launch__foot">
                <span className="side-launch__state">
                  <StatusDot kind={STATE_DOT[status?.state ?? 'idle']} />
                  {blocker || STATE_LABEL[status?.state ?? 'idle']}
                </span>
                <Button variant="ghost" size="sm" icon={<FileText size={14} />} onPress={onOpenLogs}>
                  日志
                </Button>
              </div>
            </>
          )}
          {report?.blocked ? (
            <Notice tone="fail" compact title="启动前检查没通过">
              <ul className="side-launch__issues">
                {report.items
                  .filter((item) => item.level === 'block')
                  .map((item) => (
                    <li key={item.id}>
                      {item.title}
                      {item.detail ? `：${item.detail}` : ''}
                    </li>
                  ))}
              </ul>
              <div className="side-launch__notice-actions">
                {report.items.some((item) => item.level === 'block' && item.id === 'java') ? (
                  <Button size="sm" variant="ghost" onPress={() => onOpenSettings('java')}>
                    去设置 Java
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onPress={() => folder && onManage(folder, report.versionId)}>
                  去修复版本
                </Button>
                <Button size="sm" variant="ghost" onPress={() => setReport(null)}>
                  先不启动
                </Button>
              </div>
            </Notice>
          ) : null}
          {report && !report.blocked && warnings.length > 0 ? (
            <Notice tone="stall" compact title="启动前检查有提醒">
              <ul className="side-launch__issues">
                {warnings.map((item) => (
                  <li key={item.id}>
                    {item.title}
                    {item.detail ? `：${item.detail}` : ''}
                  </li>
                ))}
              </ul>
              <div className="side-launch__notice-actions">
                <Button size="sm" variant="primary" onPress={() => selected && void launch(selected.id, true)}>
                  仍然启动
                </Button>
                {warnings.some((item) => item.id === 'deps' || item.id === 'duplicates') ? (
                  <Button size="sm" variant="ghost" onPress={() => folder && onManage(folder, report.versionId)}>
                    打开 Mod 管理
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onPress={() => setReport(null)}>
                  先不启动
                </Button>
              </div>
            </Notice>
          ) : null}
          {lastCrash && lastCrash.id !== dismissedCrash && !crash && !busy ? (
            <Notice
              tone="fail"
              compact
              title={`上次崩溃：${lastCrash.rule?.title ?? '没认出原因'}`}
              action={
                <Button size="sm" variant="ghost" onPress={() => setCrash(lastCrash)}>
                  查看
                </Button>
              }
            />
          ) : null}
          {error ? (
            <Notice tone="fail" compact>
              {error}
            </Notice>
          ) : null}
        </section>
      </aside>
      <section className="launch__main" aria-label="版本">
        <VersionList
          folders={current.folders}
          folder={folder}
          instances={folder ? instances : []}
          error={instancesError}
          selectedId={selected?.id ?? null}
          onFolder={(path) => void apply(window.craft.updateSettings({ selectedFolder: path, selectedVersion: null }))}
          onSelect={(id) => void apply(window.craft.updateSettings({ selectedVersion: id, selectedFolder: folder }))}
          onLaunch={(id) => void launch(id)}
          onManage={(id) => folder && onManage(folder, id)}
          onPickFolder={() =>
            void window.craft.pickFolder().then((path) => {
              if (!path) return
              const folders = current.folders.some((item) => item.path.toLowerCase() === path.toLowerCase()) ? current.folders : [...current.folders, { name: path, path }]
              return apply(window.craft.updateSettings({ folders, selectedFolder: path, selectedVersion: null }))
            })
          }
          onImport={onImport}
          onRefresh={() => setScan((value) => value + 1)}
        />
      </section>
      <CrashDialog
        diagnosis={crash}
        busy={crashBusy}
        result={crashResult}
        onClose={() => {
          setCrash(null)
          if (status?.state === 'failed') onOpenLogs()
        }}
        onAction={(action) => void runCrashAction(action)}
      />
    </div>
  )
}
