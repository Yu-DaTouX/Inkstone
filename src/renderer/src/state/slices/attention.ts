import type { AppSettings, ModelInfo, SoundEvent, UIMessage } from '../../../../shared/ipc'
import { uiText } from '../../i18n/ui-text'
import { playSound } from '../../lib/sound'
import { useStore } from '../store'

function attentionTitle(event: SoundEvent): string {
  switch (event) {
    case 'done':
      return uiText('state.attention.done')
    case 'question':
      return uiText('state.attention.question')
    case 'error':
      return uiText('state.attention.error')
  }
}

const QUESTION_REMIND_MS = 120_000

function questionPending(requestId: string): boolean {
  const state = useStore.getState()
  if (state.uiRequests.some((request) => request.id === requestId)) return true
  return Object.values(state.sessionRuntimes).some((runtime) => runtime?.uiRequests.some((request) => request.id === requestId))
}

function remindQuestionLater(requestId: string, body: string | undefined, sessionId: string | undefined): void {
  window.setTimeout(() => {
    if (!questionPending(requestId) || document.hasFocus()) return
    if (useStore.getState().settings?.sound?.notifications === false) return
    void window.yan
      .notifyAttention({ kind: 'question', title: attentionTitle('question'), body, ...(sessionId ? { sessionId } : {}) })
      .catch(() => {
      })
  }, QUESTION_REMIND_MS)
}

export function alertAttention(settings: AppSettings | null, event: SoundEvent, body?: string, title?: string, source?: ModelInfo | null, sessionId?: string, requestId?: string): void {
  if (event === 'question' && requestId) remindQuestionLater(requestId, body, sessionId)
  const model = source === undefined ? useStore.getState().session?.model : source
  const sound = settings?.sound
  const audible = !!sound?.enabled && !!sound.events?.[event]
  if (audible) playSound(event, sound.volume)
  const notify = event === 'question' ? sound?.notifications !== false : audible && !!sound?.notifications
  if (notify && typeof document !== 'undefined' && !document.hasFocus()) {
    void window.yan
      .notifyAttention({
        kind: event,
        title: title || attentionTitle(event),
        body,
        ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
        ...(sessionId ? { sessionId } : {})
      })
      .catch(() => {
      })
  }
}

export function alertTurnSettled(
  settings: AppSettings | null,
  event: SoundEvent,
  sessionId: string,
  label: string,
  messages: readonly UIMessage[],
  source?: ModelInfo | null
): void {
  const reply = [...messages].reverse().find((msg) => msg.role === 'assistant' && msg.text.trim())?.text ?? ''
  const excerpt = reply.replace(/[#>*_`|]+/g, ' ').replace(/\s+/g, ' ').trim()
  const body = excerpt.length > 120 ? `${excerpt.slice(0, 119)}…` : excerpt
  alertAttention(settings, event, body || undefined, label ? `${attentionTitle(event)} · ${label}` : undefined, source, sessionId)
}
