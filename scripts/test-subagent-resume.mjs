import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const DAY = 24 * 60 * 60 * 1000

export async function runSubagentResumeTests(ok, mods) {
  const { resume, prune, cache, notice } = mods

  const base = { appendSystemPrompt: 'sys', extensions: ['/ext/a.js', '/ext/b.js'], readOnlyExtension: '/ext/ro.js' }
  const digest = resume.launchDigest(base)
  ok(digest === resume.launchDigest({ ...base, extensions: [...base.extensions] }), '续派前缀：相同内容摘要一致')
  ok(digest !== resume.launchDigest({ ...base, appendSystemPrompt: 'sys2' }), '续派前缀：系统提示变化摘要不同')
  ok(digest !== resume.launchDigest({ ...base, extensions: ['/ext/b.js', '/ext/a.js'] }), '续派前缀：扩展顺序变化摘要不同')

  const same = resume.resolveResumeLaunch({ launch: base, digest }, base, () => true)
  ok(!same.kept && !same.prefixChanged && same.launch === base, '续派前缀：未变化时直接用当前值')
  const changed = { ...base, appendSystemPrompt: 'new sys' }
  const kept = resume.resolveResumeLaunch({ launch: base, digest }, changed, () => true)
  ok(kept.kept && kept.launch.appendSystemPrompt === 'sys' && !kept.prefixChanged, '续派前缀：不一致时沿用原运行的值')
  const missing = resume.resolveResumeLaunch({ launch: base, digest }, changed, (path) => path !== '/ext/a.js')
  ok(!missing.kept && missing.prefixChanged && missing.launch === changed, '续派前缀：原扩展文件已不存在时改用当前值并标记前缀已变')
  const unknown = resume.resolveResumeLaunch(undefined, changed, () => true)
  ok(!unknown.kept && !unknown.prefixChanged && unknown.launch === changed, '续派前缀：旧记录没有保存时用当前值')

  const input = { status: 'done', isolation: 'shared-cwd', review: 'none', live: true, worktreeAlive: false, forkLaunchSaved: false }
  ok(resume.subagentResumability(input).ok, '可续派：普通子代理结束后可续派')
  ok(!resume.subagentResumability({ ...input, status: 'running' }).ok, '可续派：运行中不是续派')
  ok(!resume.subagentResumability({ ...input, launchFailed: true }).ok, '可续派：没启动成功的不可续派')
  ok(resume.subagentResumability({ ...input, isolation: 'worktree', review: 'pending', worktreeAlive: true }).ok, '可续派：未审阅的 worktree 可续派')
  const gone = resume.subagentResumability({ ...input, isolation: 'worktree', review: 'merged' })
  ok(!gone.ok && /worktree/.test(gone.reason ?? ''), '可续派：已合并的 worktree 不可续派并说明原因', gone.reason)
  ok(!resume.subagentResumability({ ...input, fork: true, live: false }).ok, '可续派：重启后没有来源信息的 fork 不可续派')
  ok(resume.subagentResumability({ ...input, fork: true, live: false, forkLaunchSaved: true }).ok, '可续派：保存了来源信息的 fork 重启后可续派')

  const forkLaunch = resume.persistableForkLaunch({
    cwd: '/w', args: ['--extension', 'x'], sessionFile: '/s.jsonl', model: 'p/m', thinkingLevel: 'high',
    env: { YAN_PROJECT_ID: 'p', PI_CODING_AGENT_DIR: '/a', YAN_CLI_TOKEN: 'secret', YAN_CLI_URL: 'http://x', PATH: '/bin', OPENAI_API_KEY: 'k', PI_API_KEY: 'k2' }
  })
  ok(JSON.stringify(Object.keys(forkLaunch.env).sort()) === JSON.stringify(['PI_CODING_AGENT_DIR', 'YAN_PROJECT_ID']), 'fork 持久化：只保留非敏感的 YAN_/PI_ 变量', JSON.stringify(forkLaunch.env))
  ok(!('sessionFile' in forkLaunch), 'fork 持久化：不保存来源会话文件路径')
  ok(resume.restoreForkSource(forkLaunch, '/child.jsonl').sessionFile === '/child.jsonl', 'fork 恢复：换成自己的会话文件')

  const items = [
    { id: 'a', lastActiveAt: 100 * DAY, rank: 0, terminal: true, reviewed: true, live: false },
    { id: 'b', lastActiveAt: 10 * DAY, rank: 1, terminal: true, reviewed: true, live: false },
    { id: 'c', lastActiveAt: 10 * DAY, rank: 2, terminal: true, reviewed: false, live: false },
    { id: 'd', lastActiveAt: 10 * DAY, rank: 3, terminal: false, reviewed: true, live: false },
    { id: 'e', lastActiveAt: 10 * DAY, rank: 4, terminal: true, reviewed: true, live: true }
  ]
  const doomed = resume.planSubagentPrune(items, { now: 100 * DAY, maxAgeMs: 60 * DAY, keep: 1 })
  ok(JSON.stringify(doomed) === JSON.stringify(['b']), '淘汰：超过天数且超出条数才删，只删已处理、已结束、不在运行的', JSON.stringify(doomed))
  ok(resume.planSubagentPrune(items, { now: 100 * DAY, maxAgeMs: 60 * DAY, keep: 1000 }).length === 0, '淘汰：条数内的旧记录也保留（满足其一即保留）')
  ok(resume.planSubagentPrune(items, { now: 100 * DAY, maxAgeMs: 1000 * DAY, keep: 1 }).length === 0, '淘汰：天数内的记录即使超出条数也保留')

  const dir = await mkdtemp(join(tmpdir(), 'inkstone-subagent-prune-'))
  try {
    const now = Date.now()
    const write = async (id, record, ageDays) => {
      await writeFile(join(dir, `${id}.json`), JSON.stringify(record))
      await writeFile(join(dir, `${id}.patch`), 'p')
      await mkdir(join(dir, 'sessions', id), { recursive: true })
      await writeFile(join(dir, 'sessions', id, 'a.jsonl'), '{}')
      const at = new Date(now - ageDays * DAY)
      await utimes(join(dir, `${id}.json`), at, at)
    }
    await write('sub-00000001', { status: 'done', review: 'none' }, 90)
    await write('sub-00000002', { status: 'done', review: 'pending' }, 90)
    await write('sub-00000003', { status: 'error', review: 'none' }, 90)
    await write('sub-00000004', { status: 'error', review: 'none', hidden: true }, 90)
    await write('sub-00000005', { status: 'done', review: 'merged' }, 1)
    await write('sub-00000006', { status: 'done', review: 'archived' }, 90)
    await write('sub-00000007', { status: 'done', review: 'none' }, 90)
    const removed = await prune.pruneSubagentArchive(dir, { now, keepDays: 60, keepCount: 1, liveIds: new Set(['sub-00000007']) })
    ok(JSON.stringify([...removed].sort()) === JSON.stringify(['sub-00000001', 'sub-00000004']), '淘汰执行：删除过期的已处理记录', JSON.stringify(removed))
    const left = (await readdir(dir)).sort()
    ok(!left.includes('sub-00000001.json') && !left.includes('sub-00000001.patch') && !(await readdir(join(dir, 'sessions'))).includes('sub-00000001'), '淘汰执行：记录、补丁与会话目录一起删')
    ok(['02', '03', '05', '06', '07'].every((n) => left.includes(`sub-000000${n}.json`)), '淘汰执行：待审阅、未处理的失败、较新的、已归档补丁、正在使用的都保留', left.join(','))
    const counted = await prune.pruneSubagentArchive(dir, { now, keepDays: 60, keepCount: 1000 })
    ok(counted.length === 0, '淘汰执行：条数内的记录全部保留', JSON.stringify(counted))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  const anthropic = { provider: 'anthropic', api: 'anthropic-messages' }
  ok(cache.wantsLongCache(anthropic, { anthropic: { type: 'oauth' } }), '缓存保留：Anthropic 订阅登录用长缓存')
  ok(!cache.wantsLongCache(anthropic, { anthropic: { type: 'api_key', key: 'k' } }), '缓存保留：Anthropic API Key 保持默认')
  ok(!cache.wantsLongCache(anthropic, {}), '缓存保留：没有凭据记录保持默认')
  ok(!cache.wantsLongCache({ provider: 'openai', api: 'openai-responses' }, { anthropic: { type: 'oauth' }, openai: { type: 'oauth' } }), '缓存保留：其他提供商不改')
  ok(!cache.wantsLongCache({ provider: 'claude-bridge', api: 'anthropic-messages' }, { anthropic: { type: 'oauth' } }), '缓存保留：非 anthropic 提供商不改')

  const authDir = await mkdtemp(join(tmpdir(), 'inkstone-cache-auth-'))
  const savedEnv = { dir: process.env.PI_CODING_AGENT_DIR, ret: process.env.PI_CACHE_RETENTION }
  try {
    process.env.PI_CODING_AGENT_DIR = authDir
    const handlers = {}
    const fakePi = { on: (name, fn) => { handlers[name] = fn } }
    const load = () => { delete globalThis[Symbol.for('yan.cacheRetention')]; for (const key of Object.keys(handlers)) delete handlers[key]; cache.default(fakePi) }
    await writeFile(join(authDir, 'auth.json'), JSON.stringify({ anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } }))
    delete process.env.PI_CACHE_RETENTION
    load()
    handlers.turn_start({}, { model: anthropic })
    ok(process.env.PI_CACHE_RETENTION === 'long', '缓存保留：订阅登录的 Anthropic 回合设为 long')
    handlers.turn_start({}, { model: { provider: 'openai', api: 'openai-responses' } })
    ok(process.env.PI_CACHE_RETENTION === undefined, '缓存保留：切到其他提供商回合立即取消')
    handlers.turn_start({}, { model: anthropic })
    await writeFile(join(authDir, 'auth.json'), JSON.stringify({ anthropic: { type: 'api_key', key: 'k' } }))
    handlers.turn_start({}, { model: anthropic })
    ok(process.env.PI_CACHE_RETENTION === undefined, '缓存保留：切换到 API Key 后下一回合回到默认')
    handlers.turn_start({}, undefined)
    ok(process.env.PI_CACHE_RETENTION === undefined, '缓存保留：回合没有模型信息时沿用上一次的判断')
    process.env.PI_CACHE_RETENTION = 'short'
    load()
    ok(Object.keys(handlers).length === 0, '缓存保留：用户显式设置了环境变量时不接管')
    delete process.env.PI_CACHE_RETENTION
  } finally {
    if (savedEnv.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedEnv.dir
    if (savedEnv.ret === undefined) delete process.env.PI_CACHE_RETENTION; else process.env.PI_CACHE_RETENTION = savedEnv.ret
    delete globalThis[Symbol.for('yan.cacheRetention')]
    await rm(authDir, { recursive: true, force: true })
  }

  const run = { id: 'sub-aaaaaaaa', task: 't', status: 'done', isolation: 'shared-cwd', review: 'none' }
  const withHint = notice.buildSubagentNotice({ ...run, resumable: { ok: true } })
  ok(withHint.includes('yan subagent send --id sub-aaaaaaaa') && withHint.includes('可续派'), '完成通知：附可续派提示')
  const blocked = notice.buildSubagentNotice({ ...run, resumable: { ok: false, reason: '工作树已清理' } })
  ok(blocked.includes('不可续派：工作树已清理'), '完成通知：不可续派时说明原因')
  ok(!notice.buildSubagentNotice(run).includes('续派'), '完成通知：没有 resumable 字段时不加提示')
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const out = await mkdtemp(join(tmpdir(), 'inkstone-resume-build-'))
  const compile = async (entry, name) => {
    const outfile = join(out, `${name}.mjs`)
    await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
    return import(pathToFileURL(outfile).href)
  }
  let passed = 0
  let failed = 0
  try {
    await runSubagentResumeTests((condition, label, detail) => {
      if (condition) passed++
      else { failed++; console.error(`✗ ${label}${detail === undefined ? '' : ` ← ${detail}`}`) }
    }, {
      resume: await compile('src/main/subagent-resume.ts', 'resume'),
      prune: await compile('src/main/subagent-prune.ts', 'prune'),
      cache: await compile('resources/pi-extensions/cache-retention.js', 'cache'),
      notice: await compile('src/shared/subagent-notice.ts', 'notice')
    })
  } finally {
    await rm(out, { recursive: true, force: true })
  }
  console.log(`subagent-resume: ${passed} 通过 / ${failed} 失败`)
  if (failed) process.exitCode = 1
}
