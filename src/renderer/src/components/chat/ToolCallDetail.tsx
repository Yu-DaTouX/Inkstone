import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { UIToolCall } from '../../../../shared/ipc'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import { Button, IconButton } from '../ui'
import { ChatImage } from './ChatImage'
import { TerminalWindow } from './Terminal'
import { FileChangeDetail, ToolResultDetail, WorkspaceChangesDetail, detailKind, readWorkspaceChanges } from './ToolDetails'

type Props = { call: UIToolCall; target: string; secs: number | null }

/** 两种布局与宽幅阅读共享同一条调用，不重新执行或读取磁盘。 */
export function ToolCallDetail(props: Props) {
  const [wide, setWide] = useState(false)
  return <>
    <DetailView {...props} onExpand={() => setWide(true)} />
    {wide ? <DetailDialog {...props} onClose={() => setWide(false)} /> : null}
  </>
}

function DetailView({ call, target, secs, onExpand }: Props & { onExpand?: () => void }) {
  const t = useT()
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyTimer = useRef<number | null>(null)
  useEffect(() => () => { if (copyTimer.current !== null) window.clearTimeout(copyTimer.current) }, [])
  const kind = detailKind(call.name)
  const changes = readWorkspaceChanges(call.details)
  const args = call.args as Record<string, unknown> | undefined
  const fullTarget = [args?.path, args?.file_path, args?.filePath, args?.command].find(value => typeof value === 'string') as string | undefined
  /*
   * 顶部路径行什么时候出现：
   *   · 命令类不在详情里重复路径（终端 prompt 行已有）；
   *   · 文件改动在**行内**视图隐藏自带标题行，用这里补完整路径；
   *   · 宽幅视图（没有 onExpand）有标题行与增删统计，不再重复一次。
   */
  const showTargetLine = kind !== 'command' && !!fullTarget && !(kind === 'change' && !onExpand)
  const copy = async () => {
    try {
      const input = call.args ? JSON.stringify(call.args, null, 2) : call.argsRaw ?? target
      await navigator.clipboard.writeText([input, call.output ?? ''].filter(Boolean).join('\n\n'))
      setCopyState('copied')
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null
        setCopyState('idle')
      }, 1600)
    } catch { setCopyState('failed') }
  }
  return <div className="tool-view" data-kind={kind}>
    <div className="tool-view-actions">
      {onExpand ? <Button variant="ghost" size="sm" onClick={onExpand} data-testid="tool-detail-wide">{t('tool.viewWide')}</Button> : null}
      <IconButton size="sm" icon={copyState === 'copied' ? 'check' : 'copy'} label={t(copyState === 'copied' ? 'turn.copied' : copyState === 'failed' ? 'turn.copyFailed' : 'tool.copyDetail')} onClick={() => void copy()} />
    </div>
    <div className="tool-view-content" tabIndex={0} role="region" aria-label={t('tool.recordedDetail')}>
      {showTargetLine ? <div className="tool-view-target">{fullTarget}</div> : null}
      {call.historySummary ? <p className="trow-src">{t('tool2.historySummary')}</p> : null}
      {call.nestedCallsIncomplete ? <p className="trow-src">{t('tool2.nestedIncomplete')}</p> : null}
      {call.images?.length ? <div className="trow-images" data-testid="tool-images">
        {call.images.map((im, i) => im.data ? <ChatImage key={i} src={`data:${im.mimeType};base64,${im.data}`} /> : im.url ? <ChatImage key={i} src={im.url} /> : null)}
      </div> : null}
      {kind === 'command' ? <>
        <TerminalWindow call={call} target={fullTarget ?? target} secs={secs} fitContent={!onExpand} />
        {changes ? <WorkspaceChangesDetail changes={changes} /> : null}
      </> : kind === 'change' ? <FileChangeDetail call={call} showHeader={!onExpand} /> : <ToolResultDetail call={call} />}
    </div>
  </div>
}

function DetailDialog({ onClose, ...props }: Props & { onClose: () => void }) {
  const t = useT()
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const { isTop } = useModalLayer(true, onClose)
  useFocusTrap(panel, true, isTop)
  useEffect(() => useStore.getState().acquireOverlayBlocker('tool-detail'), [])
  return createPortal(<div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget && isTop) onClose() }}>
    <div className="modal tool-detail-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panel}>
      <div className="modal-head">
        <span className="modal-title" id={titleId}>{props.call.name} · {t('tool.recordedDetail')}</span>
        <span className="spacer" />
        <IconButton size="sm" icon="close" label={t('q.close')} onClick={onClose} />
      </div>
      <DetailView {...props} />
    </div>
  </div>, document.body)
}
