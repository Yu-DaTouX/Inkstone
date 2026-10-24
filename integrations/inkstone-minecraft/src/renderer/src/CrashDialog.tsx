import { useState, type ReactElement } from 'react'
import { ChevronDown, ChevronUp, FileWarning, X } from 'lucide-react'
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import { Badge } from '@yan/ui/Badge'
import { Button } from '@yan/ui/Button'
import { IconButton } from '@yan/ui/IconButton'
import { Notice } from '@yan/ui/Notice'
import type { CrashAction, CrashDiagnosis } from '../../shared/crash-api.ts'

interface Props {
  diagnosis: CrashDiagnosis | null
  busy: string | null
  result: { ok: boolean; message: string } | null
  onClose(): void
  onAction(action: CrashAction): void
}

const SOURCE_LABEL: Record<string, string> = {
  'crash-report': '崩溃报告',
  'hs_err': 'hs_err',
  'process': '进程输出',
  'latest.log': 'latest.log'
}

export function CrashDialog({ diagnosis, busy, result, onClose, onAction }: Props): ReactElement {
  const [expanded, setExpanded] = useState(false)
  return (
    <ModalOverlay className="ui-modal-overlay" isOpen={!!diagnosis} isDismissable onOpenChange={(next) => !next && onClose()}>
      <Modal className="ui-modal" data-dialog-size="md">
        <Dialog className="ui-dialog crash-dialog">
          <div className="ui-dialog__head">
            <Heading slot="title" className="ui-dialog__title">
              <span className="crash-dialog__glyph" aria-hidden="true">
                <FileWarning size={16} />
              </span>
              游戏崩了
            </Heading>
            <IconButton aria-label="关闭" size="sm" onPress={onClose}>
              <X size={16} />
            </IconButton>
          </div>
          {diagnosis ? (
            <div className="ui-dialog__body crash-dialog__body">
              <p className="crash-dialog__conclusion">{diagnosis.rule ? diagnosis.rule.explanation : '没认出原因，下面是堆栈关键词和收集到的日志。'}</p>
              <div className="crash-dialog__tags">
                {diagnosis.rule ? <Badge tone={diagnosis.rule.confidence === 'high' ? 'fail' : 'stall'}>置信度 {diagnosis.rule.confidence === 'high' ? '高' : '中'}</Badge> : null}
                <Badge>{diagnosis.versionId}</Badge>
                {diagnosis.exitCode !== null ? <Badge>退出码 {diagnosis.exitCode}</Badge> : null}
                {!diagnosis.windowShown ? <Badge tone="stall">窗口没出现</Badge> : null}
              </div>

              {diagnosis.evidence.length > 0 ? (
                <section className="crash-dialog__section">
                  <div className="crash-dialog__section-head">
                    <span className="crash-dialog__label">证据</span>
                    {diagnosis.evidence.length > 5 ? (
                      <Button variant="ghost" size="sm" icon={expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />} onPress={() => setExpanded((value) => !value)}>
                        {expanded ? '收起' : `展开 ${diagnosis.evidence.length} 行`}
                      </Button>
                    ) : null}
                  </div>
                  <div className="crash-evidence" role="log" tabIndex={0}>
                    {(expanded ? diagnosis.evidence : diagnosis.evidence.slice(0, 5)).map((line, index) => (
                      <div key={`${line.source}-${index}`} className="crash-evidence__line">
                        <span className="crash-evidence__source">{SOURCE_LABEL[line.source] ?? line.source}</span>
                        <span className="crash-evidence__text">{line.text}</span>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {diagnosis.suspects.length > 0 ? (
                <section className="crash-dialog__section">
                  <span className="crash-dialog__label">嫌疑 Mod</span>
                  <ul className="crash-suspects">
                    {diagnosis.suspects.map((suspect) => (
                      <li key={suspect.fileName} className="crash-suspect">
                        <span className="crash-suspect__name">{suspect.name}</span>
                        <span className="crash-suspect__file">{suspect.fileName}</span>
                        <span className="crash-suspect__reasons">{suspect.reasons.join('；')}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {diagnosis.keywords.length > 0 ? (
                <section className="crash-dialog__section">
                  <span className="crash-dialog__label">堆栈关键词</span>
                  <div className="crash-dialog__keywords">
                    {diagnosis.keywords.map((keyword) => (
                      <code key={keyword} className="crash-dialog__keyword">
                        {keyword}
                      </code>
                    ))}
                  </div>
                </section>
              ) : null}

            </div>
          ) : null}
          {diagnosis ? (
            <footer className="crash-dialog__foot">
              {result ? (
                <Notice tone={result.ok ? 'ok' : 'fail'} compact>
                  {result.message}
                </Notice>
              ) : null}
              <div className="crash-dialog__actions">
                {diagnosis.actions.map((action, index) => (
                  <Button
                    key={`${action.kind}-${index}`}
                    variant={index === 0 && action.kind !== 'export' ? 'primary' : 'ghost'}
                    size="sm"
                    isDisabled={busy !== null}
                    onPress={() => onAction(action)}
                  >
                    {busy === action.kind ? '处理中…' : action.label}
                  </Button>
                ))}
              </div>
            </footer>
          ) : null}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
