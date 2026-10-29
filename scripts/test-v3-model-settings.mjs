import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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

await build({
  stdin: {
    contents: `export { SubscriptionAccountList } from './src/renderer/src/features/settings/models/SubscriptionAccountList';
      export { ApiKeyList } from './src/renderer/src/features/settings/models/ApiKeyList';
      export { I18nProvider } from './src/renderer/src/i18n';`,
    resolveDir: process.cwd(), loader: 'tsx'
  },
  outfile: 'out/test/codex-account-list.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react-dom/server', 'react-aria-components', 'react-aria', 'react-stately', '@react-aria/*', '@react-stately/*', '@react-types/*', 'lucide-react']
})
const ui = await import(pathToFileURL(resolve('out/test/codex-account-list.mjs')).href)
const accounts = [
  { key: 'chatgpt:a:u', email: 'a@example.com', plan: 'plus', active: true },
  { key: 'chatgpt:b:v', email: 'b@example.com', plan: 'pro', active: false }
]
const renderAccounts = (rows, disabled = false) => renderToStaticMarkup(createElement(ui.I18nProvider, null,
  createElement(ui.SubscriptionAccountList, { provider: 'codex', name: 'ChatGPT', accounts: rows, disabled, onSwitch() {}, onRemove() {} })))
const single = renderAccounts(accounts.slice(0, 1))
assert.ok(single.includes('a@example.com') && single.includes('当前'), '只有一个账号时也显示账号信息和当前状态')
assert.ok(!single.includes('ms-codex-use'), '当前账号不显示切换到自己')
assert.ok(single.includes('ms-codex-remove'), '当前账号也能通过确认步骤删除')
const multiple = renderAccounts(accounts)
assert.equal((multiple.match(/data-testid="ms-codex-use"/g) ?? []).length, 1, '只有未激活的账号显示使用按钮')
assert.equal((multiple.match(/data-testid="ms-codex-remove"/g) ?? []).length, 2, '两个账号都能单独删除')
assert.ok(multiple.includes('a@example.com') && multiple.includes('b@example.com'), '已保存账号按邮箱区分')
assert.ok(/data-testid="ms-codex-use"[^>]*disabled/.test(renderAccounts(accounts, true)), '登录或操作中禁止再次切换')
assert.ok(renderAccounts([{ key: 'unknown', active: false }]).includes('ChatGPT · 1'), '缺邮箱的旧账号仍能显示并管理')

for (const [provider, name] of [['anthropic', 'Claude'], ['github-copilot', 'Copilot'], ['xai', 'xAI'], ['openrouter', 'OpenRouter']]) {
  const html = renderToStaticMarkup(createElement(ui.I18nProvider, null, createElement(ui.SubscriptionAccountList, {
    provider, name, accounts: [{ key: `${provider}:one`, label: '公司', active: true }, { key: `${provider}:two`, active: false }],
    disabled: false, onSwitch() {}, onRemove() {}, onRename() {}
  })))
  assert.ok(html.includes(`ms-${provider}-accounts`) && html.includes(`${name} · 2`), `${provider} 使用同一个账号列表并按服务商命名`)
  assert.ok(html.includes('公司') && html.includes('改备注'), `${provider} 支持使用备注区分无邮箱的账号`)
  assert.equal((html.match(new RegExp(`data-testid="ms-${provider}-remove"`, 'g')) ?? []).length, 2, `${provider} 每个账号都能删除`)
}
const singleKey = renderToStaticMarkup(createElement(ui.I18nProvider, null, createElement(ui.ApiKeyList, {
  provider: 'deepseek', keys: [{ id: 'key-one', label: '个人', masked: 'sk-…1234', active: true }], onDone() {}
})))
assert.ok(singleKey.includes('sk-…1234') && singleKey.includes('当前'), '一个 API key 也能展示备注、打码值和当前状态')
assert.ok(singleKey.includes('改备注') && singleKey.includes('移除'), '当前 API key 也有备注及二次确认移除入口')
console.log('v3 模型与服务单测通过（凭证门禁 / 收藏 / 订阅多账号 / 单 key 管理）')
