import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const jwt = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
const credential = (provider, user, rotated = false) => ({
  type: 'oauth',
  access: provider === 'xai' ? jwt({ sub: user, email: `${user}@example.com`, revision: rotated ? 2 : 1 }) : `${provider}-${user}${rotated && provider !== 'openrouter' ? '-rotated' : ''}`,
  refresh: `${provider}-${user}-refresh${rotated && provider !== 'openrouter' ? '-rotated' : ''}`,
  expires: Date.now() + 3600000
})

export async function runOAuthAccountTests(ok) {
  const root = await mkdtemp(join(tmpdir(), 'inkstone-oauth-accounts-'))
  const oldEnv = { pi: process.env.YAN_PI_DIR, data: process.env.YAN_DATA_DIR }
  const previousFetch = globalThis.__oauthAccountFetch
  process.env.YAN_PI_DIR = join(root, 'pi')
  process.env.YAN_DATA_DIR = join(root, 'yan')
  await mkdir(process.env.YAN_PI_DIR, { recursive: true })
  globalThis.__oauthAccountFetch = async (url, init) => {
    const user = init.headers.Authorization.includes('-b') ? 'b' : 'a'
    return { ok: true, json: async () => url.includes('anthropic')
      ? { account: { uuid: user, email_address: `${user}@example.com` }, organization: { uuid: 'workspace' } }
      : { id: user, login: `github-${user}` } }
  }
  try {
    await build({
      entryPoints: ['src/main/oauth-accounts.ts'], outfile: 'out/test/oauth-accounts.mjs', bundle: true,
      platform: 'node', format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'offline-electron', setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const app = undefined; export const net = { fetch: (...args) => globalThis.__oauthAccountFetch(...args) };' }))
      } }]
    })
    const pool = await import(pathToFileURL(join(process.cwd(), 'out/test/oauth-accounts.mjs')).href + `?t=${Date.now()}`)
    const authFile = join(process.env.YAN_PI_DIR, 'auth.json')
    const storeFile = join(process.env.YAN_DATA_DIR, 'oauth-accounts.json')
    const readAuth = async () => JSON.parse(await readFile(authFile, 'utf8'))
    const writeCurrent = async (provider, value) => {
      let auth = { deepseek: { type: 'api_key', key: 'do-not-touch' } }
      try { auth = await readAuth() } catch {}
      auth[provider] = value
      await writeFile(authFile, JSON.stringify(auth))
    }
    for (const provider of ['anthropic', 'github-copilot', 'xai', 'openrouter']) {
      const a = credential(provider, 'a')
      const b = credential(provider, 'b')
      await writeCurrent(provider, a)
      await Promise.all([pool.captureActiveOAuthAccount(provider), pool.captureActiveOAuthAccount(provider)])
      let rows = (await pool.listOAuthAccounts())[provider]
      ok(rows.length === 1 && rows[0].active, `${provider}：现有登录自动入库，重复读取不新增账号`)
      const keyA = rows[0].key
      const rotated = credential(provider, 'a', true)
      await writeCurrent(provider, rotated)
      rows = (await pool.listOAuthAccounts())[provider]
      ok(rows.length === 1 && rows[0].key === keyA, `${provider}：同一身份的令牌更新不新增记录、不改变切换 key`)
      await writeCurrent(provider, b)
      rows = (await pool.listOAuthAccounts())[provider]
      ok(rows.length === 2 && rows.filter((r) => r.active).length === 1, `${provider}：保存两个账号，只激活当前登录`)
      ok(!JSON.stringify(rows).includes(a.access) && !JSON.stringify(rows).includes(b.refresh), `${provider}：展示数据不含完整令牌`)
      const keyB = rows.find((r) => r.active).key
      ok((await pool.renameOAuthAccount(provider, keyA, '  个人  ')).ok, `${provider}：支持账号备注`)
      ok((await pool.listOAuthAccounts())[provider].find((r) => r.key === keyA).label === '个人', `${provider}：备注去除两端空白后持久化`)
      ok((await pool.switchOAuthAccount(provider, keyA)).ok && (await readAuth())[provider].refresh === rotated.refresh, `${provider}：切换使用该账号最新凭证`)
      const deleted = await pool.removeOAuthAccount(provider, keyB)
      ok(deleted.ok && !deleted.wasActive && (await readAuth())[provider].access === rotated.access, `${provider}：移除备用账号不影响当前登录`)
      const activeDeleted = await pool.removeOAuthAccount(provider, keyA)
      ok(activeDeleted.ok && activeDeleted.wasActive && !(await readAuth())[provider], `${provider}：移除当前账号同步退出，不保留幽灵额度账号`)
      ok((await readAuth()).deepseek.key === 'do-not-touch', `${provider}：不修改其他服务商凭证`)
      ok(!(await pool.switchOAuthAccount(provider, 'missing')).ok && !(await pool.removeOAuthAccount(provider, 'missing')).ok, `${provider}：过期切换/删除请求明确失败`)
      await writeCurrent(provider, a)
      await pool.captureActiveOAuthAccount(provider)
      await writeCurrent(provider, b)
      await pool.captureActiveOAuthAccount(provider)
      ok((await pool.clearOAuthAccounts(provider)).ok && !(await readAuth())[provider] && !(await pool.listOAuthAccounts())[provider], `${provider}：整体移除同时清空已保存登录`)
    }
    const copilot = credential('github-copilot', 'a')
    await writeCurrent('github-copilot', copilot)
    await pool.captureActiveOAuthAccount('github-copilot')
    await writeCurrent('github-copilot', { ...copilot, enterpriseUrl: 'github.company.test' })
    await pool.captureActiveOAuthAccount('github-copilot')
    ok((await pool.listOAuthAccounts())['github-copilot'].length === 2, 'Copilot：即使凭证文本相同，不同企业域的账号也不能合并')
    await pool.clearOAuthAccounts('github-copilot')

    await writeCurrent('anthropic', credential('anthropic', 'a'))
    await pool.captureActiveOAuthAccount('anthropic')
    await writeCurrent('xai', credential('xai', 'a'))
    await pool.captureActiveOAuthAccount('xai')
    await pool.clearOAuthAccounts('anthropic')
    ok((await pool.listOAuthAccounts()).xai.length === 1, '按服务商清空不会删除其他服务商账号')
    ok(!(await pool.switchOAuthAccount('../escape', 'x')).ok, 'IPC 边界拒绝非法服务商')
    const expired = { ...credential('xai', 'a'), expires: 0 }
    await writeCurrent('xai', expired)
    const targets = await pool.oauthAccountTargets('xai')
    ok(targets.length === 1 && targets[0].credential.expires === 0, '过期状态如实保留，刷新交给 pi 原生流程')

    globalThis.__oauthAccountFetch = async () => { throw new Error('offline fixture') }
    await writeCurrent('github-copilot', credential('github-copilot', 'offline'))
    const fallback = await pool.captureActiveOAuthAccount('github-copilot')
    ok(!!fallback.key && (await pool.listOAuthAccounts())['github-copilot'].length === 1, '服务暂不可达时仍能保存、管理已有凭证')

    const before = await readFile(authFile, 'utf8')
    await writeFile(storeFile, '{broken')
    await assert.rejects(pool.listOAuthAccounts(), /已拒绝写入/)
    ok(!(await pool.switchOAuthAccount('xai', 'missing')).ok && !(await pool.clearOAuthAccounts('xai')).ok, '账号池损坏时拒绝修改或清空')
    ok(await readFile(authFile, 'utf8') === before && await readFile(storeFile, 'utf8') === '{broken', '损坏保护不会覆盖账号池或当前登录')
    ok((await readdir(process.env.YAN_DATA_DIR)).some((name) => name.endsWith('.corrupt.bak')), '损坏文件保留独立备份')
  } finally {
    if (oldEnv.pi === undefined) delete process.env.YAN_PI_DIR
    else process.env.YAN_PI_DIR = oldEnv.pi
    if (oldEnv.data === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = oldEnv.data
    if (previousFetch === undefined) delete globalThis.__oauthAccountFetch
    else globalThis.__oauthAccountFetch = previousFetch
    await rm(root, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let count = 0
  await runOAuthAccountTests((condition, name) => { assert.ok(condition, name); count++ })
  console.log(`✓ OAuth 多账号：${count} 项通过`)
}
