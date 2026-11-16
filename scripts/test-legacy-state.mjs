import './lib/test-isolate.mjs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const fsStub = {
  name: 'legacy-fs-hook',
  setup(build) {
    build.onResolve({ filter: /^node:fs\/promises$/ }, ({ path }) => ({ path, namespace: 'legacy-fs' }))
    build.onLoad({ filter: /.*/, namespace: 'legacy-fs' }, () => ({
      loader: 'js',
      contents: `const real = process.getBuiltinModule('node:fs/promises')
export const { mkdir, rename } = real
export async function lstat(path) {
  if (globalThis.__legacyDenied?.(String(path))) throw Object.assign(new Error('denied'), { code: 'EPERM' })
  return real.lstat(path)
}`
    }))
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { moveLegacyState, LEGACY_STATE_NAMES } = await compile('src/main/legacy-state.ts', { plugins: [fsStub] })
  const root = await mkdtemp(join(tmpdir(), 'inkstone-legacy-'))
  try {
    const yan = join(root, 'yan')
    await mkdir(join(yan, 'context-budget-v1'), { recursive: true })
    await writeFile(join(yan, 'context-budget-v1', 'historical-record.json'), '{"history":"keep"}')
    await writeFile(join(yan, 'handoffs.json'), '{"handoffs":[1]}')
    await writeFile(join(yan, 'schedules.json'), '[]')
    await writeFile(join(yan, 'desktop.json'), '{"theme":"dark"}')
    await writeFile(join(yan, 'memory.json'), '{"entries":[]}')
    await writeFile(join(yan, 'goals.json'), '{"goals":[]}')
    await writeFile(join(yan, 'session-layout.json'), '{"version":1,"entries":[]}')
    await mkdir(join(yan, 'sessions-live'), { recursive: true })

    const now = new Date(2026, 10, 16, 9, 30)
    const first = await moveLegacyState(yan, now)
    const target = join(yan, 'legacy', '2026-11-16')
    ok(first.target === target, '目标目录按本地日期命名', String(first.target))
    ok(first.moved.slice().sort().join() === 'context-budget-v1,handoffs.json,schedules.json', '只移动清单内存在的遗留项', first.moved.join())
    ok(await readFile(join(target, 'handoffs.json'), 'utf8') === '{"handoffs":[1]}', '文件内容原样保留')
    ok(await readFile(join(target, 'context-budget-v1', 'historical-record.json'), 'utf8') === '{"history":"keep"}', '目录整体移动且内容不变')
    const rest = (await readdir(yan)).sort()
    ok(rest.join() === 'desktop.json,goals.json,legacy,memory.json,session-layout.json,sessions-live', '有引用的和正在使用的文件不动', rest.join())
    ok(first.failed.length === 0, '没有失败项')

    const second = await moveLegacyState(yan, now)
    ok(second.target === null && second.moved.length === 0, '再次启动没有遗留项时什么也不做')

    await writeFile(join(yan, 'handoffs.json'), '{"handoffs":[2]}')
    const third = await moveLegacyState(yan, now)
    ok(third.moved.join() === 'handoffs.json' && await readFile(join(target, 'handoffs.json.2'), 'utf8') === '{"handoffs":[2]}', '同日同名不覆盖，改名后保留')
    ok(await readFile(join(target, 'handoffs.json'), 'utf8') === '{"handoffs":[1]}', '先前移入的文件未被改动')

    await writeFile(join(yan, 'collab.json'), '{}')
    await writeFile(join(yan, 'peers.json'), '{}')
    globalThis.__legacyDenied = (path) => path.includes(join('legacy', '2026-11-16', 'peers.json'))
    const guarded = await Promise.race([moveLegacyState(yan, now), new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))])
    delete globalThis.__legacyDenied
    ok(guarded !== 'timeout' && guarded.failed.join() === 'peers.json' && guarded.moved.join() === 'collab.json', '目标路径探测遇到权限错误时记为失败并跳过，不会无限循环', JSON.stringify(guarded))
    ok(await readFile(join(yan, 'peers.json'), 'utf8') === '{}', '失败项原地保留')

    const missing = await moveLegacyState(join(root, 'absent'), now)
    ok(missing.target === null && missing.moved.length === 0, '数据目录不存在时不报错')

    for (const name of ['memory.json', 'goals.json', 'spaces.json', 'agent-profiles.json', 'work-modes.json', 'artifact-docs.json', 'desktop.json', 'session-layout.json', 'sessions', 'subagents', 'attachments', 'repeat-guard', 'voice']) {
      ok(!LEGACY_STATE_NAMES.includes(name), `清单不含仍被引用的 ${name}`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
