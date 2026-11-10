import { readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isHostAutomatedMessage } from './host-message.js'

export const PENDING_MODEL_SWITCH_DIR = 'pending-model-switch'

const yanDir = () => process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')

export function pendingSwitchFile(sessionId, root = yanDir()) {
  return join(root, PENDING_MODEL_SWITCH_DIR, `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`)
}

export function takePendingSwitch(sessionId, root = yanDir()) {
  if (!sessionId) return null
  const file = pendingSwitchFile(sessionId, root)
  try {
    const target = JSON.parse(readFileSync(file, 'utf8'))
    rmSync(file, { force: true })
    return target && typeof target === 'object' && !Array.isArray(target) ? target : null
  } catch {
    return null
  }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('')
}

function endedWithError(messages) {
  if (!Array.isArray(messages)) return false
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return messages[i].stopReason === 'error'
  }
  return false
}

export function createTurnModelSwitch(pi, root) {
  let queuedSteers = 0
  const apply = async (ctx) => {
    const target = takePendingSwitch(ctx?.sessionManager?.getSessionId?.(), root ?? yanDir())
    if (!target) return
    if (target.provider && target.id) {
      const model = ctx?.modelRegistry?.find?.(target.provider, target.id)
      if (model) await pi.setModel(model)
    }
    if (target.thinkingLevel) pi.setThinkingLevel(target.thinkingLevel)
  }
  const runIdle = (ctx) => !ctx?.hasPendingMessages?.()
  return {
    onInput(event) {
      if (event?.streamingBehavior === 'steer') queuedSteers += 1
    },
    async onAgentEnd(event, ctx) {
      queuedSteers = 0
      if (endedWithError(event?.messages) || !runIdle(ctx)) return
      await apply(ctx)
    },
    async onAgentSettled(_event, ctx) {
      if (runIdle(ctx)) await apply(ctx)
    },
    async onMessageStart(event, ctx) {
      const message = event?.message
      if (message?.role !== 'user') return
      if (queuedSteers > 0) {
        queuedSteers -= 1
        return
      }
      if (isHostAutomatedMessage(textOf(message.content))) return
      await apply(ctx)
    }
  }
}

export default function turnModelSwitch(pi) {
  const handlers = createTurnModelSwitch(pi)
  pi.on('input', handlers.onInput)
  pi.on('agent_end', handlers.onAgentEnd)
  pi.on('agent_settled', handlers.onAgentSettled)
  pi.on('message_start', handlers.onMessageStart)
}
