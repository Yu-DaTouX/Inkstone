import { callModel, type ModelCallRuntime } from './model-call'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import { getSettings } from './settings'

const PLUGIN_TIMEOUT_MS = 60_000
const PLUGIN_MAX_OUTPUT_CHARS = 128_000

let providerExtensions: () => string[] = () => []

export function setModelCallProviderExtensions(resolve: () => string[]): void {
  providerExtensions = resolve
}

export async function appModelRuntime(): Promise<ModelCallRuntime> {
  const settings = await getSettings()
  return { cwd: YAN_DIR, piBin: settings.piBin, extensions: providerExtensions(), env: { PI_CODING_AGENT_DIR: PI_AGENT_DIR, YAN_DATA_DIR: YAN_DIR } }
}

export async function completePluginText(model: string, system: string, prompt: string, signal: AbortSignal): Promise<string> {
  const runtime = await appModelRuntime()
  const result = await callModel({ model, system, prompt, thinking: 'off', timeoutMs: PLUGIN_TIMEOUT_MS, maxOutputChars: PLUGIN_MAX_OUTPUT_CHARS, signal }, runtime)
  return result.text
}
