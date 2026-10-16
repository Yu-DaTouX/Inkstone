/**
 * 手动派发子 Agent 的表单（输入区「＋」菜单进入）。
 *
 * 复用正式启动链 `window.yan.subagents.start(task, model, isolation)`，不另造任务模型：
 * 模型默认沿用上次选择（「跟随当前会话模型」或具体模型），执行位置三选一（当前文件夹 /
 * 只读 / worktree 隔离）。CC 订阅模型不支持只读，选了只读就把按钮收住并说明。
 * 派出成功后在旁边分屏打开这条子 Agent 的转录（手动派发的不一定挂在某一轮对话下，
 * 不打开就找不到）。派发归属固定为当前活动会话，所以只在正在看的就是活动会话时可用。
 */
import { useEffect, useMemo, useState, type JSX } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, Dialog, ListBoxItem, Modal, ModalOverlay, Select, TextArea } from '../../ui'
import { subagentModelError } from '../../../../shared/subagent-pi-launch'
import { openSubagentPane } from '../session/SubagentLine'
import type { SubagentRun } from '../../../../shared/ipc'

const FOLLOW = 'follow'

export function DelegateDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }): JSX.Element {
  const t = useT()
  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal>
        <Dialog title={t('hub.title')} closeLabel={t('ui.cancel')} data-testid="v3-delegate-dialog">
          {({ close }) => <DelegateForm onDone={close} />}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

function DelegateForm({ onDone }: { onDone: () => void }): JSX.Element {
  const t = useT()
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const models = useStore((s) => s.models)
  const patchSettings = useStore((s) => s.patchSettings)

  const [task, setTask] = useState('')
  const [model, setModel] = useState<string>(() => {
    const last = settings?.lastSubagentModel
    return last && last !== 'follow' ? `${last.provider}/${last.id}` : FOLLOW
  })
  const [isolation, setIsolation] = useState<SubagentRun['isolation']>('shared-cwd')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const currentModel = session?.model ? `${session.model.provider}/${session.model.id}` : undefined
  const resolvedModel = model === FOLLOW ? currentModel : model
  const picked = models.find((item) => `${item.provider}/${item.id}` === resolvedModel)
  const cwd = session?.cwd || settings?.cwd || ''
  const readOnlyError = subagentModelError(resolvedModel, true)
  const validationError =
    isolation === 'controlled-cwd' && readOnlyError
      ? t('delegate.ccReadOnly')
      : !resolvedModel
        ? t('delegate.noModel')
        : !picked
          ? t('models.unavailable')
          : ''

  /* 只读不可用时自动退回当前文件夹，避免提交一个必然失败的组合 */
  useEffect(() => {
    if (isolation === 'controlled-cwd' && readOnlyError) setIsolation('shared-cwd')
  }, [isolation, readOnlyError])

  const options = useMemo(
    () => [
      { id: FOLLOW, label: `${t('delegate.follow')}${currentModel ? ` · ${currentModel}` : ''}` },
      ...models.map((item) => ({ id: `${item.provider}/${item.id}`, label: `${item.name ?? item.id} · ${item.provider}` }))
    ],
    [models, currentModel, t]
  )

  const submit = async (): Promise<void> => {
    if (!task.trim() || busy || validationError) return
    setBusy(true)
    setError('')
    try {
      const result = await window.yan.subagents.start(task.trim(), resolvedModel, isolation)
      if (!result.ok || !result.run) {
        setError(result.error ?? t('delegate.failed'))
        return
      }
      /* 记住这次的模型选择：跟随就存 'follow'，具体模型存它的身份 */
      if (picked) {
        void patchSettings({
          lastSubagentModel: model === FOLLOW ? 'follow' : { provider: picked.provider, id: picked.id, name: picked.name }
        }).catch(() => undefined)
      }
      await useStore.getState().loadSubagents()
      onDone()
      openSubagentPane(result.run.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="v3-delegate"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <TextArea
        label={t('delegate.task')}
        value={task}
        onChange={setTask}
        rows={4}
        autoFocus
        isDisabled={busy}
        data-testid="v3-delegate-task"
      />
      <div className="v3-delegate-row">
        <Select
          label={t('delegate.model')}
          selectedKey={model}
          onSelectionChange={(key) => setModel(String(key))}
          isDisabled={busy}
          data-testid="v3-delegate-model"
        >
          {options.map((option) => (
            <ListBoxItem key={option.id} id={option.id} textValue={option.label}>
              {option.label}
            </ListBoxItem>
          ))}
        </Select>
        <Select
          label={t('delegate.scope')}
          selectedKey={isolation}
          onSelectionChange={(key) => setIsolation(String(key) as SubagentRun['isolation'])}
          isDisabled={busy}
          disabledKeys={readOnlyError ? ['controlled-cwd'] : []}
          data-testid="v3-delegate-scope"
        >
          <ListBoxItem id="shared-cwd" textValue={t('delegate.folder')}>{t('delegate.folder')}</ListBoxItem>
          <ListBoxItem id="controlled-cwd" textValue={t('sa.readOnly')}>{t('sa.readOnly')}</ListBoxItem>
          <ListBoxItem id="worktree" textValue={t('delegate.worktree')}>{t('delegate.worktree')}</ListBoxItem>
        </Select>
      </div>
      <p className="v3-delegate-target" data-testid="v3-delegate-target">
        {picked?.name ?? resolvedModel ?? t('delegate.noModel')} · {cwd || t('delegate.noFolder')}
      </p>
      {readOnlyError ? <p className="v3-delegate-hint" data-testid="v3-delegate-readonly-hint">{t('delegate.ccReadOnly')}</p> : null}
      {validationError ? <p className="v3-delegate-error" role="alert">{validationError}</p> : null}
      {error ? <p className="v3-delegate-error" role="alert" data-testid="v3-delegate-error">{error}</p> : null}
      <div className="v3-delegate-actions">
        <Button variant="secondary" onPress={onDone} isDisabled={busy}>
          {t('ui.cancel')}
        </Button>
        <Button type="submit" variant="primary" isDisabled={busy || !task.trim() || !!validationError} data-testid="v3-delegate-start">
          {t('delegate.start')}
        </Button>
      </div>
    </form>
  )
}
