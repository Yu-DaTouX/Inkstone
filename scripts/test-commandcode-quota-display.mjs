import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const OUT = resolve('.tmp/commandcode-quota-display')

async function loadPure(entry, name) {
  const outfile = resolve(OUT, `${name}.mjs`)
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}

const SNAPSHOT = {
  credits: { monthlyCredits: 69.996 },
  windowLimits: {
    limited: true,
    fiveHour: { used: 0.003, cap: 14, exceeded: false, resetAt: 1_790_013_986_382 },
    weekly: { used: 0.003, cap: 35, exceeded: false, resetAt: 1_790_600_786_382 }
  }
}

async function loadQuotaCredentials() {
  const outfile = resolve(OUT, 'quota-credentials.mjs')
  await build({
    entryPoints: ['src/main/quota-credentials.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'quota-credentials-stub',
      setup(b) {
        b.onResolve({ filter: /^\.\/credentials$/ }, () => ({ path: 'credentials', namespace: 'quota-cred-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'quota-cred-stub' }, () => ({
          contents: `export const readAuthEntry = async (p) => globalThis.__quotaCred?.authEntry?.[p]`,
          loader: 'js'
        }))
      }
    }]
  })
  return import(pathToFileURL(outfile).href)
}

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body })

async function runQuotaCredentialSourceTests(check) {
  const creds = await loadQuotaCredentials()
  const dir = await mkdtemp(resolve(OUT, 'quota-creds-'))
  const modelsFile = join(dir, 'models.json')
  globalThis.__quotaCred = { authEntry: {} }
  try {
    check(creds.resolveNativeConfigValue('sk-literal', {}) === 'sk-literal', '配置值：纯字符串原样返回')
    check(creds.resolveNativeConfigValue('$CC_KEY', { CC_KEY: 'env-key' }) === 'env-key', '配置值：$NAME 环境引用')
    check(creds.resolveNativeConfigValue('${CC_KEY}', { CC_KEY: 'env2' }) === 'env2', '配置值：${NAME} 环境引用')
    check(creds.resolveNativeConfigValue('$MISSING_KEY_X', {}) === undefined, '配置值：环境引用缺变量 → 缺失（不造凭证）')
    check(creds.resolveNativeConfigValue('$$literal', {}) === '$literal', '配置值：$$ 还原字面量')
    check(creds.resolveNativeConfigValue('!echo pwned', {}) === undefined, '配置值：! 命令型 → 拒绝，不执行')

    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'user_static' }) === 'user_static', '官方 HTTPS 主机 + 静态 key → 可取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://api.commandcode.ai.evil.test/v1', apiKey: 'user_x' }) === undefined, '相似官方域（后缀伪造）→ 不取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://evil.test/api.commandcode.ai', apiKey: 'user_x' }) === undefined, '官方域名出现在路径 → 不取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'http://api.commandcode.ai/provider/v1', apiKey: 'user_x' }) === undefined, '非 HTTPS → 不取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://api.commandcode.ai:8443/provider/v1', apiKey: 'user_x' }) === undefined, '非默认端口 → 不取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://user:pass@api.commandcode.ai/provider/v1', apiKey: 'user_x' }) === undefined, 'URL 内嵌凭证 → 不取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { apiKey: 'user_x' }) === undefined, 'commandcode 缺 baseUrl（无原生默认）→ 不取')
    check(creds.extractModelsJsonQuotaKey('deepseek', { apiKey: 'sk-x' }) === 'sk-x', 'deepseek 缺 baseUrl → 用 pi 原生官方默认，可取')
    check(creds.extractModelsJsonQuotaKey('deepseek', { baseUrl: 'https://api.deepseek.com.evil.test', apiKey: 'sk-x' }) === undefined, 'deepseek 代理域 → 不取')
    check(creds.extractModelsJsonQuotaKey('yan-local', { baseUrl: 'https://api.commandcode.ai', apiKey: 'sk-x' }) === undefined, '未知 / 自定义 provider → 不取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://api.commandcode.ai', apiKey: '!echo secret' }) === undefined, '命令型 apiKey → 不取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://api.commandcode.ai', apiKey: '${CC_KEY}' }, { CC_KEY: 'env-key' }) === 'env-key', 'models.json 环境引用（有 env）→ 取 env 值')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://api.commandcode.ai', apiKey: '${CC_KEY}' }, {}) === undefined, 'models.json 环境引用（无 env）→ 缺失')
    check(creds.extractModelsJsonQuotaKey('commandcode', null) === undefined, '条目形状不对 → 不取')

    await writeFile(modelsFile, '{ this is not json')
    check(await creds.readModelsJsonQuotaKey('commandcode', { agentDir: dir, env: {} }) === undefined, '坏 JSON → 缺失，不泄露不执行')

    const authEntry = { type: 'api_key', key: 'user_auth_sentinel' }
    const readAuth = async () => authEntry
    const threeEnv = { COMMANDCODE_API_KEY: 'user_env_sentinel' }

    await writeFile(modelsFile, '{ this is not json')
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth }) === undefined, '坏 JSON → auth/env/models 都不取')

    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: { baseUrl: 'https://api.commandcode.ai', apiKey: 'user_models_sentinel' } } }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth }) === 'user_auth_sentinel', '三来源都有 key → 原生顺序 auth 胜出（不是 env）')
    await writeFile(modelsFile, JSON.stringify({ providers: {} }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth }) === 'user_auth_sentinel', 'auth + env、无 models → auth 胜出')
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth: async () => undefined }) === 'user_env_sentinel', 'env-only、无 models → 用原生内置 env')
    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: { baseUrl: 'https://api.commandcode.ai', apiKey: 'user_models_sentinel' } } }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth: async () => undefined }) === 'user_models_sentinel', 'models + env、无 auth → models 胜出（原生 rawKey 优先于内置 env）')
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth: async () => ({ type: 'api_key', key: '   ' }) }) === 'user_models_sentinel', '空白 auth 视为缺失 → models 胜出')
    await writeFile(modelsFile, JSON.stringify({ providers: {} }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: {}, readAuth }) === 'user_auth_sentinel', 'auth-only（无 models）→ 仍可用')
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth: async () => undefined }) === 'user_env_sentinel', 'env-only（无 models）→ 仍可用')

    for (const [label, entry] of [
      ['代理域', { baseUrl: 'https://api.commandcode.ai.evil.test/v1', apiKey: 'user_models_sentinel' }],
      ['非 https', { baseUrl: 'http://api.commandcode.ai/provider/v1', apiKey: 'user_models_sentinel' }],
      ['非默认端口', { baseUrl: 'https://api.commandcode.ai:8443/provider/v1', apiKey: 'user_models_sentinel' }],
      ['URL 内嵌凭证', { baseUrl: 'https://u:p@api.commandcode.ai/provider/v1', apiKey: 'user_models_sentinel' }],
      ['模板 baseUrl', { baseUrl: '$CC_BASE_URL', apiKey: 'user_models_sentinel' }],
      ['命令 baseUrl', { baseUrl: '!echo https://api.commandcode.ai', apiKey: 'user_models_sentinel' }],
      ['commandcode 缺 baseUrl（无原生默认）', { apiKey: 'user_models_sentinel' }],
      ['形状不可信', ['api.commandcode.ai']]
    ]) {
      await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: entry } }))
      check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth }) === undefined, `端点不可证明（${label}）→ auth/env/models 都不取`)
    }
    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: {
      baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'user_models_sentinel',
      models: [{ id: 'cc', baseUrl: 'https://api.commandcode.ai.evil.test/v1' }]
    } } }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth }) === undefined, 'per-model baseUrl 指离官方 → auth/env/models 都不取')
    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: {
      baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'user_models_sentinel',
      models: [{ id: 'cc' }, { id: 'cc2', baseUrl: 'https://api.commandcode.ai/provider/v1' }]
    } } }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: {} }) === 'user_models_sentinel', 'per-model 均为官方或缺省 → models key 可用')

    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: { baseUrl: 'https://api.commandcode.ai', apiKey: '!echo other-account-key' } } }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth: async () => undefined }) === undefined, '命令型 models apiKey + env → 报缺失（不拿 env 冒充）')
    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: { baseUrl: 'https://api.commandcode.ai', apiKey: '${CC_MISSING_KEY}' } } }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth: async () => undefined }) === undefined, '环境引用缺变量的 models apiKey + env → 报缺失（不拿 env 冒充）')
    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: { baseUrl: 'https://api.commandcode.ai/provider/v1' } } }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv }) === undefined, 'commandcode 条目无 apiKey + env → 报缺失（扩展让位，无原生 env 回退）')
    await writeFile(modelsFile, JSON.stringify({ providers: { deepseek: { baseUrl: 'https://api.deepseek.com' } } }))
    check(await creds.resolveQuotaProviderSecret('deepseek', { agentDir: dir, env: { DEEPSEEK_API_KEY: 'sk_deepseek_env' } }) === 'sk_deepseek_env', '内置 provider 条目无 apiKey + env → 原生 env 回退生效')

    const sentinel = join(dir, 'PWNED').replace(/\\/g, '/')
    await writeFile(modelsFile, JSON.stringify({
      providers: { commandcode: { baseUrl: 'https://api.commandcode.ai', apiKey: `!node -e "require('fs').writeFileSync('${sentinel}','x')"` } }
    }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: {}, readAuth: async () => undefined }) === undefined, '命令型 models.json apiKey → 返回缺失')
    check(!existsSync(sentinel), '命令型 models.json apiKey → 未被 shell 执行（无哨兵文件）')
  } finally {
    delete globalThis.__quotaCred
    await rm(dir, { recursive: true, force: true })
  }
}

const QUOTA_MAIN_STUBS = {
  electron: `export const net = { fetch: (...a) => globalThis.__quotaNet.fetch(...a) }`,
  credentials: `
export const readAuthEntry = async (p) => globalThis.__quotaNet?.authEntry?.[p]
export const resolveCodexAccountId = async () => undefined
`,
  'image-credentials': `export const hostImageCredentials = { codex: async () => null }`
}

async function loadQuotaMain() {
  const outfile = resolve(OUT, 'quota-main.mjs')
  await build({
    entryPoints: ['src/main/quota.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'quota-main-stubs',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'quota-main-stub' }))
        b.onResolve({ filter: /^\.\/credentials$/ }, () => ({ path: 'credentials', namespace: 'quota-main-stub' }))
        b.onResolve({ filter: /^\.\/image-credentials$/ }, () => ({ path: 'image-credentials', namespace: 'quota-main-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'quota-main-stub' }, (args) => ({ contents: QUOTA_MAIN_STUBS[args.path], loader: 'js' }))
      }
    }]
  })
  return import(pathToFileURL(outfile).href)
}

async function runStatusBarModelsKeyTest(check) {
  const dir = await mkdtemp(resolve(OUT, 'quota-main-'))
  const priorPi = process.env.YAN_PI_DIR
  const priorKey = process.env.COMMANDCODE_API_KEY
  const priorFetch = globalThis.fetch
  process.env.YAN_PI_DIR = dir
  try {
    await writeFile(join(dir, 'models.json'), JSON.stringify({
      providers: { commandcode: { baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'user_models_only' } }
    }))
    const main = await loadQuotaMain()
    const urls = []
    globalThis.__quotaNet = {
      authEntry: {},
      fetch: async () => { throw new Error('test: net.fetch must not be used for commandcode quota') }
    }
    globalThis.fetch = async (url) => {
      const u = String(url)
      urls.push(u)
      if (u.includes('/alpha/billing/credits')) return jsonResponse(SNAPSHOT)
      if (u.includes('/alpha/billing/subscriptions')) return jsonResponse({ data: { currentPeriodEnd: '2026-10-21T00:00:00.000Z' } })
      throw new Error(`unexpected URL ${u}`)
    }
    const q = await main.providerQuota('commandcode')
    check(q.supported === true && !q.error, '状态栏入口：models.json-only 官方 key 可取额度（不再「未找到 API Key」）')
    check(q.windows.map((w) => w.id).join(',') === 'fiveHour,weekly,monthly', '状态栏入口：同一 models.json key 得到同样三窗口')
    check(q.windows.find((w) => w.id === 'monthly')?.estimated === true, '状态栏入口：推算月窗口仍标 estimated')
    check(urls.every((u) => u.startsWith('https://api.commandcode.ai/')), '状态栏入口：只请求官方主机')

    urls.length = 0
    globalThis.__quotaNet.authEntry = { commandcode: { type: 'api_key', key: 'user_auth_sentinel' } }
    process.env.COMMANDCODE_API_KEY = 'user_env_sentinel'
    await writeFile(join(dir, 'models.json'), JSON.stringify({
      providers: { commandcode: { baseUrl: 'https://api.commandcode.ai.evil.test/v1', apiKey: 'user_models_sentinel' } }
    }))
    const qProxy = await main.providerQuota('commandcode')
    check(qProxy.error === '未找到该供应商的 API Key', '状态栏入口：代理条目 + auth/env key → 报缺凭证（不取任何来源）')
    check(urls.length === 0, '状态栏入口：代理条目 + auth/env key → 零官方 fetch')

    urls.length = 0
    globalThis.__quotaNet.authEntry = {}
    await rm(join(dir, 'models.json'), { force: true })
    const qEnv = await main.providerQuota('commandcode')
    check(qEnv.supported === true && !qEnv.error, '状态栏入口：env-only（无 models 条目）→ 仍可取额度')
    check(urls.every((u) => u.startsWith('https://api.commandcode.ai/')), '状态栏入口：env-only → 只请求官方主机')
  } finally {
    delete globalThis.__quotaNet
    globalThis.fetch = priorFetch
    if (priorPi === undefined) delete process.env.YAN_PI_DIR
    else process.env.YAN_PI_DIR = priorPi
    if (priorKey === undefined) delete process.env.COMMANDCODE_API_KEY
    else process.env.COMMANDCODE_API_KEY = priorKey
    await rm(dir, { recursive: true, force: true })
  }
}

async function runCommandCodeExtensionAuthTest(check) {
  const mod = await import(pathToFileURL(resolve('resources/pi-extensions/commandcode.js')).href)
  const dir = await mkdtemp(resolve(OUT, 'cc-ext-'))
  const priorAgent = process.env.PI_CODING_AGENT_DIR
  const priorKey = process.env.COMMANDCODE_API_KEY
  const realFetch = globalThis.fetch
  const calls = []
  const pi = { registerProvider: (id, config) => calls.push({ id, config }) }
  try {
    process.env.PI_CODING_AGENT_DIR = dir
    await writeFile(join(dir, 'yan-commandcode-models.json'), JSON.stringify({
      savedAt: 1,
      models: [{ id: 'cc-test', name: 'cc-test', api: 'openai-completions', baseUrl: mod.BASE_URL, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 }]
    }))
    globalThis.fetch = async () => { throw new Error('test: no network') }

    process.env.COMMANDCODE_API_KEY = 'user_env_only'
    await mod.default(pi)
    check(calls.length === 1 && calls[0].id === 'commandcode', '扩展 env-only：注册 commandcode')
    check(calls[0]?.config.apiKey === '$COMMANDCODE_API_KEY', '扩展 env-only：声明 $COMMANDCODE_API_KEY 环境引用（pi 原生配置值语法）')

    calls.length = 0
    delete process.env.COMMANDCODE_API_KEY
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ commandcode: { type: 'api_key', key: 'user_auth' } }))
    await writeFile(join(dir, 'models.json'), JSON.stringify({ providers: { commandcode: { baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'user_models_key' } } }))
    await mod.default(pi)
    check(calls.length === 0, '扩展：models.json 已有 commandcode → 让位不注册（不覆盖用户手写 key）')

    calls.length = 0
    await rm(join(dir, 'models.json'), { force: true })
    await mod.default(pi)
    check(calls.length === 1 && calls[0]?.config.apiKey === undefined, '扩展 auth.json-only：不声明 apiKey（不被扩展覆盖，走 credential）')
  } finally {
    globalThis.fetch = realFetch
    if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = priorAgent
    if (priorKey === undefined) delete process.env.COMMANDCODE_API_KEY
    else process.env.COMMANDCODE_API_KEY = priorKey
    await rm(dir, { recursive: true, force: true })
  }
}

export async function runCommandCodeQuotaDisplayTests(ok) {
  const check = typeof ok === 'function'
    ? ok
    : (cond, label, extra = '') => { if (!cond) throw new Error(`Command Code 额度显示：${label}${extra ? ' ' + extra : ''}`) }

  await mkdir(OUT, { recursive: true })
  const { commandCodeWindows } = await loadPure('src/main/quota-commandcode.ts', 'quota-commandcode')
  const { shouldRenderQuotaSection, quotaSnapshotMatchesProvider } = await loadPure('src/shared/quota-display.ts', 'quota-display')

  const renderInput = (over = {}) => ({
    provider: 'commandcode',
    loading: false,
    supported: true,
    hasError: false,
    hasMainText: false,
    windowCount: 0,
    hasBudget: false,
    ...over
  })

  {
    const windows = commandCodeWindows(SNAPSHOT, Date.UTC(2026, 9, 21))
    check(windows.length === 3, '五个小时 / 每周 / 本月三个窗口都产出', windows.map((w) => w.id).join(', '))
    check(shouldRenderQuotaSection(renderInput({ windowCount: windows.length })), '有窗口 → 渲染')
    check(shouldRenderQuotaSection(renderInput({ hasMainText: true })), '有主值（即使窗口为空）→ 渲染')
  }

  {
    const failed = renderInput({ supported: true, hasMainText: false, windowCount: 0 })
    check(shouldRenderQuotaSection(failed), '已知支持额度接口的 provider 查询失败 → 仍渲染错误行')
    const oldHidden =
      !failed.provider ||
      (!failed.loading && !failed.hasMainText && failed.windowCount === 0 && !failed.hasBudget && failed.provider !== 'claude-bridge')
    check(oldHidden, '旧 guard 会把同样的状态整块隐藏（这就是「没有额度段」的原因）')
    const noWindows = commandCodeWindows({ windowLimits: { limited: false } })
    check(noWindows.length === 0, '接口没返回任何窗口时解析出 0 个窗口（不是编一个 0 额度）')
    check(shouldRenderQuotaSection(renderInput({ windowCount: noWindows.length })), '接口返回但没窗口 → 仍渲染，让原因可见')
  }

  {
    check(
      shouldRenderQuotaSection(renderInput({ supported: null, loading: false, hasError: true })),
      'Promise reject（supported === null）→ hasError 让错误行可见'
    )
    check(
      !shouldRenderQuotaSection(renderInput({ supported: false, hasError: true })),
      '明确不支持（supported === false）即使报错也不占空块'
    )
    check(
      !shouldRenderQuotaSection({
        provider: 'commandcode', loading: false, supported: null, hasError: false,
        hasMainText: false, windowCount: 0, hasBudget: false
      }),
      '还没查、也没有错误 → 不凭空占位'
    )
  }

  {
    check(!shouldRenderQuotaSection(renderInput({ provider: 'yan-local', supported: false })), '自定义 API（supported === false）→ 不渲染')
    check(!shouldRenderQuotaSection(renderInput({ provider: '' })), '没有 provider → 不渲染')
    check(shouldRenderQuotaSection(renderInput({ supported: null, loading: true })), '首次查询在飞 → 渲染占位，避免闪一下消失')
  }

  {
    const commandSnapshot = { provider: 'commandcode', supported: true, windows: commandCodeWindows(SNAPSHOT, Date.UTC(2026, 9, 21)) }
    check(quotaSnapshotMatchesProvider(commandSnapshot.provider, 'commandcode'), '同一 provider → 快照可用')
    check(!quotaSnapshotMatchesProvider(commandSnapshot.provider, 'deepseek'), '换到 deepseek → Command Code 快照作废')
    check(quotaSnapshotMatchesProvider('COMMANDCODE', ' commandcode '), '大小写 / 空白差异按同一 provider 处理')
    check(!quotaSnapshotMatchesProvider(undefined, 'commandcode'), '快照没有 provider → 不作数')
    const active = quotaSnapshotMatchesProvider(commandSnapshot.provider, 'deepseek') ? commandSnapshot : null
    check(active === null, '派生出的 quota 为 null（不会把 Command Code 的窗口留给 deepseek）')
  }

  await runQuotaCredentialSourceTests(check)

  await runStatusBarModelsKeyTest(check)

  await runCommandCodeExtensionAuthTest(check)
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  let failed = 0
  const ok = (cond, label, extra = '') => {
    if (cond) console.log(`  ✓ ${label}${extra ? '  ' + extra : ''}`)
    else { failed++; console.log(`  ✗ ${label}${extra ? '  ' + extra : ''}`) }
  }
  try {
    await runCommandCodeQuotaDisplayTests(ok)
    console.log(failed ? `\n✗ Command Code 额度显示：失败 ${failed} 项` : '\n✓ Command Code 额度显示：全部通过')
    if (failed) process.exitCode = 1
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
