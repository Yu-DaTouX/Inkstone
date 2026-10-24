import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Copy, FolderOpen } from 'lucide-react'
import { Button } from '@yan/ui/Button'
import { SegmentedControl } from '@yan/ui/SegmentedControl'
import { Switch } from '@yan/ui/Switch'
import { SearchField } from '@yan/ui/TextField'
import type { LaunchStatus, LogLine } from '../../shared/api.ts'
import { Sheet } from './overlays.tsx'

const KEEP_LINES = 2000

type Level = 'all' | 'warn' | 'error'

const LEVELS = [
  { value: 'all', label: '全部' },
  { value: 'warn', label: '警告以上' },
  { value: 'error', label: '只看错误' }
] as const

export function lineLevel(line: LogLine): 'error' | 'warn' | 'info' {
  if (/\/(ERROR|FATAL)\]|\[(ERROR|FATAL)\]|^\s*(Caused by:|Exception in thread|\tat |at [\w$.]+\()/.test(line.text) || (line.stream === 'err' && !/\/(INFO|WARN)\]/.test(line.text))) return 'error'
  if (/\/WARN\]|\[WARN\]/.test(line.text)) return 'warn'
  return 'info'
}

export function useGameLogs(status: LaunchStatus | null): LogLine[] {
  const [logs, setLogs] = useState<LogLine[]>([])
  useEffect(() => {
    void window.craft.logs().then(setLogs)
    return window.craft.onLog((line) => setLogs((current) => [...current.slice(-(KEEP_LINES - 1)), line]))
  }, [])
  useEffect(() => {
    if (status?.state === 'starting') setLogs([])
  }, [status?.state])
  return logs
}

interface Props {
  open: boolean
  logs: LogLine[]
  folder?: string | null
  versionId?: string | null
  onClose(): void
}

export function LogSheet({ open, logs, folder, versionId, onClose }: Props): ReactElement {
  const [level, setLevel] = useState<Level>('all')
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const [copied, setCopied] = useState(false)
  const end = useRef<HTMLDivElement>(null)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return logs.filter((line) => {
      const kind = lineLevel(line)
      if (level === 'error' && kind !== 'error') return false
      if (level === 'warn' && kind === 'info') return false
      return !needle || line.text.toLowerCase().includes(needle)
    })
  }, [logs, level, query])

  const errorCount = useMemo(() => logs.filter((line) => lineLevel(line) === 'error').length, [logs])
  const filtered = level !== 'all' || query.trim().length > 0
  const copyLines = filtered ? visible : logs

  useEffect(() => {
    if (open && follow) end.current?.scrollIntoView({ block: 'end' })
  }, [open, follow, visible.length])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="游戏日志"
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            icon={<FolderOpen size={14} />}
            isDisabled={!folder || !versionId}
            onPress={() => {
              if (folder && versionId) void window.craft.openFolder(folder, versionId, 'logs')
            }}
          >
            打开文件夹
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Copy size={14} />}
            isDisabled={copyLines.length === 0}
            onPress={() => void navigator.clipboard.writeText(copyLines.map((line) => line.text).join('\n')).then(() => setCopied(true))}
          >
            {copied ? '已复制' : filtered ? `复制这 ${copyLines.length} 行` : '复制全部'}
          </Button>
        </>
      }
    >
      <div className="log-tools">
        <SegmentedControl label="日志级别" value={level} options={LEVELS} onChange={setLevel} />
        <SearchField aria-label="搜索日志" placeholder="搜索" value={query} onChange={setQuery} className="log-tools__search" />
        <Switch isSelected={follow} onChange={setFollow}>
          跟随
        </Switch>
      </div>
      <p className="log-counts">
        共 {logs.length} 行
        {filtered ? `，显示 ${visible.length} 行` : ''}
        {errorCount > 0 ? `，其中 ${errorCount} 行错误` : ''}
      </p>
      <div className="log-view" role="log" tabIndex={0} aria-label="日志内容">
        {logs.length === 0 ? <div className="log-view__empty">启动游戏后，日志会出现在这里。</div> : null}
        {logs.length > 0 && visible.length === 0 ? <div className="log-view__empty">没有符合条件的行。</div> : null}
        {visible.map((line, index) => (
          <div key={`${line.at}-${index}`} className="log-view__line" data-stream={line.stream} data-level={lineLevel(line)}>
            {line.text}
          </div>
        ))}
        <div ref={end} />
      </div>
    </Sheet>
  )
}
