import { useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { ToolDetail } from './MessageParts'
import type { FileDiff, UIToolCall, WorkspaceChangeFile, WorkspaceChanges } from '../../../../shared/ipc'

export function detailKind(name: string): 'command' | 'change' | 'result' {
  if (name === 'bash' || name === 'powershell' || name === 'shell' || name === 'run' || name === 'exec') return 'command'
  if (
    name === 'edit' ||
    name === 'write' ||
    name === 'multi_edit' ||
    name === 'multiEdit' ||
    name === 'apply_patch' ||
    name === 'patch'
  )
    return 'change'
  return 'result'
}

function callPath(call: UIToolCall): string {
  const a = (call.args ?? {}) as Record<string, unknown>
  if (typeof a.path === 'string') return a.path
  if (typeof a.file_path === 'string') return a.file_path
  if (typeof a.filePath === 'string') return a.filePath
  return ''
}

function readFileDiff(details: unknown): FileDiff | null {
  if (!details || typeof details !== 'object') return null
  const d = (details as { fileDiff?: unknown }).fileDiff
  if (!d || typeof d !== 'object') return null
  const diff = d as Partial<FileDiff>
  if (typeof diff.path !== 'string' || !diff.before || !diff.after || typeof diff.patch !== 'string') return null
  return diff as FileDiff
}

export function FileChangeStats({ call }: { call: UIToolCall }) {
  const diff = readFileDiff(call.details)
  if (!diff || call.status === 'running' || call.status === 'pending') return null
  return <>
    {Number.isFinite(diff.added) && diff.added >= 0 ? <span className="fd-stat add" data-testid="file-diff-added">+{diff.added}</span> : null}
    {Number.isFinite(diff.removed) && diff.removed >= 0 ? <span className="fd-stat del" data-testid="file-diff-removed">−{diff.removed}</span> : null}
  </>
}

export function readWorkspaceChanges(details: unknown): WorkspaceChanges | null {
  if (!details || typeof details !== 'object') return null
  const raw = (details as { workspaceChanges?: unknown }).workspaceChanges
  if (!raw || typeof raw !== 'object') return null
  const wc = raw as Partial<WorkspaceChanges>
  if (typeof wc.root !== 'string' || !Array.isArray(wc.files)) return null
  return wc as WorkspaceChanges
}

export function FileChangeDetail({ call, showHeader = true }: { call: UIToolCall; showHeader?: boolean }) {
  const t = useT()
  const path = callPath(call)
  const running = call.status === 'running' || call.status === 'pending'
  const failed = call.status === 'error'
  const diff = readFileDiff(call.details)

  const stateClass = running ? 'run' : failed ? 'err' : 'ok'
  const stateText = running ? t('term.running') : failed ? t('tool.failed') : t('term.ok')

  const tooLarge = !!(diff?.before.tooLarge || diff?.after.tooLarge)
  const statusText =
    diff?.status === 'created'
      ? t('tool.diffCreated')
      : diff?.status === 'deleted'
        ? t('tool.diffDeleted')
        : diff?.status === 'unchanged'
          ? t('tool.diffUnchanged')
          : ''

  return (
    <div className="fd" data-testid="file-change-detail">
      {showHeader ? <div className="fd-head">
        <Icon name="file" size={12} />
        <span className="fd-path" title={path || diff?.path}>
          {path || diff?.path || call.name}
        </span>
        {statusText ? <span className="fd-status">{statusText}</span> : null}
        <span className="spacer" />
        <FileChangeStats call={call} />
        <span className={`fd-state ${stateClass}`}>{stateText}</span>
      </div> : null}
      {failed ? <div className="fd-note">{t('tool.notApplied')}</div> : null}
      <div className="fd-body">
        {diff ? (
          <>
            {tooLarge ? <div className="fd-note">{t('tool.diffTooLarge')}</div> : null}
            {diff.patch ? (
              <pre className="fd-patch" data-testid="file-diff-patch">
                {diff.patch.split('\n').map((line, index) => <span key={index} className="ui-diff-line" data-kind={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'context'}>{line}{'\n'}</span>)}
              </pre>
            ) : !tooLarge && diff.status !== 'unchanged' ? (
              <div className="fd-note">{t('tool.diffNoPatch')}</div>
            ) : null}
          </>
        ) : (
          <>
            <div className="fd-note">{t('tool.diffUnavailable')}</div>
            <ToolDetail call={call} />
          </>
        )}
      </div>
    </div>
  )
}

export function WorkspaceChangesDetail({ changes }: { changes: WorkspaceChanges }) {
  const t = useT()
  const [openPath, setOpenPath] = useState<string | null>(null)
  const hidden = Math.max(0, changes.total - changes.files.length)
  const unknownKey = changes.unknown ? WS_UNKNOWN_KEY[changes.unknown] : null
  const withLineCount = changes.files.some((f) => f.added >= 0 || f.removed >= 0)
  const openFile = openPath ? changes.files.find((f) => f.path === openPath) : undefined

  return (
    <div className="wsc" data-testid="workspace-changes" data-unknown={changes.unknown ?? ''}>
      <div className="wsc-head">
        <Icon name="change" size={12} />
        <span className="wsc-title" data-testid="ws-title">
          {t('tool.wsChanges', { n: changes.total })}
        </span>
        <span className="spacer" />
        <span className="wsc-scanned">{t('tool.wsScanned', { n: changes.scanned })}</span>
      </div>
      <div className="wsc-root" title={changes.root}>
        {t('tool.wsRoot')}：{changes.root}
      </div>
      {unknownKey ? (
        <div className="wsc-warn" data-testid="ws-unknown">
          {t(unknownKey)}
        </div>
      ) : null}
      <ul className="wsc-list">
        {changes.files.map((f) => (
          <li key={f.path} className="wsc-item" data-status={f.status} data-path={f.path}>
            <span className="wsc-status">{wsStatusText(t, f.status)}</span>
            <span className="wsc-path" title={f.path}>
              {f.path}
            </span>
            <span className="spacer" />
            {f.added >= 0 ? <span className="fd-stat add">+{f.added}</span> : null}
            {f.removed >= 0 ? <span className="fd-stat del">-{f.removed}</span> : null}
            {f.patch ? (
              <button
                className="wsc-toggle"
                onClick={() => setOpenPath(openPath === f.path ? null : f.path)}
                aria-expanded={openPath === f.path}
                title={f.path}
              >
                <Icon name="chevron-right" size={12} className={openPath === f.path ? 'chev on' : 'chev'} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {hidden > 0 ? <div className="wsc-note">{t('tool.wsMore', { n: hidden })}</div> : null}
      {changes.files.length > 0 && !withLineCount ? <div className="wsc-note">{t('tool.wsNoLine')}</div> : null}
      {openFile?.patch ? (
        <pre className="fd-patch" data-testid="ws-patch">
          {openFile.patch}
        </pre>
      ) : null}
    </div>
  )
}

function wsStatusText(t: ReturnType<typeof useT>, status: WorkspaceChangeFile['status']): string {
  switch (status) {
    case 'created':
      return t('tool.wsAdded')
    case 'deleted':
      return t('tool.wsDeleted')
    case 'modified':
      return t('tool.wsModified')
    default:
      return t('tool.wsUnknownStatus')
  }
}

const WS_UNKNOWN_KEY = {
  concurrent: 'tool.wsConcurrent',
  truncated: 'tool.wsTruncated',
  unreadable: 'tool.wsUnreadable'
} as const

export function ToolResultDetail({ call }: { call: UIToolCall }) {
  return (
    <div className="trd" data-testid="tool-result-detail">
      <ToolDetail call={call} />
    </div>
  )
}
