import { useEffect, useState, type JSX } from 'react'
import { ImageDown } from 'lucide-react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button } from '../../ui'
import { MessageImage } from './Image'
import type { RemoteImageResult } from '../../../../shared/ipc'

type RemoteState = { phase: 'checking' } | { phase: 'idle' } | { phase: 'loading' } | { phase: 'ready'; dataUrl: string } | { phase: 'failed'; code: string }

const loaded = new Map<string, string>()

export function remoteImageHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function remoteImageState(result: RemoteImageResult, prompted: boolean): RemoteState {
  if (result.ok) return { phase: 'ready', dataUrl: result.dataUrl }
  if (result.code === 'needs-consent' && !prompted) return { phase: 'idle' }
  return { phase: 'failed', code: result.code }
}

export function RemoteImage({ src, alt, className }: { src: string; alt?: string; className?: string }): JSX.Element {
  const t = useT()
  const sessionId = useStore((s) => s.session?.sessionId ?? s.session?.conversationId ?? '')
  const cached = loaded.get(src)
  const [state, setState] = useState<RemoteState>(cached ? { phase: 'ready', dataUrl: cached } : { phase: 'checking' })

  const load = async (prompt: boolean): Promise<void> => {
    const bridge = window.yan?.browser
    if (!bridge?.remoteImage) {
      setState({ phase: 'failed', code: 'denied' })
      return
    }
    if (prompt) setState({ phase: 'loading' })
    const result = await bridge.remoteImage(sessionId, src, prompt).catch((): RemoteImageResult => ({ ok: false, code: 'network' }))
    if (result.ok) loaded.set(src, result.dataUrl)
    setState(remoteImageState(result, prompt))
  }

  useEffect(() => {
    if (loaded.has(src)) return
    void load(false)
  }, [src, sessionId])

  if (state.phase === 'ready') return <MessageImage src={state.dataUrl} alt={alt} className={className} />
  const host = remoteImageHost(src)
  const label = state.phase === 'failed'
    ? t(state.code === 'denied' ? 'chat.remoteImageDenied' : 'chat.remoteImageFailed', { host })
    : t('chat.remoteImageLoad', { host })
  return (
    <Button
      size="sm"
      variant="secondary"
      className="v3-remote-image"
      data-testid="v3-remote-image"
      data-phase={state.phase}
      isDisabled={state.phase === 'checking' || state.phase === 'loading'}
      onPress={() => void load(true)}
      aria-label={alt ? `${label} · ${alt}` : label}
    >
      <ImageDown size={14} aria-hidden />
      {label}
    </Button>
  )
}
