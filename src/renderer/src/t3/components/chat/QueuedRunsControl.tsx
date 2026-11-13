import {
  ArrowUpIcon,
  ChevronDownIcon,
  CornerUpRightIcon,
  EllipsisVerticalIcon,
  ImageIcon,
  PencilIcon,
  Undo2Icon,
  XIcon
} from '../../../ui/icons'
import { useEffect, useId, useRef, useState } from 'react'
import { useT } from '@/i18n'
import { useQueueAdapter, type QueueRow } from '@/t3/adapters/composer-queue'
import { Button, IconButton, Focusable, Menu, MenuItem, MenuSeparator, MenuTrigger, Popover, TooltipTrigger, Tooltip, TooltipHint } from '../../../ui'
import { cx } from '@/ui/cx'
import { stripImageLegend } from '../../../features/composer/image-refs'
import './QueuedRunsControl.css'

const QUEUE_COLLAPSED_ROWS = 2

function thumbUrl(image: { data: string; mimeType: string }): string {
  return `data:${image.mimeType};base64,${image.data}`
}

export function QueuedRunsControl({ className }: { className?: string }) {
  const t = useT()
  const queue = useQueueAdapter()
  const listId = useId()
  const [showAll, setShowAll] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const rootRef = useRef<HTMLElement>(null)
  const hasRows = queue.total > 0

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.defaultPrevented || event.deltaY === 0 || event.target instanceof Element && event.target.closest('textarea')) return
      const stream = root.closest('.v3-split-peer, .v3-chat')?.querySelector<HTMLElement>('.v3-stream')
      if (!stream) return
      event.preventDefault()
      stream.dispatchEvent(new WheelEvent('wheel', { deltaY: event.deltaY, deltaX: event.deltaX, deltaMode: event.deltaMode, bubbles: true }))
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? stream.clientHeight : 1
      stream.scrollBy({ top: event.deltaY * unit, left: event.deltaX * unit })
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [hasRows])

  const editingRow = editingId ? queue.rows.find((row) => row.id === editingId) : undefined
  useEffect(() => {
    if (editingId && !queue.rows.some((row) => row.id === editingId)) {
      setEditingId(null)
      setDraft('')
    }
  }, [editingId, queue.rows])

  if (queue.total === 0) return null

  const startEdit = (row: QueueRow): void => {
    setEditingId(row.id)
    setDraft(row.text)
  }
  const closeEdit = (): void => {
    setEditingId(null)
    setDraft('')
  }
  const commitEdit = (row: QueueRow): void => {
    const text = draft.trim()
    if (text && text !== row.text) queue.edit(row, text)
    closeEdit()
  }

  const collapsible = queue.total > QUEUE_COLLAPSED_ROWS
  const visibleRows = collapsible && !showAll ? queue.rows.slice(0, QUEUE_COLLAPSED_ROWS) : queue.rows

  const rowActions = (row: QueueRow) =>
    row.kind === 'pending' ? (
      <>
        <TooltipTrigger>
          <Focusable excludeFromTabOrder><span className="t3-queue__action">
            <Button data-t3-btn variant="ghost" onPress={() => queue.sendNow(row)} data-testid="pending-follow">
              <ArrowUpIcon />
              {queue.running ? t('queue.queueIt') : t('queue.sendNow')}
            </Button>
          </span></Focusable>
          <Tooltip><TooltipHint label={queue.running ? t('queue.queueItTip') : t('queue.sendNowTip')} /></Tooltip>
        </TooltipTrigger>
        {queue.running ? (
          <TooltipTrigger>
            <Focusable excludeFromTabOrder><span className="t3-queue__action">
              <IconButton data-t3-btn variant="ghost" size="md" onPress={() => queue.steer(row)} data-testid="pending-steer" aria-label={t('queue.steerNow')}>
                <CornerUpRightIcon />
              </IconButton>
            </span></Focusable>
            <Tooltip><TooltipHint label={t('queue.steerNowTip')} /></Tooltip>
          </TooltipTrigger>
        ) : null}
        <TooltipTrigger>
          <Focusable excludeFromTabOrder><span className="t3-queue__action">
            <IconButton data-t3-btn variant="ghost" size="md" onPress={() => queue.restore(row)} data-testid="pending-restore" aria-label={t('queue.restore')}>
              <Undo2Icon />
            </IconButton>
          </span></Focusable>
          <Tooltip><TooltipHint label={t('queue.restoreTip')} /></Tooltip>
        </TooltipTrigger>
        <TooltipTrigger>
          <Focusable excludeFromTabOrder><span className="t3-queue__action">
            <IconButton data-t3-btn variant="ghost" size="md" onPress={() => queue.discard(row)} data-testid="pending-discard" aria-label={t('queue.delete')}>
              <XIcon />
            </IconButton>
          </span></Focusable>
          <Tooltip><TooltipHint label={t('queue.deleteTip')} /></Tooltip>
        </TooltipTrigger>
      </>
    ) : (
      <>
        {row.canSteer ? (
          <TooltipTrigger>
            <Focusable excludeFromTabOrder><span className="t3-queue__action">
              <Button data-t3-btn variant="ghost" onPress={() => queue.steer(row)} data-testid="queue-steer">
                <CornerUpRightIcon />
                {t('queue.steer')}
              </Button>
            </span></Focusable>
            <Tooltip><TooltipHint label={t('queue.steerTip')} /></Tooltip>
          </TooltipTrigger>
        ) : null}
        <TooltipTrigger>
          <Focusable excludeFromTabOrder><span className="t3-queue__action">
            <IconButton data-t3-btn variant="ghost" size="md" onPress={() => startEdit(row)} data-testid="queue-edit-start" aria-label={t('queue.edit')}>
              <PencilIcon />
            </IconButton>
          </span></Focusable>
          <Tooltip><TooltipHint label={t('queue.editTip')} /></Tooltip>
        </TooltipTrigger>
        <MenuTrigger>
          <IconButton data-t3-btn variant="ghost" size="md" data-testid="queue-actions" aria-label={t('queue.actions')}>
            <EllipsisVerticalIcon />
          </IconButton>
          <Popover placement="top end" offset={4}>
            <Menu
              aria-label={t('queue.actions')}
              autoFocus="first"
              disabledKeys={[...(row.canMoveUp ? [] : ['up']), ...(row.canMoveDown ? [] : ['down'])]}
              onAction={(key) => {
                if (key === 'up') queue.move(row, 'up')
                else if (key === 'down') queue.move(row, 'down')
                else if (key === 'retract') queue.retract(row)
                else if (key === 'delete') queue.drop(row)
              }}
            >
              <MenuItem id="up" textValue={t('queue.moveUp')}>
                {t('queue.moveUp')}
              </MenuItem>
              <MenuItem id="down" textValue={t('queue.moveDown')}>
                {t('queue.moveDown')}
              </MenuItem>
              <MenuSeparator />
              <MenuItem id="retract" textValue={t('queue.retract')} data-testid="queue-retract">
                {t('queue.retract')}
              </MenuItem>
              <MenuItem id="delete" textValue={t('queue.delete')} tone="danger" data-testid="queue-delete">
                {t('queue.delete')}
              </MenuItem>
            </Menu>
          </Popover>
        </MenuTrigger>
      </>
    )

  return (
    <section
      ref={rootRef}
      aria-label={t('queue.count', { n: queue.total })}
      className={cx(
        't3-queue',
        className
      )}
      data-testid="queue-stack"
      data-count={queue.total}
      data-thread-queue="true"
    >
      <span aria-live="polite" className="sr-only">
        {t('queue.count', { n: queue.total })}
      </span>
      <ol className="t3-queue__list" id={listId} data-testid="queue-list">
        {visibleRows.map((row, position) => {
          const isEditing = row.id === editingId
          return (
            <li
              aria-current={isEditing ? 'true' : undefined}
              aria-posinset={position + 1}
              aria-setsize={queue.total}
              className="t3-queue__item"
              data-kind={row.kind}
              data-testid={row.kind === 'pending' ? 'queue-pending' : 'queue-row'}
              key={row.id}
            >
              <div
                className={cx(
                  't3-queue__bubble',
                  isEditing && 't3-queue__bubble--editing'
                )}
                title={isEditing ? undefined : stripImageLegend(row.text)}
              >
                {isEditing && editingRow ? (
                  <>
                    <textarea
                      aria-label={t('queue.editTip')}
                      autoFocus
                      className="t3-queue__editor"
                      data-testid="queue-edit-input"
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          closeEdit()
                          return
                        }
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          commitEdit(editingRow)
                        }
                      }}
                      rows={1}
                      spellCheck={false}
                      value={draft}
                    />
                    <div className="t3-queue__editor-actions">
                      <Button data-t3-btn variant="ghost" onPress={closeEdit} data-testid="queue-edit-cancel">
                        {t('queue.editCancel')}
                      </Button>
                      <Button data-t3-btn variant="primary" isDisabled={!draft.trim()} onPress={() => commitEdit(editingRow)} data-testid="queue-edit-save">
                        {t('queue.editSave')}
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    {row.imageCount > 0 ? (
                      <span className="t3-queue__thumbs">
                        {row.images.map((image, index) => (
                          <span
                            className="t3-queue__thumb"
                            key={`${row.id}-img-${index}`}
                          >
                            <img alt="" src={thumbUrl(image)} />
                          </span>
                        ))}
                      </span>
                    ) : null}
                    {row.text ? (
                      <p className="t3-queue__text">{stripImageLegend(row.text)}</p>
                    ) : null}
                  </>
                )}
              </div>
              <div className="t3-queue__meta">
                {row.kind === 'pending' ? (
                  <span className="t3-queue__tag">{t('queue.hold')}</span>
                ) : null}
                {row.kind === 'steering' ? (
                  <span className="t3-queue__tag">{t('queue.inserting')}</span>
                ) : null}
                {row.imageCount > 0 ? (
                  <span className="t3-queue__tag">
                    <ImageIcon aria-hidden className="t3-icon--xs" />
                    {t('queue.images', { n: row.imageCount })}
                  </span>
                ) : null}
                <span className="t3-queue__actions">
                  {rowActions(row)}
                </span>
              </div>
            </li>
          )
        })}
      </ol>
      {queue.total > 1 ? (
        <div className="t3-queue__footer">
          {collapsible ? (
            <Button data-t3-btn
              variant="plain"
              size="sm"
              aria-controls={listId}
              aria-expanded={showAll}
              data-testid="queue-toggle"
              onPress={() => setShowAll((value) => !value)}
              preventFocusOnPress
            >
              {showAll
                ? t('composer.t3.queue.showLess')
                : t('composer.t3.queue.showAll', { n: queue.total })}
              <ChevronDownIcon
                aria-hidden
                className={cx(
                  't3-icon--sm t3-queue__chevron',
                  showAll && 't3-queue__chevron--open'
                )}
              />
            </Button>
          ) : null}
          <Button data-t3-btn
            variant="plain"
            size="sm"
            data-testid="queue-clear-all"
            onPress={() => {
              closeEdit()
              queue.clearAll()
            }}
            preventFocusOnPress
          >
            {t('queue.clearAll')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
