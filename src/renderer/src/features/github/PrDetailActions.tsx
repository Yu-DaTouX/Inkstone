import { useState, type ReactElement } from 'react'
import { Bot, ChevronDown, GitMerge, MessageSquareText, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DialogFooter,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Modal,
  MiddleTruncate,
  ModalOverlay,
  Notice,
  Popover,
  Radio,
  RadioGroup,
  TextArea
} from '../../ui'
import { useStore } from '../../state/store'
import type { PrDetail } from './pr-model'
import {
  agentPrompt,
  failedChecksOf,
  inlineCommentsOf,
  mergeVerdict,
  removePendingComment,
  updatePendingComment,
  type AgentTask,
  type PendingComment,
  type PrMergeMethod
} from './pr-actions-model'
import type { PrActionText } from './pr-action-text'
import { PrActionStatus, type PrActionController } from './PrActionStatus'
import { MarkdownEditor } from './PrEditors'

type Confirm = 'merge' | 'close' | 'delete-branch' | 'checkout' | null

export interface PrActionBarProps {
  cwd: string
  detail: PrDetail
  text: PrActionText
  action: PrActionController
  pending: PendingComment[]
  onPendingChange: (next: PendingComment[]) => void
  onRefresh: () => void
}

export function PrActionBar({ cwd, detail, text, action, pending, onPendingChange, onRefresh }: PrActionBarProps): ReactElement {
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [method, setMethod] = useState<PrMergeMethod>('squash')
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [autoMergeChoice, setAutoMergeChoice] = useState(false)
  const verdict = mergeVerdict(detail)
  const open = detail.state === 'open' || detail.state === 'draft'
  const autoMerge = !verdict.canMerge || autoMergeChoice
  const mergeAllowed = verdict.canMerge || verdict.canAutoMerge
  const busy = action.busy
  const reasons = verdict.blockers.map((item) => text.status.blockers[item])

  const handOff = (task: AgentTask): void => {
    const prompt = agentPrompt(task, detail, text.agent.prompt)
    const store = useStore.getState()
    store.insertIntoComposer(prompt)
    store.notify('info', text.agent.inserted)
  }

  const runMore = (key: string): void => {
    if (busy) return
    if (key === 'ready') void action.run({ kind: 'ready', number: detail.number })
    else if (key === 'draft') void action.run({ kind: 'draft', number: detail.number })
    else if (key === 'reopen') void action.run({ kind: 'reopen', number: detail.number })
    else if (key === 'close' || key === 'delete-branch' || key === 'checkout') setConfirm(key)
  }

  return (
    <div className="gh-pr-act__bar" data-testid="gh-pr-actions">
      {open ? (
        <Button
          size="sm"
          variant="primary"
          icon={<GitMerge size={14} aria-hidden />}
          isDisabled={!mergeAllowed || busy}
          tooltip={reasons.length ? reasons.join('；') : undefined}
          onPress={() => {
            setAutoMergeChoice(!verdict.canMerge)
            setConfirm('merge')
          }}
          data-testid="gh-pr-merge"
        >
          {verdict.canMerge || !verdict.canAutoMerge ? text.status.merge : text.status.mergeAuto}
        </Button>
      ) : null}
      {open ? (
        <Button
          size="sm"
          variant="secondary"
          icon={<MessageSquareText size={14} aria-hidden />}
          isDisabled={busy}
          onPress={() => setReviewOpen(true)}
          data-testid="gh-pr-review-open"
        >
          {text.review.open}
          {pending.length ? <Badge tone="accent">{pending.length}</Badge> : null}
        </Button>
      ) : null}
      <MenuTrigger>
        <Button size="sm" variant="ghost" icon={<Bot size={14} aria-hidden />} trailingIcon={<ChevronDown size={12} aria-hidden />} data-testid="gh-pr-agent">
          {text.agent.menu}
        </Button>
        <Popover placement="bottom start">
          <Menu aria-label={text.agent.menu} onAction={(key) => handOff(String(key) as AgentTask)}>
            <MenuItem id="explain" description={text.agent.explainHint} data-testid="gh-pr-agent-explain">
              {text.agent.explain}
            </MenuItem>
            <MenuItem
              id="fix-checks"
              description={text.agent.fixChecksHint}
              trailingValue={failedChecksOf(detail.checkItems).length || undefined}
              data-testid="gh-pr-agent-fix"
            >
              {text.agent.fixChecks}
            </MenuItem>
            <MenuItem id="respond-reviews" description={text.agent.respondHint} data-testid="gh-pr-agent-respond">
              {text.agent.respond}
            </MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
      <MenuTrigger>
        <IconButton size="sm" variant="ghost" aria-label={text.status.more} tooltip={text.status.more} isDisabled={busy} data-testid="gh-pr-more">
          <MoreHorizontal size={14} aria-hidden />
        </IconButton>
        <Popover placement="bottom end">
          <Menu aria-label={text.status.more} onAction={(key) => runMore(String(key))}>
            {detail.state === 'draft' ? <MenuItem id="ready">{text.status.ready}</MenuItem> : null}
            {detail.state === 'open' ? <MenuItem id="draft">{text.status.toDraft}</MenuItem> : null}
            {detail.state === 'closed' ? <MenuItem id="reopen">{text.status.reopen}</MenuItem> : null}
            <MenuItem id="checkout" data-testid="gh-pr-checkout-local">{text.status.checkout}</MenuItem>
            <MenuSeparator />
            {open ? (
              <MenuItem id="close" tone="danger" data-testid="gh-pr-close">
                {text.status.close}
              </MenuItem>
            ) : null}
            {detail.state === 'merged' || detail.state === 'closed' ? (
              <MenuItem id="delete-branch" tone="danger" data-testid="gh-pr-delete-branch">
                {text.status.deleteBranchAction}
              </MenuItem>
            ) : null}
          </Menu>
        </Popover>
      </MenuTrigger>
      {open && reasons.length ? (
        <ul className="gh-pr-act__reasons ui-meta-text" data-testid="gh-pr-merge-reasons">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      <ConfirmDialog
        isOpen={confirm === 'merge'}
        onOpenChange={(value) => (value ? undefined : setConfirm(null))}
        title={text.status.mergeTitle(detail.number)}
        description={text.status.mergeBody(detail.head, detail.base)}
        tone="danger"
        size="md"
        confirmLabel={autoMerge ? text.status.mergeAuto : text.status.mergeConfirm}
        isConfirmDisabled={busy || (!verdict.canMerge && !verdict.canAutoMerge)}
        confirmTestId="gh-pr-merge-confirm"
        data-testid="gh-pr-merge-dialog"
        onConfirm={() => {
          void action.run({ kind: 'merge', number: detail.number, method, autoMerge, deleteBranch, confirmed: true })
        }}
      >
        <div className="gh-pr-act__form">
          <RadioGroup label={text.status.method} value={method} onChange={(value) => setMethod(value as PrMergeMethod)}>
            {(['squash', 'merge', 'rebase'] as const).map((item) => (
              <Radio key={item} value={item} data-testid={`gh-pr-merge-method-${item}`}>
                <span className="gh-pr-act__radio">
                  <span>{text.status.methods[item]}</span>
                  <span className="gh-pr-act__hint ui-meta-text">{text.status.methodHint[item]}</span>
                </span>
              </Radio>
            ))}
          </RadioGroup>
          <Checkbox isSelected={deleteBranch} onChange={setDeleteBranch} data-testid="gh-pr-merge-delete-branch">
            {text.status.deleteBranch}
          </Checkbox>
          <Checkbox
            isSelected={autoMerge}
            isDisabled={!verdict.canMerge || !verdict.canAutoMerge}
            onChange={setAutoMergeChoice}
            data-testid="gh-pr-merge-auto"
          >
            {text.status.autoMerge}
          </Checkbox>
          {autoMerge ? <span className="gh-pr-act__hint ui-meta-text">{text.status.autoMergeHint}</span> : null}
          {reasons.length ? (
            <Notice tone="ask" compact>
              {reasons.join('；')}
            </Notice>
          ) : null}
          {detail.mergeable === 'unknown' ? <span className="gh-pr-act__hint ui-meta-text">{text.status.mergeableUnknown}</span> : null}
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={confirm === 'close'}
        onOpenChange={(value) => (value ? undefined : setConfirm(null))}
        title={text.status.closeTitle(detail.number)}
        description={text.status.closeBody}
        tone="danger"
        confirmLabel={text.status.closeConfirm}
        isConfirmDisabled={busy}
        confirmTestId="gh-pr-close-confirm"
        onConfirm={() => {
          void action.run({ kind: 'close', number: detail.number, confirmed: true })
        }}
      />
      <ConfirmDialog
        isOpen={confirm === 'delete-branch'}
        onOpenChange={(value) => (value ? undefined : setConfirm(null))}
        title={text.status.deleteTitle(detail.head)}
        description={text.status.deleteBody}
        tone="danger"
        confirmLabel={text.status.deleteConfirm}
        isConfirmDisabled={busy}
        confirmTestId="gh-pr-delete-confirm"
        onConfirm={() => {
          void action.run({ kind: 'delete-branch', number: detail.number, confirmed: true })
        }}
      />
      <ConfirmDialog
        isOpen={confirm === 'checkout'}
        onOpenChange={(value) => (value ? undefined : setConfirm(null))}
        title={text.status.checkoutTitle(detail.number)}
        description={text.status.checkoutBody}
        confirmLabel={text.status.checkoutConfirm}
        isConfirmDisabled={busy}
        confirmTestId="gh-pr-checkout-confirm"
        onConfirm={() => {
          void action.run({ kind: 'checkout', number: detail.number })
        }}
      />
      {reviewOpen ? (
        <PrReviewDialog
          cwd={cwd}
          detail={detail}
          text={text}
          action={action}
          pending={pending}
          onPendingChange={onPendingChange}
          onClose={() => setReviewOpen(false)}
          onRefresh={onRefresh}
        />
      ) : null}
    </div>
  )
}

type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'

export interface PrReviewDialogProps {
  cwd: string
  detail: PrDetail
  text: PrActionText
  action: PrActionController
  pending: PendingComment[]
  onPendingChange: (next: PendingComment[]) => void
  onClose: () => void
  onRefresh: () => void
}

export function PrReviewDialog({ cwd, detail, text, action, pending, onPendingChange, onClose, onRefresh }: PrReviewDialogProps): ReactElement {
  const [event, setEvent] = useState<ReviewEvent>('COMMENT')
  const [body, setBody] = useState('')
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const [touched, setTouched] = useState(false)
  const busy = action.busy
  const needsText = event !== 'APPROVE' && !body.trim() && !pending.length

  const submit = async (): Promise<void> => {
    setTouched(true)
    if (needsText || busy) return
    const result = await action.run({ kind: 'review', number: detail.number, event, body, comments: inlineCommentsOf(pending) })
    if (result?.ok) {
      onPendingChange([])
      onClose()
    }
  }

  return (
    <ModalOverlay isDismissable={!busy} isOpen onOpenChange={(value) => (value || busy ? undefined : onClose())}>
      <Modal data-dialog-size="lg">
        <Dialog title={text.review.title(detail.number)} data-testid="gh-pr-review-dialog">
          <div className="gh-pr-act__form">
            <RadioGroup label={text.review.event} value={event} onChange={(value) => setEvent(value as ReviewEvent)} orientation="horizontal">
              {(['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] as const).map((item) => (
                <Radio key={item} value={item} data-testid={`gh-pr-review-event-${item}`}>
                  {text.review.events[item]}
                </Radio>
              ))}
            </RadioGroup>
            <MarkdownEditor
              label={text.review.body}
              value={body}
              onChange={setBody}
              text={text.edit}
              cwd={cwd}
              placeholder={text.review.bodyPlaceholder}
              rows={5}
              isDisabled={busy}
              testId="gh-pr-review-body"
            />
            {touched && needsText ? (
              <Notice tone="ask" compact>
                {text.review.bodyRequired}
              </Notice>
            ) : null}
            <section className="gh-pr-act__pending" aria-label={text.review.pending(pending.length)}>
              <h3 className="gh-prd__heading">{text.review.pending(pending.length)}</h3>
              {pending.length ? (
                <ul className="gh-pr-act__pending-list" data-testid="gh-pr-pending-list">
                  {pending.map((item) => (
                    <li key={item.id} className="gh-pr-act__pending-item">
                      <div className="gh-pr-act__pending-head">
                        <MiddleTruncate className="gh-pr-act__pending-where ui-num" value={item.path} />
                        <span className="ui-meta-text">{text.review.pendingLine(item.startLine || item.line, item.line, item.side)}</span>
                        <IconButton
                          size="xs"
                          variant="ghost"
                          aria-label={text.review.pendingEdit}
                          tooltip={text.review.pendingEdit}
                          isDisabled={busy}
                          onPress={() => setEditing({ id: item.id, body: item.body })}
                        >
                          <Pencil size={12} aria-hidden />
                        </IconButton>
                        <IconButton
                          size="xs"
                          variant="ghost"
                          aria-label={text.review.pendingDelete}
                          tooltip={text.review.pendingDelete}
                          isDisabled={busy}
                          onPress={() => onPendingChange(removePendingComment(pending, item.id))}
                          data-testid="gh-pr-pending-delete"
                        >
                          <Trash2 size={12} aria-hidden />
                        </IconButton>
                      </div>
                      {editing?.id === item.id ? (
                        <div className="gh-pr-act__form">
                          <TextArea aria-label={text.review.pendingEdit} value={editing.body} onChange={(value) => setEditing({ id: item.id, body: value })} rows={3} size="sm" autoFocus />
                          <div className="gh-pr-act__footer">
                            <Button size="xs" variant="ghost" onPress={() => setEditing(null)}>
                              {text.edit.cancel}
                            </Button>
                            <Button
                              size="xs"
                              variant="primary"
                              onPress={() => {
                                onPendingChange(updatePendingComment(pending, item.id, editing.body))
                                setEditing(null)
                              }}
                            >
                              {text.review.pendingSave}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <p className="gh-pr-act__pending-body">{item.body}</p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <Notice variant="hint">{text.review.pendingEmpty}</Notice>
              )}
            </section>
            <PrActionStatus controller={action} text={text.result} onRefresh={onRefresh} />
            <DialogFooter>
              <Button variant="ghost" onPress={onClose} isDisabled={busy}>
                {text.edit.cancel}
              </Button>
              <Button
                variant={event === 'REQUEST_CHANGES' ? 'danger' : 'primary'}
                onPress={() => void submit()}
                isPending={busy}
                data-testid="gh-pr-review-submit"
              >
                {text.review.submit}
              </Button>
            </DialogFooter>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
