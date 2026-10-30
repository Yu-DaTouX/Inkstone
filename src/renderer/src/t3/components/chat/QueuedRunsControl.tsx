import {
  ArrowUpIcon,
  ChevronDownIcon,
  CornerUpRightIcon,
  EllipsisVerticalIcon,
  ImageIcon,
  PencilIcon,
  Undo2Icon,
  XIcon
} from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useT } from '@/i18n'
import { useQueueAdapter, type QueueRow } from '@/t3/adapters/composer-queue'
import { Button, InlineButton } from '@/t3/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/t3/components/ui/menu'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/t3/components/ui/tooltip'
import { cn } from '@/t3/lib/utils'

const QUEUE_VISIBLE_ROWS = 3

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

  const collapsible = queue.total > QUEUE_VISIBLE_ROWS
  const visibleRows = collapsible && !showAll ? queue.rows.slice(0, QUEUE_VISIBLE_ROWS - 1) : queue.rows

  const rowActions = (row: QueueRow) =>
    row.kind === 'pending' ? (
      <>
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Button
              data-testid="pending-follow"
              onClick={() => queue.sendNow(row)}
              size="xs"
              variant="ghost-muted"
            >
              <ArrowUpIcon />
              {queue.running ? t('queue.queueIt') : t('queue.sendNow')}
            </Button>
          </TooltipTrigger>
          <TooltipPopup>
            {queue.running ? t('queue.queueItTip') : t('queue.sendNowTip')}
          </TooltipPopup>
        </Tooltip>
        {queue.running ? (
          <Tooltip>
            <TooltipTrigger render={<span className="flex shrink-0" />}>
              <Button
                data-testid="pending-steer"
                onClick={() => queue.steer(row)}
                size="icon-xs"
                variant="ghost-muted"
                aria-label={t('queue.steerNow')}
              >
                <CornerUpRightIcon />
              </Button>
            </TooltipTrigger>
            <TooltipPopup>{t('queue.steerNowTip')}</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Button
              data-testid="pending-restore"
              onClick={() => queue.restore(row)}
              size="icon-xs"
              variant="ghost-muted"
              aria-label={t('queue.restore')}
            >
              <Undo2Icon />
            </Button>
          </TooltipTrigger>
          <TooltipPopup>{t('queue.restoreTip')}</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Button
              data-testid="pending-discard"
              onClick={() => queue.discard(row)}
              size="icon-xs"
              variant="ghost"
              aria-label={t('queue.delete')}
            >
              <XIcon />
            </Button>
          </TooltipTrigger>
          <TooltipPopup>{t('queue.deleteTip')}</TooltipPopup>
        </Tooltip>
      </>
    ) : (
      <>
        {row.canSteer ? (
          <Tooltip>
            <TooltipTrigger render={<span className="flex shrink-0" />}>
              <Button
                data-testid="queue-steer"
                onClick={() => queue.steer(row)}
                size="xs"
                variant="ghost-muted"
              >
                <CornerUpRightIcon />
                {t('queue.steer')}
              </Button>
            </TooltipTrigger>
            <TooltipPopup>{t('queue.steerTip')}</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Button
              data-testid="queue-edit-start"
              onClick={() => startEdit(row)}
              size="icon-xs"
              variant="ghost-muted"
              aria-label={t('queue.edit')}
            >
              <PencilIcon />
            </Button>
          </TooltipTrigger>
          <TooltipPopup>{t('queue.editTip')}</TooltipPopup>
        </Tooltip>
        <Menu>
          <MenuTrigger
            render={
              <Button
                data-testid="queue-actions"
                size="icon-xs"
                variant="ghost-muted"
                aria-label={t('queue.actions')}
              />
            }
          >
            <EllipsisVerticalIcon />
          </MenuTrigger>
          <MenuPopup align="end" side="bottom" sideOffset={4}>
            <MenuItem
              disabled={!row.canMoveUp}
              onClick={() => queue.move(row, 'up')}
              density="touch"
            >
              {t('queue.moveUp')}
            </MenuItem>
            <MenuItem
              disabled={!row.canMoveDown}
              onClick={() => queue.move(row, 'down')}
              density="touch"
            >
              {t('queue.moveDown')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem data-testid="queue-retract" onClick={() => queue.retract(row)} density="touch">
              {t('queue.retract')}
            </MenuItem>
            <MenuItem
              data-testid="queue-delete"
              onClick={() => queue.drop(row)}
              variant="destructive"
              density="touch"
            >
              {t('queue.delete')}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </>
    )

  return (
    <section
      aria-label={t('queue.count', { n: queue.total })}
      className={cn(
        'relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 pb-4',
        className
      )}
      data-testid="queue-stack"
      data-count={queue.total}
      data-thread-queue="true"
    >
      <span aria-live="polite" className="sr-only">
        {t('queue.count', { n: queue.total })}
      </span>
      <ol className="flex flex-col items-end gap-3" id={listId} data-testid="queue-list">
        {visibleRows.map((row, position) => {
          const isEditing = row.id === editingId
          return (
            <li
              aria-current={isEditing ? 'true' : undefined}
              aria-posinset={position + 1}
              aria-setsize={queue.total}
              className="group/queued flex w-full flex-col items-end gap-1 transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none"
              data-kind={row.kind}
              data-testid={row.kind === 'pending' ? 'queue-pending' : 'queue-row'}
              key={row.id}
            >
              <div
                className={cn(
                  'flex min-w-0 max-w-[80%] flex-col rounded-2xl border border-dashed px-3 py-2 text-sm',
                  isEditing
                    ? 'w-full max-w-full border-primary/60 text-foreground'
                    : 'border-muted-foreground/40 text-muted-foreground'
                )}
                title={isEditing ? undefined : row.text}
              >
                {isEditing && editingRow ? (
                  <>
                    <textarea
                      aria-label={t('queue.editTip')}
                      autoFocus
                      className="block max-h-40 w-full resize-none rounded-lg bg-input/40 px-2 py-1.5 text-foreground text-sm leading-relaxed outline-none field-sizing-content placeholder:text-placeholder focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
                    <div className="mt-1 flex items-center justify-end gap-1">
                      <Button
                        data-testid="queue-edit-cancel"
                        onClick={closeEdit}
                        size="xs"
                        variant="ghost"
                      >
                        {t('queue.editCancel')}
                      </Button>
                      <Button
                        data-testid="queue-edit-save"
                        disabled={!draft.trim()}
                        onClick={() => commitEdit(editingRow)}
                        size="xs"
                        variant="default"
                      >
                        {t('queue.editSave')}
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    {row.imageCount > 0 ? (
                      <span className="mb-1 flex flex-wrap items-center gap-1">
                        {row.images.map((image, index) => (
                          <span
                            className="size-8 overflow-hidden rounded-md border border-border/70 bg-background"
                            key={`${row.id}-img-${index}`}
                          >
                            <img alt="" className="size-full object-cover" src={thumbUrl(image)} />
                          </span>
                        ))}
                      </span>
                    ) : null}
                    {row.text ? (
                      <p className="whitespace-pre-wrap wrap-anywhere">{row.text}</p>
                    ) : null}
                  </>
                )}
              </div>
              <div className="flex items-center gap-0.5 pe-1 text-xs text-muted-foreground">
                {row.kind === 'pending' ? (
                  <span className="px-1 text-2xs">{t('queue.hold')}</span>
                ) : null}
                {row.kind === 'steering' ? (
                  <span className="px-1 text-2xs">{t('queue.inserting')}</span>
                ) : null}
                {row.imageCount > 0 ? (
                  <span className="flex items-center gap-1 px-1 text-2xs">
                    <ImageIcon aria-hidden className="size-3" />
                    {t('queue.images', { n: row.imageCount })}
                  </span>
                ) : null}
                <span className="me-1 flex items-center gap-0.5 px-1 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/queued:opacity-100 pointer-coarse:opacity-100">
                  {rowActions(row)}
                </span>
              </div>
            </li>
          )
        })}
      </ol>
      {collapsible ? (
        <div className="self-end pe-1 text-xs pointer-coarse:[&_[data-slot=inline-button]]:relative pointer-coarse:[&_[data-slot=inline-button]]:after:absolute pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-x-1.5 pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-y-3.5">
          <InlineButton
            aria-controls={listId}
            aria-expanded={showAll}
            data-testid="queue-toggle"
            onClick={() => setShowAll((value) => !value)}
            onPointerDown={(event) => event.preventDefault()}
            tone="muted"
          >
            {showAll
              ? t('composer.t3.queue.showLess')
              : t('composer.t3.queue.showAll', { n: queue.total })}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
                showAll && 'rotate-180'
              )}
            />
          </InlineButton>
        </div>
      ) : null}
      {queue.total > 1 ? (
        <div className="self-end pe-1">
          <InlineButton
            data-testid="queue-clear-all"
            onClick={() => {
              closeEdit()
              queue.clearAll()
            }}
            onPointerDown={(event) => event.preventDefault()}
            tone="muted"
          >
            {t('queue.clearAll')}
          </InlineButton>
        </div>
      ) : null}
    </section>
  )
}
