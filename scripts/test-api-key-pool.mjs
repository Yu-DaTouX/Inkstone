import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function runApiKeyPoolTests(ok) {
  const dir = await mkdtemp(join(tmpdir(), 'yan-keypool-'))
  const piDir = join(dir, 'pi')
  const yanDir = join(dir, 'yan')
  const prev = { pi: process.env.YAN_PI_DIR, yan: process.env.YAN_DATA_DIR }
  process.env.YAN_PI_DIR = piDir
  process.env.YAN_DATA_DIR = yanDir
  try {
    const { build } = await import('../node_modules/esbuild/lib/main.js')
    await build({ entryPoints: ['src/main/api-key-pool.ts'], outfile: 'out/test/api-key-pool.mjs', bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', external: ['electron'] })
    const pool = await import(pathToFileURL(fileURLToPath(new URL('../out/test/api-key-pool.mjs', import.meta.url))).href + `?t=${Date.now()}`)
    const authPath = join(piDir, 'auth.json')
    const storePath = join(yanDir, 'api-keys.json')
    const auth = async () => JSON.parse(await readFile(authPath, 'utf8'))
    const store = async () => JSON.parse(await readFile(storePath, 'utf8'))

    const { mkdir } = await import('node:fs/promises')
    await mkdir(piDir, { recursive: true })
    await writeFile(authPath, JSON.stringify({ deepseek: { type: 'api_key', key: 'sk-old-1111' }, anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } }))

    let pools = await pool.listApiKeyPools()
    ok(pools.deepseek?.length === 1 && pools.deepseek[0].active && pools.deepseek[0].id === 'current', '已有 key 自动显示为当前项（尚未入库）', JSON.stringify(pools.deepseek))
    ok(!pools.anthropic, 'OAuth 凭证不进 key 列表')
    ok(!JSON.stringify(pools).includes('sk-old-1111'), '列表只给打码后的 key', JSON.stringify(pools))
    ok(pools.deepseek[0].masked === 'sk-…1111', '打码格式：前 3 位 + 后 4 位', pools.deepseek[0].masked)

    ok((await pool.addApiKey('deepseek', '  sk-new-2222  ', '公司')).ok, '添加第二个 key')
    ok((await auth()).deepseek.key === 'sk-new-2222', '新 key 写入 auth.json 成为当前项')
    ok((await auth()).anthropic?.type === 'oauth', '不动其他供应商的凭证')
    let saved = (await store()).providers.deepseek
    ok(saved.length === 2 && saved[0].key === 'sk-old-1111' && saved[0].label === 'Key 1' && saved[1].label === '公司', '旧 key 先入库再添加新 key，备注正确', JSON.stringify(saved.map((k) => k.label)))

    pools = await pool.listApiKeyPools()
    const old = pools.deepseek.find((k) => k.label === 'Key 1')
    ok(pools.deepseek.filter((k) => k.active).length === 1 && !old.active, '同一时间只有一个当前项')

    ok(!(await pool.removeApiKey('deepseek', 'missing')).ok, '不能误删不存在的 key')

    ok((await pool.switchApiKey('deepseek', old.id)).ok, '切换回旧 key')
    ok((await auth()).deepseek.key === 'sk-old-1111', '切换后 auth.json 写入旧 key')

    ok((await pool.addApiKey('deepseek', 'sk-new-2222')).ok && (await store()).providers.deepseek.length === 2, '重复添加同一个 key 不会新增条目')
    ok((await auth()).deepseek.key === 'sk-new-2222', '重复添加的 key 变为当前项')

    ok((await pool.renameApiKey('deepseek', old.id, '  个人  ')).ok && (await store()).providers.deepseek[0].label === '个人', '改备注并去掉首尾空格')
    ok(!(await pool.renameApiKey('deepseek', old.id, '   ')).ok, '空备注被拒绝')

    const other = (await pool.listApiKeyPools()).deepseek.find((k) => !k.active)
    ok((await pool.removeApiKey('deepseek', other.id)).ok && (await store()).providers.deepseek.length === 1, '删除未使用的 key')
    ok((await auth()).deepseek.key === 'sk-new-2222', '删除备用 key 不影响当前 key')

    ok(!(await pool.switchApiKey('deepseek', 'nope')).ok, '切换到不存在的 key 返回错误')
    ok(!(await pool.addApiKey('../x', 'k')).ok, '非法供应商名被拒绝')
    ok(!(await pool.addApiKey('deepseek', '   ')).ok, '空 key 被拒绝')

    await writeFile(authPath, JSON.stringify({ xai: { type: 'api_key', key: 'xai-key-3333' } }))
    ok((await pool.renameApiKey('xai', 'current', '主账号')).ok, '给未入库的当前 key 改备注会先入库')
    ok((await store()).providers.xai?.[0]?.label === '主账号', '入库后备注保存正确')

    await writeFile(authPath, JSON.stringify({ xai: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } }))
    const blocked = await pool.addApiKey('xai', 'xai-new-4444')
    ok(!blocked.ok && /订阅/.test(blocked.error ?? ''), '同一 ID 下已有订阅登录时拒绝添加 API key', blocked.error)
    ok((await auth()).xai.type === 'oauth', '订阅登录凭证没有被覆盖')
    ok(!(await pool.switchApiKey('xai', (await store()).providers.xai[0].id)).ok && (await auth()).xai.type === 'oauth', '已有订阅登录时也拒绝切换')

    const preservedOAuth = (await auth()).xai
    ok((await pool.switchApiKey('xai', (await store()).providers.xai[0].id, preservedOAuth)).ok, '订阅凭证已安全保存后，允许显式切换回 API key')
    await writeFile(authPath, JSON.stringify({ xai: { ...preservedOAuth, refresh: 'new-refresh' } }))
    ok(!(await pool.addApiKey('xai', 'key-stale', undefined, preservedOAuth)).ok, '备份后订阅令牌发生变化时拒绝覆盖，避免并发丢失登录')
    ok((await pool.addApiKey('xai', 'key-next', 'API', (await auth()).xai)).ok, '安全备份当前订阅后允许添加 API key')

    await writeFile(authPath, JSON.stringify({ openai: { type: 'api_key', key: 'external-first' } }))
    ok((await pool.captureActiveApiKey('openai')).ok && (await store()).providers.openai[0].key === 'external-first', '开始订阅登录前可持久化外部配置的当前 key')
    await pool.addApiKey('openai', 'saved-second')
    await writeFile(authPath, JSON.stringify({ openai: { type: 'api_key', key: 'external-third' } }))
    await pool.switchApiKey('openai', (await store()).providers.openai[0].id)
    ok((await store()).providers.openai.some((k) => k.key === 'external-third'), '切换到已保存的 key 前保留后来外部配置的新 key')
    pools = await pool.listApiKeyPools()
    const deletedActive = await pool.removeApiKey('openai', pools.openai.find((k) => k.active).id)
    ok(deletedActive.ok && deletedActive.wasActive && !(await auth()).openai, '允许删除当前 key，同时只清理它自己的登录槽')
    ok((await pool.listApiKeyPools()).openai.length === 2, '删除当前 key 不会删除其他已保存的 key')
    await writeFile(authPath, JSON.stringify({ google: { type: 'api_key', key: 'single-external-key' } }))
    const deletedVirtual = await pool.removeApiKey('google', 'current')
    ok(deletedVirtual.ok && deletedVirtual.wasActive && !(await auth()).google, '只有一个外部 key、尚未入库时也支持单独删除')

    for (const provider of ['anthropic', 'google', 'groq', 'mistral', 'together', 'fireworks', 'nvidia', 'openrouter', 'commandcode', 'kimi-coding', 'minimax-cn', 'qwen-token-plan-cn', 'volcengine-ark', 'zai-coding-cn']) {
      ok((await pool.addApiKey(provider, `${provider}-key-a`)).ok && (await pool.addApiKey(provider, `${provider}-key-b`)).ok, `${provider} 支持保存多个 key`)
      const rows = (await pool.listApiKeyPools())[provider]
      ok(rows.length >= 2 && rows.filter((k) => k.active).length === 1, `${provider} 的 key 独立列出且只有一个当前项`)
    }

    ok((await pool.clearApiKeys('deepseek')).ok && !(await store()).providers.deepseek, '移除供应商时清空它的 key 列表')

    await writeFile(storePath, '{bad json')
    ok(!(await pool.addApiKey('deepseek', 'sk-z')).ok, '列表文件损坏时拒绝写入，保护已存的 key')
  } finally {
    if (prev.pi === undefined) delete process.env.YAN_PI_DIR
    else process.env.YAN_PI_DIR = prev.pi
    if (prev.yan === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = prev.yan
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let pass = 0
  let fail = 0
  await runApiKeyPoolTests((cond, name, detail) => {
    if (cond) pass++
    else fail++
    console.log(`${cond ? '✓' : '✗'} ${name}${!cond && detail ? `  ← ${detail}` : ''}`)
  })
  console.log(`api-key-pool: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
