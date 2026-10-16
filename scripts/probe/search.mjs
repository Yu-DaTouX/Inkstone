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

  const ignoredProbe = await mod.runSearch(
    { text: query, sources: ['wikipedia', 'definitely-not-a-source'] },
    { runner: mod.createOpencliRunner(), now: () => Date.now() }
  )
  if ((ignoredProbe.ignoredSources ?? []).includes('definitely-not-a-source')) {
    console.log('未知来源被点名:', mod.searchSummary(ignoredProbe))
  } else {
    console.log('✗ 未知来源没有被点名（ignoredSources 丢了）')
    worst = 1
  }
}

process.exit(worst)
