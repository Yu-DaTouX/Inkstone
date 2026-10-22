import { useState, type JSX } from 'react'
import { useT } from '../../i18n'
import { Button } from '../../ui'
import { useWidgetIdentity } from './widget-lifecycle'

export function SaveAsArtifactButton({
  filename,
  sourceKey,
  content
}: {
  filename: string
  sourceKey: string
  content: () => string
}): JSX.Element | null {
  const t = useT()
  const identity = useWidgetIdentity()
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const sessionId = identity?.sessionId
  const messageId = identity?.messageId
  if (!sessionId || !messageId) return null
  const save = async (): Promise<void> => {
    setState('saving')
    try {
      const result = await window.yan.saveInlineArtifact({ sessionId, messageId, filename, content: content(), sourceKey })
      setState(result.ok ? 'saved' : 'error')
    } catch {
      setState('error')
    }
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      isDisabled={state === 'saving'}
      onPress={() => void save()}
      data-testid="v3-save-as-artifact"
    >
      {state === 'saved' ? t('artifact.saved') : state === 'error' ? t('artifact.saveFailed') : t('artifact.saveAs')}
    </Button>
  )
}

export function shortHash(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
