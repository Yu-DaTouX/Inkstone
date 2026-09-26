/**
 * 搜索后端探针（实施-27 S0/S6）。
 *
 * 做什么：直接调 `src/main/search/opencli.ts`（esbuild 现场编译），
 *   ① `searchDoctor()` —— 后端在不在、版本、各来源依赖；
 *   ② 一次真实查询（默认三个 HTTP 直连来源）—— 逐来源状态与结果条数。
 *
 * 为什么单独一个探针：`yan search` 只能在砚的会话里跑（需要宿主注入的身份），
 * 而这个探针不需要宿主、不需要模型额度（cost 0），所以能进 CI / 本地反复跑。
 *
 * 用法：
 *   node scripts/probe/search.mjs                     # doctor + 默认查询
 *   node scripts/probe/search.mjs --query "关键词"
 *   node scripts/probe/search.mjs --sources arxiv     # 只查一个来源
 *   node scripts/probe/search.mjs --doctor-only
 *
 * 退出码：0 = 后端可用且有来源返回了结果；1 = 后端不可用（如实失败，不假装成功）。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { build } from '../../node_modules/esbuild/lib/main.js'

const OUT = 'out/probe'
mkdirSync(OUT, { recursive: true })

await build({
  entryPoints: ['src/main/search/opencli.ts'],
  outfile: 'out/probe/search-mod.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const mod = await import('../../out/probe/search-mod.mjs')

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const query = flag('query', 'flash attention')
const sources = flag('sources', '').split(',').filter(Boolean)
const doctorOnly = argv.includes('--doctor-only')

const doctor = await mod.searchDoctor()
console.log('=== doctor ===')
console.log(JSON.stringify(doctor, null, 2))

let worst = doctor.available ? 0 : 1
if (!doctorOnly) {
  const outcome = await mod.runSearch(
    { text: query, ...(sources.length ? { sources } : {}) },
    { runner: mod.createOpencliRunner(), now: () => Date.now() }
  )
  console.log('=== query ===')
  console.log(mod.searchSummary(outcome))
  console.log('sources:', JSON.stringify(outcome.sources))
  console.log('items:')
  for (const item of outcome.items.slice(0, 5)) console.log('  -', item.title, '\n   ', item.url)
  const file = join(OUT, `search-${Date.now()}.json`)
  writeFileSync(file, JSON.stringify({ doctor, outcome }, null, 2), 'utf8')
  console.log('原始结果:', file)
  const reached = outcome.sources.some((s) => s.status === 'ok' && s.count > 0)
  if (!reached) worst = 1
}

process.exit(worst)
