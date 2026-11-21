import './lib/test-isolate.mjs'
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok) => {
  await runCredentialsTests(ok)
})

export async function runCredentialsTests(ok) {
  const dir = await mkdtemp(join(tmpdir(), 'yan-cred-'))
  process.env.YAN_PI_DIR = dir

  await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
    build({
      entryPoints: ['src/main/credentials.ts'],
      outfile: 'out/test/credentials.mjs',
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent'
    })
  )
  const { listAuthProviders, authFileInfo, mergeAuthEntry, updateAuthFile, setApiKey } = await import('../out/test/credentials.mjs')

  const info = await authFileInfo()
  if (!info.path.startsWith(dir)) {
    ok(false, '凭证沙盒自检：AUTH_FILE 落在临时目录', `实际 = ${info.path}（已中止，避免写坏真实凭证）`)
    return
  }
  ok(true, '凭证沙盒自检：AUTH_FILE 落在临时目录')

  const authPath = join(dir, 'auth.json')
  await writeFile(
    authPath,
    JSON.stringify(
      {
        'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3.6e6, accountId: 'acc' },
        commandcode: { type: 'api_key', key: 'user_x' },
        deepseek: { type: 'api_key', key: 'sk-x' },
        'my-custom-provider': { type: 'api_key', key: 'k' },
        'string-key-provider': 'sk-literal'
      },
      null,
      2
    )
  )

  const callsDir = join(dir, 'calls')
  const fakePi = join(dir, 'fake-pi.mjs')
  await writeFile(
    fakePi,
    [
      "import { mkdirSync, writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "import { randomUUID } from 'node:crypto'",
      'const args = process.argv.slice(2)',
      'const callsDir = args[0]',
      "const i = args.indexOf('--provider')",
      "const provider = i >= 0 ? args[i + 1] : ''",
      'mkdirSync(callsDir, { recursive: true })',
      "writeFileSync(join(callsDir, provider + '@' + randomUUID() + '.mark'), 'called')",
      "const ready = provider === 'openai-codex' || provider === 'commandcode'",
      "process.stdout.write(JSON.stringify(ready ? { status: 'ready', provider, authType: 'oauth' } : { status: 'not_ready', provider, reason: 'credentials_not_configured' }))"
    ].join('\n')
  )
  const pi = { cmd: process.execPath, args: [fakePi, callsDir] }
  const asked = () => {
    try {
      return readdirSync(callsDir).map((f) => f.split('@')[0])
    } catch {
      return []
    }
  }

  const shallow = await listAuthProviders(pi, false)
  const sh = (id) => shallow.find((x) => x.id === id)
  ok(sh('openai-codex')?.status === 'ready', '浅查：openai-codex（OAuth）在 auth.json 里 → ready')
  ok(sh('openai-codex')?.source === 'auth.json', '浅查：并标出来源是 auth.json（不是环境变量）')
  ok(sh('commandcode')?.status === 'ready', '浅查：commandcode → ready')
  ok(sh('deepseek')?.status === 'ready', '浅查：deepseek → ready')
  ok(sh('google')?.status === 'missing', '浅查：没配的 google → missing')
  ok(
    sh('my-custom-provider')?.status === 'ready',
    '浅查：目录里没有的 provider 也要列出来（否则用户以为什么都没配）'
  )
  let calls = asked()
  ok(calls.length === 0, '浅查不起 pi 进程（0 次调用）', `实际 ${calls.length} 次`)
  ok(sh('string-key-provider')?.status === 'ready' && sh('string-key-provider')?.source === 'auth.json', '浅查：auth.json 里直接写字符串的条目也算已配置')

  const deep = await listAuthProviders(pi, true)
  const dp = (id) => deep.find((x) => x.id === id)
  calls = asked()

  ok(dp('openai-codex')?.status === 'ready', '深查：已登录的 ChatGPT 订阅不会被告成未配置（回归）')
  ok(calls.includes('openai-codex'), '深查：确实用 openai-codex 这个名字问了 pi')
  ok(
    dp('openai')?.status === 'missing',
    '深查：API key 那一行仍按 openai 去问（两条路不能混成一个名字）'
  )
  ok(calls.includes('openai'), '深查：openai 与 openai-codex 是两个独立的探测名')
  ok(
    dp('deepseek')?.status === 'missing',
    '深查：pi 说 not_ready 时以 pi 为准（auth.json 有、但 pi 认不了 → 翻成 missing）'
  )
  ok(calls.includes('my-custom-provider'), '深查：自定义 provider 用它的 id 直接问 pi')
  ok(
    dp('my-custom-provider')?.status === 'missing',
    '深查：自定义项也服从 pi 的回答（假 pi 对它说不 ready）'
  )

  calls = asked()
  const hostOnly = deep.filter((x) => x.id === 'volcengine-ark')
  ok(hostOnly.length === 1 && !calls.includes('volcengine-ark'), '深查：只供宿主用的火山方舟不问 pi')
  ok(calls.length === deep.length - hostOnly.length, `深查给其余每一项都问了 pi（${deep.length - hostOnly.length} 项）`, `实际 ${calls.length} 次`)
  ok(
    calls.every((x) => x.length > 0),
    '深查：每次探测都带了非空 provider 名（空名会让 pi 直接报错）'
  )

  {
    const savedEnv = process.env.OPENCODE_API_KEY
    delete process.env.OPENCODE_API_KEY
    try {
      const ids = ['opencode', 'opencode-go']
      const unconfigured = await listAuthProviders(pi)
      for (const id of ids) {
        const entry = unconfigured.find((item) => item.id === id)
        ok(entry?.kind === 'api_key' && entry.authKey === id && entry.envVar === 'OPENCODE_API_KEY', `${id} 有独立的 API key 设置入口，环境变量沿用 pi 原生约定`)
        ok(entry?.status === 'missing' && !entry.inAppLogin, `${id} 未配置时不误报已登录，也不提供 OAuth 登录`)
      }
      process.env.OPENCODE_API_KEY = 'ONLY_SYNTHETIC_ENV_FIXTURE'
      const envProviders = await listAuthProviders(pi)
      ok(ids.every((id) => envProviders.find((item) => item.id === id)?.source === 'env'), 'OPENCODE_API_KEY 同时支持 Zen 和 Go')
      ok((await setApiKey('opencode', 'ONLY_SYNTHETIC_ZEN_FIXTURE')).ok, 'Zen key 可保存')
      const mixed = await listAuthProviders(pi)
      ok(mixed.find((item) => item.id === 'opencode')?.envShadowed === true, 'Zen 应用内 key 优先于环境变量')
      ok(mixed.find((item) => item.id === 'opencode-go')?.source === 'env', '保存 Zen key 不覆盖 Go 的环境变量来源')
      delete process.env.OPENCODE_API_KEY
      const zenOnly = await listAuthProviders(pi)
      ok(zenOnly.find((item) => item.id === 'opencode-go')?.status === 'missing', '仅保存 Zen key 不会误启用 Go')
      ok((await setApiKey('opencode-go', 'ONLY_SYNTHETIC_GO_FIXTURE')).ok, 'Go key 可独立保存')
      const configured = await listAuthProviders(pi)
      ok(ids.every((id) => configured.filter((item) => item.id === id && item.status === 'ready' && item.source === 'auth.json').length === 1), '两个 key 保存后各显示一个已配置条目，不再重复成未知服务商')
      const stored = JSON.parse(await readFile(authPath, 'utf8'))
      ok(stored.opencode.key === 'ONLY_SYNTHETIC_ZEN_FIXTURE' && stored['opencode-go'].key === 'ONLY_SYNTHETIC_GO_FIXTURE', 'Zen / Go 使用 pi 原生凭证 ID，互不覆盖')
      ok(Boolean(stored['openai-codex'] && stored.commandcode), '添加 OpenCode 不影响既有服务商凭证')
    } finally {
      if (savedEnv === undefined) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = savedEnv
    }
  }

  {
    const expected = {
      'ant-ling': 'ANT_LING_API_KEY',
      baseten: 'BASETEN_API_KEY',
      cerebras: 'CEREBRAS_API_KEY',
      huggingface: 'HF_TOKEN',
      meta: 'META_API_KEY',
      minimax: 'MINIMAX_API_KEY',
      moonshotai: 'MOONSHOT_API_KEY',
      'moonshotai-cn': 'MOONSHOT_API_KEY',
      'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
      xiaomi: 'XIAOMI_API_KEY',
      'xiaomi-token-plan-ams': 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
      'xiaomi-token-plan-cn': 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
      'xiaomi-token-plan-sgp': 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
      zai: 'ZAI_API_KEY'
    }
    const savedEnv = process.env.CEREBRAS_API_KEY
    delete process.env.CEREBRAS_API_KEY
    try {
      const listed = await listAuthProviders(pi)
      for (const [id, envVar] of Object.entries(expected)) {
        const entry = listed.find((item) => item.id === id)
        ok(entry?.kind === 'api_key' && entry.authKey === id && entry.envVar === envVar && entry.status === 'missing', `${id} 有 API key 入口且环境变量与 pi 原生一致`)
      }
      ok((await setApiKey('cerebras', 'ONLY_SYNTHETIC_CEREBRAS_FIXTURE')).ok, '新增服务商的 key 可保存')
      process.env.CEREBRAS_API_KEY = 'ONLY_SYNTHETIC_ENV_FIXTURE'
      const listedWithEnv = await listAuthProviders(pi)
      ok(listedWithEnv.find((item) => item.id === 'cerebras')?.envShadowed === true, '应用内 key 优先于同名的环境变量')
      delete process.env.CEREBRAS_API_KEY
      const stored = JSON.parse(await readFile(authPath, 'utf8'))
      ok(stored.cerebras?.key === 'ONLY_SYNTHETIC_CEREBRAS_FIXTURE' && Boolean(stored['openai-codex']), '新服务商用 pi 原生凭证 ID 写入，不影响既有凭证')
      const afterSave = await listAuthProviders(pi)
      ok(afterSave.filter((item) => item.id === 'cerebras').length === 1, '保存后只出现一条 cerebras，不再重复成未知服务商')
    } finally {
      if (savedEnv === undefined) delete process.env.CEREBRAS_API_KEY
      else process.env.CEREBRAS_API_KEY = savedEnv
    }
  }

  {
    const plans = [
      ['qwen-token-plan', 'QWEN_TOKEN_PLAN_TEAM_API_KEY', 'QWEN_TOKEN_PLAN_API_KEY'],
      ['qwen-token-plan-cn', 'QWEN_TOKEN_PLAN_TEAM_CN_API_KEY', 'QWEN_TOKEN_PLAN_CN_API_KEY'],
      ['qwen-token-plan-individual', 'QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY', 'QWEN_TOKEN_PLAN_API_KEY'],
      ['qwen-token-plan-individual-cn', 'QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY', 'QWEN_TOKEN_PLAN_CN_API_KEY']
    ]
    const vars = [...new Set(plans.flatMap(([, primary, legacy]) => [primary, legacy]))]
    const savedEnv = new Map(vars.map((name) => [name, process.env[name]]))
    const fixture = 'SYNTHETIC_QWEN_FIXTURE'
    const listed = async () => new Map((await listAuthProviders(pi)).map((p) => [p.id, p]))
    try {
      for (const name of vars) delete process.env[name]
      const empty = await listed()
      for (const [id, primary, legacy] of plans) {
        const p = empty.get(id)
        ok(p?.authKey === id && p.kind === 'api_key' && p.envVar === primary && p.status === 'missing', `${id} 仍用原生 provider ID 写入，首选专用变量`)
        process.env[primary] = fixture
        let rows = await listed()
        ok(plans.every(([other]) => rows.get(other)?.status === (id === other ? 'ready' : 'missing')), `${primary} 不跨方案或地区启用`)
        process.env[legacy] = fixture
        rows = await listed()
        ok(rows.get(id)?.source === 'env' && rows.get(id)?.envVar === primary, `${id} 的专用变量优先于旧变量`)
        delete process.env[primary]
        rows = await listed()
        ok(plans.every(([other, , fallback]) => fallback === legacy
          ? rows.get(other)?.source === 'env' && rows.get(other)?.envVar === legacy
          : rows.get(other)?.status === 'missing'), `${legacy} 仅为同地区原有方案回退，并显示实际变量名`)
        delete process.env[legacy]
      }
      for (const [id, , legacy] of plans) {
        process.env[legacy] = fixture
        ok((await setApiKey(id, fixture)).ok, `${id} 可独立保存凭证`)
        const p = (await listed()).get(id)
        ok(p?.source === 'auth.json' && p.envShadowed === true && !JSON.stringify(p).includes(fixture), `${id} 已保存凭证优先，不返回环境变量值`)
      }
      const stored = JSON.parse(await readFile(authPath, 'utf8'))
      ok(plans.every(([id]) => stored[id]?.key === fixture) && stored['qwen-token-plan-team'] === undefined, '保留四个既有 auth ID，不新建团队凭证别名')
    } finally {
      for (const [name, value] of savedEnv) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }

  {
    const writes = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        mergeAuthEntry(`fixture-provider-${i}`, { type: 'api_key', key: 'ONLY_SYNTHETIC_FIXTURE' })
      )
    )
    ok(writes.every((w) => w.ok), '并发合并写入 6 个 provider 都返回成功')
    const after = JSON.parse(await readFile(authPath, 'utf8'))
    const kept = Array.from({ length: 6 }, (_, i) => `fixture-provider-${i}`).filter((k) => k in after)
    ok(kept.length === 6, '**并发写入后 6 个 provider 都在 auth.json 里（不互相覆盖）**', `实际 ${kept.length} 个`)
    ok(Boolean(after['openai-codex'] && after.commandcode), '并发写入没有弄丢原有凭证')

    const viaSetApiKey = await Promise.all(
      Array.from({ length: 4 }, (_, i) => setApiKey(`fixture-key-${i}`, 'ONLY_SYNTHETIC_FIXTURE'))
    )
    ok(viaSetApiKey.every((w) => w.ok), '设置页路径（setApiKey）并发写入也成功')
    const afterKeys = JSON.parse(await readFile(authPath, 'utf8'))
    const keyCount = Array.from({ length: 4 }, (_, i) => `fixture-key-${i}`).filter((k) => k in afterKeys).length
    ok(keyCount === 4, '**设置页并发保存 4 个 provider 也不丢（与合并写入共用同一把锁）**', `实际 ${keyCount} 个`)
  }

  {
    const lockDir = join(dir, 'auth.json.lock')
    let heldDuringWrite = false
    await updateAuthFile((auth) => {
      auth['lock-probe'] = { type: 'api_key', key: 'ONLY_SYNTHETIC_FIXTURE' }
      return { write: true, result: undefined }
    })
    heldDuringWrite = await stat(lockDir).then(
      () => true,
      () => false
    )
    ok(!heldDuringWrite, '写入完成后释放 auth.json.lock')

    const order = []
    const seenInLock = []
    const first = updateAuthFile(async (auth) => {
      order.push('first-in')
      seenInLock.push(await stat(lockDir).then(() => true, () => false))
      await new Promise((r) => setTimeout(r, 200))
      auth['lock-order-1'] = { type: 'api_key', key: 'ONLY_SYNTHETIC_FIXTURE' }
      order.push('first-out')
      return { write: true, result: undefined }
    })
    await new Promise((r) => setTimeout(r, 20))
    const second = updateAuthFile((auth) => {
      order.push('second-in')
      auth['lock-order-2'] = { type: 'api_key', key: 'ONLY_SYNTHETIC_FIXTURE' }
      return { write: true, result: undefined }
    })
    await Promise.all([first, second])
    ok(seenInLock[0] === true, '持锁写入期间 auth.json.lock 存在（与 pi 同一把锁）')
    ok(
      order.join(',') === 'first-in,first-out,second-in',
      '**写锁串行化：第二个写入等第一个退出后才进入**',
      order.join(',')
    )
    const afterLock = JSON.parse(await readFile(authPath, 'utf8'))
    ok(Boolean(afterLock['lock-order-1'] && afterLock['lock-order-2']), '两次持锁写入的结果都在（没有互相覆盖）')
  }
}
