import {
  buildEffectivePolicyDocument,
  contextPolicyRevision,
  resolveContextPolicy,
  type ContextPolicyLayers,
  type ResolvedContextPolicy
} from '../shared/context-policy'
import type { ContextPolicyOverrides } from '../shared/ipc'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ContextPolicySettingsLayer {
  user?: ContextPolicyOverrides
  byModel?: Record<string, ContextPolicyOverrides>
  foldEnabled?: boolean
}

let settingsLayer: ContextPolicySettingsLayer = {}

export function setContextPolicySettings(next: ContextPolicySettingsLayer | null | undefined): void {
  settingsLayer = {
    user: next?.user,
    byModel: next?.byModel,
    foldEnabled: next?.foldEnabled
  }
}

export function contextPolicySettings(): ContextPolicySettingsLayer {
  return {
    user: settingsLayer.user ? { ...settingsLayer.user } : undefined,
    byModel: settingsLayer.byModel ? { ...settingsLayer.byModel } : undefined,
    foldEnabled: settingsLayer.foldEnabled
  }
}

export function activeContextPolicy(
  env: NodeJS.ProcessEnv = process.env,
  modelKey?: string
): ResolvedContextPolicy {
  const layers: ContextPolicyLayers = {
    user: settingsLayer.user,
    byModel: settingsLayer.byModel,
    modelKey,
    envRaw: env.YAN_CONTEXT_POLICY,
    foldEnabled: settingsLayer.foldEnabled
  }
  return resolveContextPolicy(layers)
}

const effectiveRevisions = new Map<string, string>()
const desiredRevisions = new Map<string, string>()
const effectiveWrites = new Map<string, Promise<string | null>>()

export async function syncEffectivePolicyFile(
  dataDir: string,
  input: {
    user?: ContextPolicyOverrides
    byModel?: Record<string, ContextPolicyOverrides>
    foldEnabled?: boolean
  }
): Promise<string | null> {
  const revision = contextPolicyRevision(input)
  const key = join(dataDir, 'context-policy.effective.json')
  desiredRevisions.set(key, revision)
  const prior = effectiveWrites.get(key)
  if (!prior && effectiveRevisions.get(key) === revision) return revision
  const write = (prior ?? Promise.resolve(null)).catch(() => null).then(async () => {
    if (desiredRevisions.get(key) !== revision) return null
    if (effectiveRevisions.get(key) === revision) return revision
    try {
      await mkdir(dataDir, { recursive: true })
      await writeFile(key, `${JSON.stringify(buildEffectivePolicyDocument(input))}\n`, 'utf8')
      effectiveRevisions.set(key, revision)
      return revision
    } catch { return null }
  })
  effectiveWrites.set(key, write)
  try { return await write } finally { if (effectiveWrites.get(key) === write) effectiveWrites.delete(key) }
}
