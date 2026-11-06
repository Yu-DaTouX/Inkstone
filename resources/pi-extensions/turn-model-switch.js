import { readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PENDING_MODEL_SWITCH_DIR = 'pending-model-switch'

const SUBAGENT_NOTICE = /^\s*<subagent-notification\b/

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

export function createTurnModelSwitch(pi, root) {
  let queuedSteers = 0
  return {
    onInput(event) {
      if (event?.streamingBehavior === 'steer') queuedSteers += 1
    },
    onAgentEnd() {
      queuedSteers = 0
    },
    async onMessageStart(event, ctx) {
      const message = event?.message
      if (message?.role !== 'user') return
      if (queuedSteers > 0) {
        queuedSteers -= 1
        return
      }
      if (SUBAGENT_NOTICE.test(textOf(message.content))) return
      const target = takePendingSwitch(ctx?.sessionManager?.getSessionId?.(), root ?? yanDir())
      if (!target) return
      if (target.provider && target.id) {
        const model = ctx?.modelRegistry?.find?.(target.provider, target.id)
        if (model) await pi.setModel(model)
      }
      if (target.thinkingLevel) pi.setThinkingLevel(target.thinkingLevel)
    }
  }
}

export default function turnModelSwitch(pi) {
  const handlers = createTurnModelSwitch(pi)
  pi.on('input', handlers.onInput)
  pi.on('agent_end', handlers.onAgentEnd)
  pi.on('message_start', handlers.onMessageStart)
}
