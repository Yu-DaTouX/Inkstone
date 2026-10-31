import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STATE_KEY = Symbol.for('yan.cacheRetention')

export const usesSubscriptionLogin = (auth, provider) => auth?.[provider]?.type === 'oauth'

export const wantsLongCache = (model, auth) =>
  model?.provider === 'anthropic' && model?.api === 'anthropic-messages' && usesSubscriptionLogin(auth, 'anthropic')

function readAuth() {
  try {
    const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
    return JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))
  } catch {
    return null
  }
}

export default function cacheRetention(pi) {
  const state = (globalThis[STATE_KEY] ??= { explicit: !!process.env.PI_CACHE_RETENTION })
  if (state.explicit) return

  let last
  const apply = (candidate) => {
    const model = candidate ?? last
    if (!model) return
    last = model
    if (wantsLongCache(model, readAuth())) process.env.PI_CACHE_RETENTION = 'long'
    else delete process.env.PI_CACHE_RETENTION
  }

  pi.on('session_start', (_event, ctx) => apply(ctx?.model))
  pi.on('model_select', (event, ctx) => apply(event?.model ?? ctx?.model))
  pi.on('before_agent_start', (_event, ctx) => apply(ctx?.model))
  pi.on('turn_start', (_event, ctx) => apply(ctx?.model))
}
