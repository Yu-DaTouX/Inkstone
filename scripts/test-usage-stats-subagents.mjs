import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const DAY = 86_400_000

function userLine(ts, text = 'hello') {
  return JSON.stringify({ type: 'message', id: `u-${ts}`, parentId: null, timestamp: ts, message: { role: 'user', content: text } })
}

function replyLine(ts, opts = {}) {
  const {
    provider = 'commandcode',
    model = 'deepseek/deepseek-v4.1-flash',
    total,
    input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    cost = 0,
    diagnostics
  } = opts
  const usage = { input, output, cacheRead, cacheWrite }
  if (total !== undefined) usage.totalTokens = total
  usage.cost = { total: cost }
  return JSON.stringify({
    type: 'message',
    id: `a-${ts}-${model}`,
    parentId: `u-${ts}`,
    timestamp: ts,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'x'.repeat(4000) }],
      api: 'x',
      provider,
      model,
      usage,
      stopReason: 'stop',
      diagnostics
    }
  })
}

const iso = (ms) => new Date(ms).toISOString()

export async function runUsageStatsSubagentTests(ok) {
  const root = await mkdtemp(join(tmpdir(), 'inkstone-usage-sub-'))
  const bundleDir = await mkdtemp(join(tmpdir(), 'inkstone-usage-bundle-'))
  const mainDir = join(root, 'main-sessions')
  const dataDir = join(root, 'yan')
  const subRoot = join(dataDir, 'subagents', 'sessions')
  const cacheFile = join(dataDir, 'usage-stats.json')
  await mkdir(mainDir, { recursive: true })
  await mkdir(subRoot, { recursive: true })

  process.env.YAN_SESSIONS_DIR = mainDir
  process.env.YAN_DATA_DIR = dataDir

  const mainOut = join(bundleDir, 'usage-main.mjs')
  const sharedOut = join(bundleDir, 'usage-shared.mjs')
  await build({ entryPoints: ['src/main/usage-stats.ts'], outfile: mainOut, bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent' })
  await build({ entryPoints: ['src/shared/usage-stats.ts'], outfile: sharedOut, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const m = await import(pathToFileURL(mainOut).href)
  const s = await import(pathToFileURL(sharedOut).href)

  const reader = () => m.createUsageReader()
  const reset = async () => {
    await rm(mainDir, { recursive: true, force: true })
    await rm(subRoot, { recursive: true, force: true })
    await mkdir(mainDir, { recursive: true })
    await mkdir(subRoot, { recursive: true })
  }
  const writeMain = async (name, lines) => writeFile(join(mainDir, name), `${lines.join('\n')}\n`)
  const writeChild = async (id, name, lines) => {
    await mkdir(join(subRoot, id), { recursive: true })
    await writeFile(join(subRoot, id, name), `${lines.join('\n')}\n`)
  }

  const now = Date.now()
  const childDay = new Date(now - 3 * DAY)
  const childHour = (new Date(now - DAY).getHours() + 12) % 24
  const childAt = new Date(childDay.getFullYear(), childDay.getMonth(), childDay.getDate(), childHour).getTime()

  await reset()
  await writeMain('m1.jsonl', [
    userLine(iso(now - DAY)),
    replyLine(iso(now - DAY + 1000), { total: 300 }),
    userLine(iso(now - 2 * DAY)),
    replyLine(iso(now - 2 * DAY + 1000), { total: 200 })
  ])
  await writeChild('child-1', 's.jsonl', [
    userLine(iso(childAt)),
    replyLine(iso(childAt + 1000), { total: 1000 }),
    replyLine(iso(now - 4 * DAY), { total: 500 })
  ])
  const base = await reader()('all')
  ok(base.tokenBreakdown.main === 500, '拆分：主会话 token 只来自主会话文件')
  ok(base.tokenBreakdown.subagents === 1500, '拆分：子代理 token 来自子代理原生 JSONL')
  ok(base.tokens === 2000 && base.tokens === base.tokenBreakdown.main + base.tokenBreakdown.subagents, '合计等于拆分之和')
  ok(base.sessions === 1, '会话数只算主会话')
  ok(base.messages === 4, '消息数只算主会话')
  ok(base.activeDays === 2, '活跃天数只算主会话')
  ok(base.peakHour === new Date(now - DAY).getHours(), '高峰时段只算主会话（子代理的不同小时不参与）')
  ok(base.heat.find((d) => d.date === s.localDay(childAt))?.tokens === 1000, '热力图纳入子代理当日 token')
  ok(base.heat.find((d) => d.date === s.localDay(now - DAY))?.tokens === 300, '热力图把主会话当日 token 一起算入')
  const defaults = await m.readUsageStats('all')
  ok(defaults.tokenBreakdown.subagents === 1500 && typeof defaults.userName === 'string', '默认入口 readUsageStats 返回同样的拆分')

  await reset()
  const mainModels = Array.from({ length: 9 }, (_, i) => [`p-main/m${i + 1}`, (i + 1) * 10])
  await writeMain('models.jsonl', mainModels.map(([model, total]) => replyLine(iso(now - DAY), { provider: model.split('/')[0], model: model.split('/')[1], total })))
  await writeChild('child-models', 's.jsonl', [replyLine(iso(now - DAY), { provider: 'p-child', model: 'c1', total: 95 })])
  const models = await reader()('all')
  ok(models.models.length === 8, '合并后模型仍只取 top8')
  ok(models.models[0].key === 'c1', '子代理的大用量模型进入顶部（先合原始模型再排序）')
  ok(models.models.some((x) => x.key === 'm9'), '主会话大模型保留')
  ok(!models.models.some((x) => x.key === 'm1') && !models.models.some((x) => x.key === 'm2'), '最小的两个模型被截掉，没有按来源各取一份')

  await reset()
  await writeMain('range.jsonl', [replyLine(iso(now - 40 * DAY), { total: 700 }), replyLine(iso(now - DAY), { total: 100 })])
  await writeChild('child-range', 's.jsonl', [replyLine(iso(now - 40 * DAY), { total: 900 }), replyLine(iso(now - 3 * DAY), { total: 300 })])
  const all = await reader()('all')
  const month = await reader()('30d')
  const week = await reader()('7d')
  ok(all.tokenBreakdown.main === 800 && all.tokenBreakdown.subagents === 1200 && all.tokens === 2000, 'all：主 800 / 子 1200')
  ok(month.tokenBreakdown.main === 100 && month.tokenBreakdown.subagents === 300 && month.tokens === 400, '30 天：只保留范围内两类')
  ok(week.tokenBreakdown.main === 100 && week.tokenBreakdown.subagents === 300 && week.tokens === 400, '7 天：子代理 3 天前的记录在内，40 天前的不在')
  ok(all.at === all.at && Number.isFinite(all.at), '返回统计时间 at')

  await reset()
  await writeChild('child-parts', 's.jsonl', [replyLine(iso(now - DAY), { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 })])
  const parts = await reader()('all')
  ok(parts.tokenBreakdown.subagents === 20, '缓存读写回退：input+output+cacheRead+cacheWrite')

  await reset()
  await writeChild('child-only', 's.jsonl', [replyLine(iso(now - DAY), { total: 640 })])
  const childOnly = await reader()('all')
  ok(childOnly.sessions === 0 && childOnly.messages === 0, '只有子代理时主会话指标仍为 0，不虚增')
  ok(childOnly.tokenBreakdown.main === 0 && childOnly.tokenBreakdown.subagents === 640 && childOnly.tokens === 640, '只有子代理时 Token 仍显示')

  await reset()
  await writeChild('hidden-1', 's.jsonl', [replyLine(iso(now - DAY), { total: 11 })])
  await writeChild('failed-2', 's.jsonl', [replyLine(iso(now - DAY), { total: 22 })])
  await writeChild('cancelled-3', 's.jsonl', [replyLine(iso(now - DAY), { total: 33 })])
  await writeFile(join(subRoot, 'snapshot.json'), JSON.stringify({ usage: { totalTokens: 999999 } }))
  await writeFile(join(subRoot, 'result.json'), JSON.stringify({ tokens: 999999 }))
  await writeChild('no-usage', 's.jsonl', [userLine(iso(now - DAY))])
  const statuses = await reader()('all')
  ok(statuses.tokenBreakdown.subagents === 66, '各状态子代理的真实 usage 相加，snapshot/result .json 与无 usage 行不计')

  await reset()
  const providers = ['anthropic', 'claude-bridge', 'openai-codex', 'commandcode', 'deepseek']
  const diagnostics = { detail: '诊断'.repeat(6000), provider: 'fake', model: 'fake', usage: { totalTokens: 999999, cost: { total: 999 } } }
  await writeMain('providers.jsonl', providers.map((provider, i) => replyLine(iso(now - DAY), { provider, model: 'shared-model', total: (i + 1) * 100, cost: (i + 1) / 10, diagnostics })))
  await writeChild('providers-child', 's.jsonl', providers.map((provider, i) => replyLine(iso(now - DAY + 1000), { provider, model: 'shared-model', total: (i + 1) * 10, cost: (i + 1) / 100, diagnostics })))
  const providerStats = await reader()('all')
  ok(providerStats.tokens === 1650 && providerStats.tokenBreakdown.main === 1500 && providerStats.tokenBreakdown.subagents === 150, '各渠道长尾诊断：主会话与子代理均不漏算或虚增')
  ok(providerStats.models.length === 1 && providerStats.models[0].key === 'shared-model' && providerStats.models[0].tokens === 1650, '同版本模型跨供应商、跨主会话与子代理合并为一行')
  ok(providerStats.models[0].sources.join(',') === providers.map((provider) => `${provider}/shared-model`).sort().join(','), '合并后保留全部原始供应商来源')
  ok(Math.abs(providerStats.cost - 1.65) < 1e-9 && Math.abs(providerStats.costBreakdown.main - 1.5) < 1e-9 && Math.abs(providerStats.costBreakdown.subagents - 0.15) < 1e-9, '各渠道费用按主会话与子代理精确拆分')
  ok(Math.abs(providerStats.models[0].cost - 1.65) < 1e-9, '合并费用为各渠道原始费用之和，不受嵌套诊断费用干扰')
  await reset()
  await writeMain('variants.jsonl', [
    replyLine(iso(now - DAY), { provider: 'anthropic', model: 'claude-opus-5-5', total: 10 }),
    replyLine(iso(now - DAY), { provider: 'claude-bridge', model: 'Claude-Opus-5-5', total: 20 }),
    replyLine(iso(now - DAY), { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', total: 30 }),
    replyLine(iso(now - DAY), { provider: 'deepseek', model: 'deepseek-v4.1-flash', total: 40 }),
    replyLine(iso(now - DAY), { provider: 'deepseek', model: 'deepseek-flash', total: 50 }),
    replyLine(iso(now - DAY), { provider: 'anthropic', model: 'claude-opus-5-5-thinking', total: 60 })
  ])
  const variants = (await reader()('all')).models
  const tokensOf = (key) => variants.find((model) => model.key === key)?.tokens
  ok(tokensOf('claude-opus-5-5') === 30 && tokensOf('deepseek-v4.1-flash') === 70, '同版本 ID 去掉供应商前缀与大小写差异后合并')
  ok(tokensOf('deepseek-flash') === 50 && tokensOf('claude-opus-5-5-thinking') === 60 && variants.length === 4, '别名、不同版本或变体不强行合并')

  await reset()
  const parentFile = join(mainDir, 'parent.jsonl')
  const forkedAt = iso(now - 2 * DAY)
  const inherited = [userLine(iso(now - 3 * DAY)), replyLine(iso(now - 3 * DAY + 1000), { total: 100, cost: 1 })]
  const forkHeader = JSON.stringify({ type: 'session', timestamp: forkedAt, parentSession: parentFile })
  await writeFile(parentFile, `${inherited.join('\n')}\n`)
  await writeMain('fork.jsonl', [forkHeader, ...inherited, userLine(forkedAt), replyLine(forkedAt, { total: 20, cost: 0.2 })])
  await writeChild('fork-child', 's.jsonl', [forkHeader, ...inherited, userLine(forkedAt), replyLine(forkedAt, { total: 30, cost: 0.3 })])
  const forks = await reader()('all')
  ok(forks.tokens === 150 && forks.tokenBreakdown.main === 120 && forks.tokenBreakdown.subagents === 30, '主会话与子代理 fork 只算分叉后新用量，继承历史不重算')
  ok(forks.messages === 4 && forks.sessions === 2 && Math.abs(forks.cost - 1.5) < 1e-9, 'fork 继承消息与费用不重复计数，分叉同毫秒的新消息仍计入')
  const forkReader = reader()
  await appendFile(join(subRoot, 'fork-child', 's.jsonl'), `${replyLine(iso(now - DAY), { total: 40, cost: 0.4 })}\n`)
  ok((await forkReader('all')).tokenBreakdown.subagents === 70, '缓存重启后追加 fork 子代理，只算新增用量')
  ok((await forkReader('all')).tokens === 190, 'fork 子代理重复读取不翻倍')
  const persistedFork = Object.values(JSON.parse(await readFile(cacheFile, 'utf8')).files).find((entry) => entry.sourceKind === 'subagent')
  ok(persistedFork.forkedAt === Date.parse(forkedAt), 'fork 时间边界随增量偏移一起持久化')

  await reset()
  const aliasFile = join(mainDir, 'alias.jsonl')
  await writeFile(aliasFile, `${replyLine(iso(now - DAY), { total: 50 })}\n`)
  const stat = await import('node:fs/promises').then((fs) => fs.stat(aliasFile))
  const aliasSources = {
    listMain: async () => [
      { path: aliasFile, size: stat.size },
      { path: relative(process.cwd(), aliasFile), size: stat.size },
      ...(process.platform === 'win32' ? [{ path: aliasFile.toUpperCase(), size: stat.size }] : [])
    ],
    listSubagents: async () => [{ path: aliasFile, size: stat.size }],
    cacheFile: join(root, 'dedupe-cache.json')
  }
  const aliasStats = await m.createUsageReader(aliasSources)('all')
  ok(aliasStats.tokens === 50 && aliasStats.tokenBreakdown.main === 50 && aliasStats.tokenBreakdown.subagents === 0, '同一物理文件跨来源、相对/大小写别名均不重复计数')
  const linkedFile = join(mainDir, 'linked.jsonl')
  await writeFile(linkedFile, `${replyLine(iso(now - DAY), { total: 77 })}\n`)
  const linkAlias = join(mainDir, 'link-alias.jsonl')
  let linked = false
  try {
    await symlink(linkedFile, linkAlias)
    linked = true
  } catch {
  }
  if (linked) {
    const linkedStat = (await import('node:fs/promises')).stat(linkAlias)
    const symSources = {
      listMain: async () => [
        { path: linkedFile, size: (await linkedStat).size },
        { path: linkAlias, size: (await linkedStat).size }
      ],
      listSubagents: async () => [],
      cacheFile: join(root, 'symlink-cache.json')
    }
    const symStats = await m.createUsageReader(symSources)('all')
    ok(symStats.tokens === 77, '符号链接别名经 realpath 去重')
  }

  await reset()
  const incFile = join(mainDir, 'inc.jsonl')
  const first = replyLine(iso(now - DAY), { total: 100 })
  await writeFile(incFile, `${first}\n`)
  const incReader = reader()
  ok((await incReader('all')).tokens === 100, '首次扫描')
  await appendFile(incFile, `${replyLine(iso(now - DAY + 1000), { total: 50 })}\n`)
  ok((await incReader('all')).tokens === 150, '追加后只读新字节，不重复')
  await writeFile(incFile, `${first}\n`)
  ok((await incReader('all')).tokens === 100, '文件变短时从头重建，旧增量不残留')
  await unlink(incFile)
  ok((await incReader('all')).tokens === 0, '文件删除后缓存条目一起清掉')
  await writeFile(incFile, `${replyLine(iso(now - DAY), { total: 200 })}\n`)
  const restarted = reader()
  ok((await restarted('all')).tokens === 200, '新读取器从磁盘缓存重启后结果一致')
  const savedCache = JSON.parse(await readFile(cacheFile, 'utf8'))
  ok(savedCache.version === 4, '缓存写出 v4 版本')
  ok(Object.values(savedCache.files).every((entry) => entry.sourceKind === 'main' || entry.sourceKind === 'subagent'), '缓存条目带 sourceKind')

  const realKey = Object.keys(savedCache.files)[0]
  await writeFile(cacheFile, JSON.stringify({ version: 1, files: { [realKey]: { size: 1, offset: 0, usage: { '2020-01-01': { m: 1, t: 999999, h: {}, models: {} } } } } }))
  const migrated = await reader()('all')
  ok(migrated.tokens === 200, '旧 v1 缓存被丢弃重建，不把旧计数当权威')
  ok(JSON.parse(await readFile(cacheFile, 'utf8')).version === 4, '迁移后缓存升到 v4')

  await writeMain('opus-long.jsonl', [replyLine(iso(now - DAY), { provider: 'anthropic', model: 'claude-opus-5-5', total: 300, cost: 0.3, diagnostics })])
  await reader()('all')
  const staleV3 = JSON.parse(await readFile(cacheFile, 'utf8'))
  staleV3.version = 3
  for (const entry of Object.values(staleV3.files)) {
    entry.usage = { '2020-01-01': { m: 1, t: 999999, c: 999, h: {}, models: {} } }
  }
  await writeFile(cacheFile, JSON.stringify(staleV3))
  const rebuiltV3 = await reader()('all')
  ok(rebuiltV3.tokens === 500 && Math.abs(rebuiltV3.cost - 0.3) < 1e-9, 'v3 缓存即使文件大小和偏移没变也整份重算，补回长尾 Opus 用量与费用')
  ok(JSON.parse(await readFile(cacheFile, 'utf8')).version === 4 && (await reader()('all')).tokens === 500, 'v3 迁移自动保存 v4，重启后不重复累计')

  await reset()
  const partialFile = join(mainDir, 'partial.jsonl')
  const complete = Buffer.from(replyLine(iso(now - DAY), { total: 88, diagnostics: { detail: '汉'.repeat(400000) } }))
  const partialReader = reader()
  await writeFile(partialFile, complete.subarray(0, complete.length - 2))
  ok((await partialReader('all')).tokens === 0, '未落完且跨 1 MiB 分块的行先不计数')
  await appendFile(partialFile, Buffer.concat([complete.subarray(complete.length - 2), Buffer.from('\n')]))
  ok((await partialReader('all')).tokens === 88 && (await partialReader('all')).tokens === 88, '跨分块多字节行补完后精确计一次')

  await reset()
  await writeMain('bad.jsonl', ['{not json at all', replyLine(iso(now - DAY), { total: 42 }), ''])
  ok((await reader()('all')).tokens === 42, '坏行跳过，正常行仍计入')
  await rm(mainDir, { recursive: true, force: true })
  await rm(subRoot, { recursive: true, force: true })
  const missing = await reader()('all')
  ok(missing.tokens === 0 && missing.sessions === 0, '主/子目录缺失返回 0 而不是抛错')
  await mkdir(mainDir, { recursive: true })
  await mkdir(subRoot, { recursive: true })

  ok(s.tokenBreakdownOf({ tokens: 500 }).main === 500 && s.tokenBreakdownOf({ tokens: 500 }).subagents === 0, '缺 breakdown 的旧结果按全主会话兼容')
  const explicit = s.tokenBreakdownOf({ tokens: 500, tokenBreakdown: { main: 400, subagents: 100 } })
  ok(explicit.main === 400 && explicit.subagents === 100, '有新 breakdown 时原样返回')

  await rm(root, { recursive: true, force: true })
  await rm(bundleDir, { recursive: true, force: true })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let passed = 0
  let failed = 0
  const ok = (condition, message) => {
    if (condition) {
      passed++
      console.log(`  ok - ${message}`)
    } else {
      failed++
      console.error(`  FAIL - ${message}`)
    }
  }
  await runUsageStatsSubagentTests(ok)
  console.log(`\nusage-stats-subagents: ${passed} passed, ${failed} failed`)
  if (failed) process.exitCode = 1
  assert.equal(failed, 0)
}
