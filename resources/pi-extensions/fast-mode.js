import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const FAST_SERVICE_TIER = 'priority'

const FAST_CODEX_MODEL = /^gpt-6(?:\.\d+)?-(?:sol|terra|astra|luna)(?:$|-)/

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const yanDir = () => process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')

export const fastModeEnabled = (settings) => settings?.fastMode === true

export function fastModeSupported(model) {
  return model?.provider === 'openai-codex' && model?.api === 'openai-codex-responses' && FAST_CODEX_MODEL.test(String(model?.id ?? ''))
}

export function withFastServiceTier(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  if (payload.service_tier === FAST_SERVICE_TIER) return undefined
  return { ...payload, service_tier: FAST_SERVICE_TIER }
}

export default function fastMode(pi) {
  pi.on('before_provider_request', (event, ctx) => {
    if (!fastModeSupported(ctx?.model)) return
    if (!fastModeEnabled(readJson(join(yanDir(), 'desktop.json')))) return
    return withFastServiceTier(event?.payload)
  })
}
