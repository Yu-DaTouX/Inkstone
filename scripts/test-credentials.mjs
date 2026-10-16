import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
        'my-custom-provider': { type: 'api_key', key: 'k' }
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
