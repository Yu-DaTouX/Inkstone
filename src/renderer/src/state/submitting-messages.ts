import type { UIMessage } from '../../../shared/ipc'
import type { ComposerSubmitIdentity } from './composer-recovery'

export interface SubmittingMessage {
  identity: ComposerSubmitIdentity
  message: UIMessage
  previousIds: string[]
}

export function withSubmittingMessages(messages: UIMessage[], submissions: SubmittingMessage[]): UIMessage[] {
  const pending = submissions.filter((item) => !messages.some((message) =>
    message.role === 'user' && message.text === item.message.text && !item.previousIds.includes(message.id)
  ))
  return pending.length ? [...messages, ...pending.map((item) => item.message)] : messages
}
