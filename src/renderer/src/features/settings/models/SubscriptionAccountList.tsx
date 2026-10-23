import { useState, type ReactElement } from 'react'
import type { OAuthAccountView } from '../../../../../shared/oauth-accounts'
import { Badge, Button, TextField } from '../../../ui'
import { useT } from '../../../i18n'
import { useModelsText } from './models-text'

interface Account extends OAuthAccountView {
  plan?: string
}

interface SubscriptionAccountListProps {
  provider: string
  name: string
  accounts: Account[]
  disabled: boolean
  onSwitch(account: Account): void
  onRemove(account: Account): void
  onRename?(account: Account, label: string): void
}

export function SubscriptionAccountList({ provider, name, accounts, disabled, onSwitch, onRemove, onRename }: SubscriptionAccountListProps): ReactElement {
  const t = useT()
  const text = useModelsText()
  const [deleting, setDeleting] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ key: string; draft: string } | null>(null)

  return (
    <ul className="ms-keys" aria-label={text('accountList').replace('{provider}', name)} data-testid={`ms-${provider}-accounts`}>
      {accounts.map((account, index) => (
        <li className="ms-key" key={account.key} data-active={account.active ? '1' : '0'}>
          {renaming?.key === account.key ? (
            <form className="ms-key-rename" onSubmit={(event) => {
              event.preventDefault()
              if (renaming.draft.trim()) {
                onRename?.(account, renaming.draft)
                setRenaming(null)
              }
            }}>
              <TextField aria-label={text('keyRename')} value={renaming.draft} onChange={(draft) => setRenaming({ key: account.key, draft })} maxLength={40} isDisabled={disabled} autoFocus />
              <Button variant="primary" size="sm" type="submit" isDisabled={disabled || !renaming.draft.trim()}>{t('auth.save')}</Button>
              <Button variant="secondary" size="sm" isDisabled={disabled} onPress={() => setRenaming(null)}>{t('ui.cancel')}</Button>
            </form>
          ) : (
            <>
              <span className="ms-key-label" title={account.email}>{account.label || account.email || `${name} · ${index + 1}`}</span>
              {account.plan ? <span className="ms-key-mask">{account.plan}</span> : null}
              <span className="ms-key-actions">
                {account.active ? (
                  <Badge tone="ok">{text('keyCurrent')}</Badge>
                ) : (
                  <Button variant="secondary" size="sm" isDisabled={disabled} data-testid={`ms-${provider}-use`} onPress={() => { setDeleting(null); onSwitch(account) }}>
                    {text('keyUse')}
                  </Button>
                )}
                {onRename ? (
                  <Button variant="ghost" size="sm" isDisabled={disabled} onPress={() => { setDeleting(null); setRenaming({ key: account.key, draft: account.label || account.email || '' }) }}>
                    {text('keyRename')}
                  </Button>
                ) : null}
                {deleting === account.key ? (
                  <Button variant="danger" size="sm" isDisabled={disabled} data-testid={`ms-${provider}-remove-confirm`} onPress={() => { setDeleting(null); onRemove(account) }}>
                    {text('keyDeleteConfirm')}
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" isDisabled={disabled} data-testid={`ms-${provider}-remove`} onPress={() => setDeleting(account.key)}>
                    {text('keyDelete')}
                  </Button>
                )}
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}
