import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { ModelChangeNotice } from '../../ui/ModelChangeNotice'

export function PendingModelChange() {
  const t = useT()
  const pending = useStore((s) => s.session?.pendingModelChange)
  const model = useStore((s) => s.session?.model)
  const level = useStore((s) => s.session?.thinkingLevel ?? 'off')
  if (!pending) return null
  const label = (value: string) => value === 'xhigh' ? 'XHigh' : value.charAt(0).toUpperCase() + value.slice(1)
  const modelChanged = pending.previousModel?.provider !== model?.provider || pending.previousModel?.id !== model?.id
  const thinkingChanged = pending.previousThinkingLevel !== level
  const display = (name: string | undefined, thinking: string) => [modelChanged ? name : null, thinkingChanged ? label(thinking) : null].filter(Boolean).join(' · ')
  return (
    <ModelChangeNotice
      label={t('composer.modelChange.pending')}
      previous={display(pending.previousModel?.name ?? pending.previousModel?.id, pending.previousThinkingLevel)}
      next={display(model?.name ?? model?.id, level)}
    />
  )
}
