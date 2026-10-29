import { useState, type ReactElement } from 'react'
import type { ApiKeyView } from '../../../../../shared/api-keys'
import { Badge, Button, TextField } from '../../../ui'
import { useT } from '../../../i18n'
import { useModelsText } from './models-text'

interface ApiKeyListProps {
  provider: string
  keys: ApiKeyView[]
  disabled?: boolean
  onDone(result: { ok: boolean; error?: string }, switched?: ApiKeyView): Promise<void> | void
}

export function ApiKeyList({ provider, keys, disabled, onDone }: ApiKeyListProps): ReactElement {
  const t = useT()
  const text = useModelsText()
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const locked = disabled || busy

  const act = async (work: () => Promise<{ ok: boolean; error?: string }>, switched?: ApiKeyView): Promise<void> => {
    setBusy(true)
    try {
      const r = await work().catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      if (r.ok) {
        setRenaming(null)
        setDeleting(null)
      }
      await onDone(r, r.ok ? switched : undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ul className="ms-keys" aria-label={text('keyList')} data-testid={`ms-keys-${provider}`}>
      {keys.map((k) => (
        <li className="ms-key" key={k.id} data-active={k.active ? '1' : '0'} data-testid={`ms-key-${provider}-${k.id}`}>
          {renaming?.id === k.id ? (
            <form
              className="ms-key-rename"
              onSubmit={(e) => {
                e.preventDefault()
                if (renaming.draft.trim()) void act(() => window.yan.renameApiKey(provider, k.id, renaming.draft))
              }}
            >
              <TextField
                className="ms-key-rename-field"
                aria-label={text('keyRename')}
                value={renaming.draft}
                onChange={(draft) => setRenaming({ id: k.id, draft })}
                maxLength={40}
                isDisabled={locked}
                autoFocus
              />
              <Button variant="primary" size="sm" type="submit" isDisabled={locked || !renaming.draft.trim()}>
                {t('auth.save')}
              </Button>
              <Button variant="secondary" size="sm" isDisabled={locked} onPress={() => setRenaming(null)}>
                {t('ui.cancel')}
              </Button>
            </form>
          ) : (
            <>
              <span className="ms-key-label">{k.label}</span>
              <code className="ms-key-mask">{k.masked}</code>
              <span className="ms-key-actions">
                {k.active ? (
                  <Badge tone="ok">{text('keyCurrent')}</Badge>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    isDisabled={locked}
                    data-testid={`ms-key-use-${provider}-${k.id}`}
                    onPress={() => void act(() => window.yan.switchApiKey(provider, k.id), k)}
                  >
                    {text('keyUse')}
                  </Button>
                )}
                <Button variant="ghost" size="sm" isDisabled={locked} onPress={() => { setDeleting(null); setRenaming({ id: k.id, draft: k.label }) }}>
                  {text('keyRename')}
                </Button>
                {deleting === k.id ? (
                  <Button variant="danger" size="sm" isDisabled={locked} onPress={() => void act(() => window.yan.removeApiKey(provider, k.id))}>
                    {text('keyDeleteConfirm')}
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" isDisabled={locked} onPress={() => setDeleting(k.id)}>
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
