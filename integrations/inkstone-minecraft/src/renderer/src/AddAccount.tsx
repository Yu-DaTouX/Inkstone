import { useState, type ReactElement } from 'react'
import { ArrowLeft, Globe, KeyRound, UserRound } from 'lucide-react'
import { Button } from '@yan/ui/Button'
import { IconButton } from '@yan/ui/IconButton'
import { TextField } from '@yan/ui/TextField'

const OFFLINE_NAME = /^[A-Za-z0-9_]{3,16}$/

interface Props {
  canGoBack: boolean
  onBack(): void
  onAddOffline(name: string): Promise<void>
}

export function AddAccount({ canGoBack, onBack, onAddOffline }: Props): ReactElement {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const valid = OFFLINE_NAME.test(name)

  const submit = async (): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    setError('')
    try {
      await onAddOffline(name)
      setName('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="add-account">
      <div className="add-account__head">
        {canGoBack ? (
          <IconButton aria-label="返回账号列表" size="sm" onPress={onBack}>
            <ArrowLeft size={16} />
          </IconButton>
        ) : null}
        <h2 className="add-account__title">添加账号</h2>
      </div>
      <form
        className="add-account__offline"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <TextField
          label="离线玩家名"
          value={name}
          onChange={(value) => setName(value.trim())}
          maxLength={16}
          placeholder="3–16 位字母、数字或下划线"
          isInvalid={(name.length > 0 && !valid) || !!error}
          errorMessage={error || '只能用 3–16 位字母、数字或下划线'}
          spellCheck="false"
          autoFocus
        />
        <Button type="submit" variant="primary" block icon={<UserRound size={14} />} isDisabled={!valid || busy}>
          {busy ? '正在添加…' : '添加离线账号'}
        </Button>
      </form>
      <div className="add-account__online">
        <Button variant="secondary" block icon={<KeyRound size={14} />} isDisabled>
          微软正版登录
        </Button>
        <p className="add-account__hint">等 Mojang 审核通过后开放。</p>
        <Button variant="secondary" block icon={<Globe size={14} />} isDisabled>
          LittleSkin · 外置登录
        </Button>
        <p className="add-account__hint">正在接入，PCL 迁移来的账号会保留在列表里。</p>
      </div>
    </div>
  )
}
