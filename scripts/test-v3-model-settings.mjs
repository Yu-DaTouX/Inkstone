import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(
  new URL('../src/renderer/src/features/settings/models/models-model.ts', import.meta.url)
)
const result = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const {
  canRemoveCredential,
  credentialFromEnv,
  entryState,
  isFavorite,
  mergeDiscoveredModels,
  toggleFavorite
} = mod

const provider = (over = {}) => ({
  id: over.id ?? 'p',
  name: over.name ?? 'P',
  kind: over.kind ?? 'api_key',
  envVar: over.envVar ?? '',
  authKey: over.authKey ?? '',
  status: over.status ?? 'missing',
  ...over
})

assert.equal(entryState(provider({ status: 'ready' })), 'ready', '条目自身的已配置状态')
assert.equal(entryState(provider({ status: 'missing', kind: 'subscription', inAppLogin: true })), 'loginable')
assert.equal(entryState(provider({ status: 'unknown' })), 'unknown')
assert.equal(entryState(provider({ status: 'missing' })), 'missing', 'API key 未配置')

assert.equal(
  canRemoveCredential(provider({ status: 'ready', source: 'auth.json' })),
  true,
  'auth.json 的凭证可移除'
)
assert.equal(
  canRemoveCredential(provider({ status: 'ready', source: 'env' })),
  false,
  '环境变量凭证不可在界面移除'
)
assert.equal(credentialFromEnv(provider({ status: 'ready', source: 'env' })), true)
assert.equal(credentialFromEnv(provider({ status: 'ready', source: 'auth.json' })), false)
assert.equal(canRemoveCredential(provider({ status: 'missing' })), false)

assert.equal(isFavorite([], { provider: 'a', id: '1' }), false)
assert.equal(isFavorite([{ provider: 'a', id: '1' }], { provider: 'a', id: '1' }), true)
const added = toggleFavorite([], { provider: 'a', id: '1', name: 'One' })
assert.deepEqual(added, [{ provider: 'a', id: '1', name: 'One' }])
const readded = toggleFavorite(added, { provider: 'a', id: '1', name: 'One' })
assert.deepEqual(readded, [], '再点一次取消收藏')
assert.deepEqual(
  toggleFavorite([{ provider: 'a', id: '1' }], { provider: 'a', id: '2' }).map((m) => m.id),
  ['1', '2'],
  '不同模型各自收藏，不去重错误'
)

assert.equal(mergeDiscoveredModels([{ id: 'a', name: 'typed' }], [{ id: 'a', protocol: 'chat' }, { id: 'b' }], (draft, found) => ({ ...found, ...draft }))[0].name, 'typed', '重新发现模型时保留用户改过的名字')

console.log('v3 模型与服务纯逻辑单测通过（已配置状态 / 凭证门禁 / 收藏 / 重新发现模型）')
