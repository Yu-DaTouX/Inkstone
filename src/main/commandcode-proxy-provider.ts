import { pick } from '../shared/ui-lang'
import { discoverCustomProviderModels, listCustomProviders, saveCustomProvider } from './custom-providers'
import type { CustomProviderModel } from '../shared/custom-provider'
import { COMMANDCODE_PROXY_PROVIDER } from '../shared/plugin-catalog'

export { COMMANDCODE_PROXY_PLUGIN, COMMANDCODE_PROXY_PROVIDER } from '../shared/plugin-catalog'
const CATALOG_BASE_URL = 'https://api.commandcode.ai/provider/v1'
const API = 'openai-completions'

type Discover = typeof discoverCustomProviderModels

export async function ensureCommandCodeProxyProvider(
  baseUrl: string,
  deps: { list?: typeof listCustomProviders; save?: typeof saveCustomProvider; discover?: Discover } = {}
): Promise<{ created: boolean; error?: string }> {
  const list = deps.list ?? listCustomProviders
  const save = deps.save ?? saveCustomProvider
  const discover = deps.discover ?? discoverCustomProviderModels
  if ((await list()).some((provider) => provider.id === COMMANDCODE_PROXY_PROVIDER)) return { created: false }
  let models: CustomProviderModel[] = []
  for (const source of [CATALOG_BASE_URL, baseUrl]) {
    const found = await discover({ id: COMMANDCODE_PROXY_PROVIDER, api: API, baseUrl: source }).catch(() => null)
    if (!found?.ok) continue
    const entries: CustomProviderModel[] = found.entries ?? found.models.map((id) => ({ id }))
    models = entries.map(({ api: _api, baseUrl: _baseUrl, ...model }) => model)
    if (models.length) break
  }
  if (!models.length) return { created: false, error: pick('没能取到 Command Code 模型列表', 'Could not fetch the Command Code model list') }
  const result = await save({ id: COMMANDCODE_PROXY_PROVIDER, api: API, baseUrl, models })
  return result.ok ? { created: true } : { created: false, error: result.errors?.join('；') }
}
