import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, CornerUpRight, EllipsisVertical, History, Send } from 'lucide-react'
import { Button, IconButton, Menu, MenuItem, MenuTrigger, Popover, Separator } from '../../ui'
import type { QueueItem } from '../../../../shared/ipc'
import { useT } from '../../i18n'
import { pendingSendsForView, useStore } from '../../state/store'
import { locateQueueItem, type QueueOp } from './queue-plan'
import './queue-editor.css'

type RowAction = 'steer' | 'edit' | 'up' | 'down' | 'retract' | 'delete'

function previewOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function QueueEditor() {
  const t = useT()
  const queue = useStore((s) => s.queue)
  const allPendingSends = useStore((s) => s.pendingSends)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const session = useStore((s) => s.session)
  const pendingSends = pendingSendsForView({ pendingSends: allPendingSends, peekedSessionId, peekedPath, session })
  const releaseSend = useStore((s) => s.releaseSend)
  const restoreSend = useStore((s) => s.restoreSend)
  const steerQueued = useStore((s) => s.steerQueued)
  const removeQueued = useStore((s) => s.removeQueued)
  const applyQueueOp = useStore((s) => s.applyQueueOp)
  const roundRunning = useStore((s) => !!s.runners.find((r) => (r.runId ?? r.id) === s.activeRunnerId)?.running)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (editingId && !locateQueueItem(queue, editingId)) {
      setEditingId(null)
      setDraft('')
    }
  }, [queue, editingId])

  const { steering, followUp } = queue
  const total = steering.length + followUp.length + pendingSends.length
  if (total === 0) return null
  const closeEdit = (): void => {
    setEditingId(null)
    setDraft('')
  }

  const runOrder = async (op: QueueOp): Promise<void> => {
    closeEdit()
    await applyQueueOp(op)
  }

  const commitEdit = (id: string, text: string): void => {
    void runOrder({ op: 'edit', id, text })
  }

  const move = (id: string, direction: 'up' | 'down'): void => {
    void runOrder({ op: 'move', id, direction })
  }

  const remove = (id: string): void => {
    void runOrder({ op: 'remove', id })
  }

  const clearAll = (): void => {
    const state = useStore.getState()
    for (const item of pendingSendsForView(state)) state.discardSend(item.id)
    void runOrder({ op: 'clear' })
  }

  const collapsible = total > 1
  const showBody = !collapsible || expanded
  const head = pendingSends[0] ?? steering[0] ?? followUp[0]

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

  const runAction = (id: string, text: string, action: RowAction): void => {
    if (action === 'steer') void steerQueued(id)
    else if (action === 'edit') {
      setEditingId(id)
      setDraft(text)
    } else if (action === 'up') move(id, 'up')
    else if (action === 'down') move(id, 'down')
    else if (action === 'retract') void removeQueued(id)
    else if (action === 'delete') remove(id)
  }

  const renderMenu = (
    id: string,
    text: string,
    options: { index: number; total: number; canSteer: boolean }
  ) => (
    <MenuTrigger>
      <IconButton
        variant="ghost"
        size="sm"
        className="cq-menu-trigger"
        aria-label={t('queue.actions')}
        title={t('queue.actions')}
        data-testid="queue-actions"
      >
        <EllipsisVertical size={14} aria-hidden />
      </IconButton>
      <Popover placement="bottom end" offset={4}>
        <Menu aria-label={t('queue.actions')} className="cq-menu" onAction={(key) => runAction(id, text, key as RowAction)}>
          {options.canSteer ? (
            <MenuItem id="steer" textValue={t('queue.steer')} data-testid="queue-steer">
              {t('queue.steer')}
            </MenuItem>
          ) : null}
          <MenuItem id="edit" textValue={t('queue.edit')} data-testid="queue-edit-start">
            {t('queue.edit')}
          </MenuItem>
          <MenuItem id="up" textValue={t('queue.moveUp')} isDisabled={options.index === 0}>
            {t('queue.moveUp')}
          </MenuItem>
          <MenuItem id="down" textValue={t('queue.moveDown')} isDisabled={options.index >= options.total - 1}>
            {t('queue.moveDown')}
          </MenuItem>
          <Separator />
          <MenuItem id="retract" textValue={t('queue.retract')} data-testid="queue-retract">
            {t('queue.retract')}
          </MenuItem>
          <MenuItem id="delete" textValue={t('queue.delete')} className="cq-menu-danger" data-testid="queue-delete">
            {t('queue.delete')}
          </MenuItem>
        </Menu>
      </Popover>
    </MenuTrigger>
  )

  const renderPendingMenu = (id: string, label: string) => (
    <MenuTrigger>
      <IconButton
        variant="ghost"
        size="sm"
        className="cq-menu-trigger"
        aria-label={t('queue.actions')}
        title={t('queue.actions')}
        data-testid="pending-actions"
      >
        <EllipsisVertical size={14} aria-hidden />
      </IconButton>
      <Popover placement="bottom end" offset={4}>
        <Menu
          aria-label={t('queue.actions')}
          className="cq-menu"
          onAction={(key) => {
            if (key === 'steer') void releaseSend(id, 'steer')
            else if (key === 'follow') void releaseSend(id, 'followUp')
            else if (key === 'restore') restoreSend(id)
          }}
        >
          {roundRunning ? (
            <MenuItem id="steer" textValue={t('queue.steerNow')} data-testid="pending-steer">
              {`${t('queue.steerNow')} · ${label}`}
            </MenuItem>
          ) : null}
          <MenuItem id="follow" textValue={roundRunning ? t('queue.queueIt') : t('queue.sendNow')} data-testid="pending-follow">
            {roundRunning ? t('queue.queueIt') : t('queue.sendNow')}
          </MenuItem>
          <Separator />
          <MenuItem id="restore" textValue={t('queue.restore')} data-testid="pending-restore">
            {t('queue.restore')}
          </MenuItem>
        </Menu>
      </Popover>
    </MenuTrigger>
  )

  const renderQueuedRow = (item: QueueItem, index: number, listLength: number, kind: 'steering' | 'followUp') =>
    editingId === item.id ? (
      <div className="cq-row cq-editing" key={item.id} data-testid="queue-row">
        {renderEditor(item.id)}
      </div>
    ) : (
      <div className={`cq-row ${kind === 'steering' ? 'cq-steering' : ''}`} key={item.id} title={item.text} data-testid="queue-row">
        {kind === 'steering' ? (
          <CornerUpRight className="cq-icon" size={12} aria-hidden />
        ) : (
          <History className="cq-icon" size={12} aria-hidden />
        )}
        <span className="cq-text">{item.text}</span>
        {item.images?.length ? <span className="cq-tag">{t('queue.images', { n: item.images.length })}</span> : null}
        {kind === 'steering' ? <span className="cq-tag cq-tag-run">{t('queue.inserting')}</span> : null}
        <span className="cq-actions">
          {renderMenu(item.id, item.text, { index, total: listLength, canSteer: kind === 'followUp' })}
        </span>
      </div>
    )

  return (
    <div className="composer-queue" data-testid="queue-stack" data-count={total}>
      {collapsible ? (
        <button
          type="button"
          className="cq-row cq-collapsed"
          aria-expanded={expanded}
          aria-label={expanded ? t('queue.collapse') : t('queue.expand')}
          data-testid="queue-toggle"
          onClick={() => setExpanded((open) => !open)}
        >
          <span className="cq-count">{t('queue.count', { n: total })}</span>
          {head ? <span className="cq-preview">{t('queue.next', { text: previewOf(head.text) })}</span> : <span className="cq-preview" />}
          {expanded ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
        </button>
      ) : null}

      {showBody ? (
        <>
          {pendingSends.map((item) => (
            <div className="cq-row cq-pending" key={item.id} title={item.text} data-testid="queue-pending">
              <Send className="cq-icon" size={12} aria-hidden />
              <span className="cq-text">{item.text}</span>
              {item.images?.length ? <span className="cq-tag">{t('queue.images', { n: item.images.length })}</span> : null}
              <span className="cq-tag">{t('queue.hold')}</span>
              <span className="cq-actions">{renderPendingMenu(item.id, item.text)}</span>
            </div>
          ))}

          {steering.map((item, index) => renderQueuedRow(item, index, steering.length, 'steering'))}
          {followUp.map((item, index) => renderQueuedRow(item, index, followUp.length, 'followUp'))}

          {showBody && total > 0 ? (
            <div className="cq-footer">
              <Button variant="ghost" size="sm" className="cq-clear" data-testid="queue-clear-all" onPress={clearAll}>
                {t('queue.clearAll')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
