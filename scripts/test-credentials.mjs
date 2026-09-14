/**
 * 模型接入（凭证）的 **provider 名映射** —— 纯逻辑，用一个假 pi 当探针。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须专门测这条
 * ══════════════════════════════════════════════════════════════════
 * `listAuthProviders(deep)` 会拿 provider 名去问 pi：
 * `pi auth check --provider <名> --json`。
 * **名字写错不会报错**，pi 只会安静地返回 `not_ready`（因为它真的没配那个
 * provider），界面于是把这一行从「已就绪」翻转成「未配置」。
 *
 * 真踩过：订阅制分支把 `openai-codex` 改写成 `openai` 再问（作者以为
 * `-codex` 是自己加的后缀）。而 pi 的 provider 确实就叫 `openai-codex`，
 * `openai` 是另一条路（OpenAI API key）。后果是**已登录 ChatGPT Plus 的用户
 * 一点「重新检测」就被告知未登录**，还被引导去重新跑 /login。
 *
 * 假 pi 让它可确定性地复现：命令里收到 `openai-codex` 才说 ready，
 * 收到 `openai` 说 not_ready —— 与真实环境一致。
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runCredentialsTests(ok) {
  const dir = await mkdtemp(join(tmpdir(), 'yan-cred-'))
  /*
   * ⚠️ 必须在 import 之前设：credentials.ts 在**模块顶层**算 AUTH_FILE。
   *    不设的话它会指向用户真实的 ~/.pi/agent/auth.json —— 这个测试会往里
   *    写假凭证，把真密钥弄丢（项目已经因为「测试写真实用户数据」踩过两次，
   *    credentials.ts 自己的注释里也写了这条）。
   */
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
  const { listAuthProviders, authFileInfo } = await import('../out/test/credentials.mjs')

  /* ---- 安全闸：确认真的落在临时目录，否则立刻停手 ---- */
  const info = await authFileInfo()
  if (!info.path.startsWith(dir)) {
    ok(false, '凭证沙盒自检：AUTH_FILE 落在临时目录', `实际 = ${info.path}（已中止，避免写坏真实凭证）`)
    return
  }
  ok(true, '凭证沙盒自检：AUTH_FILE 落在临时目录')

  /* ---- 合成 auth.json：一个 OAuth 订阅 + 一个 API key + 一个目录外的自定义项 ---- */
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

  /*
   * ---- 假 pi ----
   *
   * ⚠️ 每次调用写**一个独立的标记文件**，不能都 append 到同一个日志：
   *    deep 会对 21 项并发起进程，Windows 上并发 append 同一个文件会相互踩，
   *    写失败的那个进程直接崩掉 → checkViaPi 拿到 err → 降级成 unknown →
   *    保留原状态。那样回归断言会「假通过」（状态对，但不是因为问了正确的
   *    provider 名）。踩过。
   *
   *    文件名用 `provider@随机串`（`|` 在 Windows 文件名里非法，别用）：
   *    provider 名（[a-z0-9-]）里不可能出现 `@`，所以能无损还原，
   *    而且顺便能数出**一共探测了几次**
   *    （xai / xai-api 与 openrouter / openrouter-key 会问同一个 provider 名，
   *    只按 provider 名建文件会互相覆盖、数少了 2 次）。
   */
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
  /** 假 pi 被问过的 provider 名（每次调用一条，同名会重复出现）。 */
  const asked = () => {
    try {
      return readdirSync(callsDir).map((f) => f.split('@')[0])
    } catch {
      return []
    }
  }

  /* ================= 1. 浅查：只比对 auth.json，不起 pi ================= */
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

  /* ================= 2. 深查：逐个问 pi ================= */
  const deep = await listAuthProviders(pi, true)
  const dp = (id) => deep.find((x) => x.id === id)
  /* 深查跑完要重新读一次标记文件 —— 上面那个 calls 是浅查之前的快照（必然为空）。 */
  calls = asked()

  /*
   * 回归本体：openai-codex 必须**按自己的名字**去问 pi。
   * 修之前这里问的是 `openai`，假 pi 会说 not_ready → 这一行变成 missing。
   */
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
  ok(calls.length === deep.length, `深查给每一项都问了 pi（${deep.length} 项）`, `实际 ${calls.length} 次`)
  ok(
    calls.every((x) => x.length > 0),
    '深查：每次探测都带了非空 provider 名（空名会让 pi 直接报错）'
  )
}
