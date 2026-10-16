import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, CornerUpRight, History, Pencil, Send, Trash2, Undo2 } from 'lucide-react'
import { Button, IconButton } from '../../ui'
import type { QueueState } from '../../../../shared/ipc'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { locateQueueItem, planQueueEdit, planQueueMove, planQueueRemove } from './queue-plan'
import './queue-editor.css'

type ApplyQueueOrder = (next: QueueState) => Promise<void>

function applyQueueOrderAction(): ApplyQueueOrder | undefined {
  const state = useStore.getState() as unknown as { applyQueueOrder?: ApplyQueueOrder }
  return typeof state.applyQueueOrder === 'function' ? state.applyQueueOrder : undefined
}

export function QueueEditor() {
  const t = useT()
  const queue = useStore((s) => s.queue)
  const pendingSends = useStore((s) => s.pendingSends)
  const releaseSend = useStore((s) => s.releaseSend)
  const restoreSend = useStore((s) => s.restoreSend)
  const steerQueued = useStore((s) => s.steerQueued)
  const removeQueued = useStore((s) => s.removeQueued)
  const notify = useStore((s) => s.notify)
  const roundRunning = useStore((s) => !!s.runners.find((r) => (r.runId ?? r.id) === s.activeRunnerId)?.running)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (editingId && !locateQueueItem(queue, editingId)) {
      setEditingId(null)
      setDraft('')
    }
  }, [queue, editingId])

  const { steering, followUp } = queue
  if (steering.length + followUp.length + pendingSends.length === 0) return null

  const closeEdit = (): void => {
    setEditingId(null)
    setDraft('')
  }

  const runOrder = async (next: QueueState | null): Promise<void> => {
    const apply = applyQueueOrderAction()
    if (!apply) {
      notify('error', t('queue.editUnavailable'))
      closeEdit()
      return
    }
    if (!next) {
      closeEdit()
      return
    }
    closeEdit()
    await apply(next)
  }

  const commitEdit = (id: string, text: string): void => {
    void runOrder(planQueueEdit(queue, id, text))
  }

  const move = (id: string, direction: 'up' | 'down'): void => {
    void runOrder(planQueueMove(queue, id, direction))
  }

  const remove = (id: string): void => {
    void runOrder(planQueueRemove(queue, id))
  }

  const renderEditor = (id: string) => (
    <div className="cq-edit" data-testid="queue-edit-panel">
      <textarea
        className="cq-edit-input"
        value={draft}
        rows={1}
        autoFocus
        spellCheck={false}
        aria-label={t('queue.editTip')}
        data-testid="queue-edit-input"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
          if (e.key === 'Escape') {
            e.preventDefault()
            closeEdit()
            return
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            commitEdit(id, draft)
          }
        }}
      />
      <Button
        variant="primary"
        size="sm"
        data-testid="queue-edit-save"
        isDisabled={!draft.trim()}
        onPress={() => commitEdit(id, draft)}
      >
        {t('queue.editSave')}
      </Button>
      <Button variant="secondary" size="sm" data-testid="queue-edit-cancel" onPress={closeEdit}>
        {t('queue.editCancel')}
      </Button>
    </div>
  )

  const renderActions = (id: string, text: string, index: number, total: number, canSteer: boolean) => (
    <span className="cq-actions">
      {canSteer ? (
        <IconButton
          variant="ghost"
          size="sm"
          className="cq-action"
          aria-label={t('queue.steer')}
          title={t('queue.steerTip')}
          data-testid="queue-steer"
          onPress={() => void steerQueued(id)}
        >
          <CornerUpRight size={12} aria-hidden />
        </IconButton>
      ) : null}
      <IconButton
        variant="ghost"
        size="sm"
        className="cq-action"
        aria-label={t('queue.edit')}
        title={t('queue.editTip')}
        data-testid="queue-edit-start"
        onPress={() => {
          setEditingId(id)
          setDraft(text)
        }}
      >
        <Pencil size={12} aria-hidden />
      </IconButton>
      <IconButton
        variant="ghost"
        size="sm"
        className="cq-action"
        aria-label={t('queue.moveUp')}
        title={t('queue.moveUpTip')}
        isDisabled={index === 0}
        data-testid="queue-move-up"
        onPress={() => move(id, 'up')}
      >
        <ArrowUp size={12} aria-hidden />
      </IconButton>
      <IconButton
        variant="ghost"
        size="sm"
        className="cq-action"
        aria-label={t('queue.moveDown')}
        title={t('queue.moveDownTip')}
        isDisabled={index >= total - 1}
        data-testid="queue-move-down"
        onPress={() => move(id, 'down')}
      >
        <ArrowDown size={12} aria-hidden />
      </IconButton>
      <IconButton
        variant="ghost"
        size="sm"
        className="cq-action"
        aria-label={t('queue.retract')}
        title={t('queue.retractTip')}
        data-testid="queue-retract"
        onPress={() => void removeQueued(id)}
      >
        <Undo2 size={12} aria-hidden />
      </IconButton>
      <IconButton
        variant="ghost"
        size="sm"
        className="cq-action cq-action-danger"
        aria-label={t('queue.delete')}
        title={t('queue.deleteTip')}
        data-testid="queue-delete"
        onPress={() => remove(id)}
      >
        <Trash2 size={12} aria-hidden />
      </IconButton>
    </span>
  )

  return (
    <div className="composer-queue" data-testid="queue-stack">
      {pendingSends.map((item) => (
        <div className="cq-row cq-pending" key={item.id} title={item.text} data-testid="queue-pending">
          <Send className="cq-icon" size={12} aria-hidden />
          <span className="cq-text">{item.text}</span>
          {item.images?.length ? <span className="cq-tag">{t('queue.images', { n: item.images.length })}</span> : null}
          <span className="cq-tag">{t('queue.hold')}</span>
          {roundRunning ? (
            <>
              <Button
                variant="primary"
                size="sm"
                className="cq-action"
                data-testid="pending-steer"
                title={t('queue.steerNowTip')}
                onPress={() => void releaseSend(item.id, 'steer')}
              >
                {t('queue.steerNow')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="cq-action"
                data-testid="pending-follow"
                title={t('queue.queueItTip')}
                onPress={() => void releaseSend(item.id, 'followUp')}
              >
                {t('queue.queueIt')}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="sm"
              className="cq-action"
              data-testid="pending-send"
              title={t('queue.sendNowTip')}
              onPress={() => void releaseSend(item.id, 'followUp')}
            >
              {t('queue.sendNow')}
            </Button>
          )}
          <IconButton
            variant="ghost"
            size="sm"
            className="cq-action"
            aria-label={t('queue.restore')}
            title={t('queue.restoreTip')}
            data-testid="pending-restore"
            onPress={() => restoreSend(item.id)}
          >
            <Undo2 size={12} aria-hidden />
          </IconButton>
        </div>
      ))}

      {steering.map((item, index) =>
        editingId === item.id ? (
          <div className="cq-row cq-editing" key={item.id} data-testid="queue-row">
            {renderEditor(item.id)}
          </div>
        ) : (
          <div className="cq-row cq-steering" key={item.id} title={item.text} data-testid="queue-row">
            <CornerUpRight className="cq-icon" size={12} aria-hidden />
            <span className="cq-text">{item.text}</span>
            {item.images?.length ? <span className="cq-tag">{t('queue.images', { n: item.images.length })}</span> : null}
            <span className="cq-tag cq-tag-run">{t('queue.inserting')}</span>
            {renderActions(item.id, item.text, index, steering.length, false)}
          </div>
        )
      )}

      {followUp.map((item, index) =>
        editingId === item.id ? (
          <div className="cq-row cq-editing" key={item.id} data-testid="queue-row">
            {renderEditor(item.id)}
          </div>
        ) : (
          <div className="cq-row" key={item.id} title={item.text} data-testid="queue-row">
            <History className="cq-icon" size={12} aria-hidden />
            <span className="cq-text">{item.text}</span>
            {item.images?.length ? <span className="cq-tag">{t('queue.images', { n: item.images.length })}</span> : null}
            {renderActions(item.id, item.text, index, followUp.length, true)}
          </div>
        )
      )}
    </div>
  )
}
