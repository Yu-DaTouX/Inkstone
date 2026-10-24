import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const MANIFEST = join(HERE, 'test-unregistered.json')
const LIVE_PATTERN = /_electron|from 'electron'|ELECTRON_EXEC_PATH|electron\.exe|launchApp|test-live|playwright|remote-debugging-port|cdp/

const testNames = readdirSync(HERE)
  .filter((name) => /^test-.+\.mjs$/.test(name))
  .map((name) => name.slice(0, -'.mjs'.length))
  .sort()

const sources = readdirSync(HERE, { recursive: true })
  .filter((name) => /\.(mjs|cjs|js|json)$/.test(String(name)))
  .map((name) => String(name))
  .filter((name) => name !== 'test-unregistered.json' && name !== 'check-test-registry.mjs')
  .map((name) => ({ name: name.replace(/\\/g, '/'), text: readFileSync(join(HERE, name), 'utf8') }))
sources.push({ name: 'package.json', text: readFileSync(join(ROOT, 'package.json'), 'utf8') })

function referenced(test) {
  const own = `${test}.mjs`
  const pattern = new RegExp(`(^|[^\\w-])${test.replace(/[-]/g, '\\-')}($|[^\\w-])`)
  return sources.some((source) => source.name !== own && pattern.test(source.text))
}

const orphans = testNames.filter((test) => !referenced(test))

if (process.argv.includes('--write')) {
  const live = []
  const pending = []
  for (const test of orphans) {
    const text = readFileSync(join(HERE, `${test}.mjs`), 'utf8')
    if (test.includes('live') || LIVE_PATTERN.test(text)) live.push(test)
    else pending.push(test)
  }
  writeFileSync(MANIFEST, `${JSON.stringify({ live, pending }, null, 2)}\n`)
  console.log(`test-unregistered.json：live ${live.length}，pending ${pending.length}`)
  process.exit(0)
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const listed = new Set([...(manifest.live ?? []), ...(manifest.pending ?? [])])
const problems = []
for (const test of orphans) {
  if (!listed.has(test)) problems.push(`未注册：scripts/${test}.mjs 没有被任何测试入口引用；接入 test-unit.mjs / test-live.mjs，或登记到 test-unregistered.json`)
}
for (const test of listed) {
  if (!testNames.includes(test)) problems.push(`登记过期：${test} 已不存在，请从 test-unregistered.json 删除`)
  else if (!orphans.includes(test)) problems.push(`登记过期：${test} 已被测试入口引用，请从 test-unregistered.json 删除`)
}

if (problems.length) {
  for (const problem of problems) console.error(problem)
  process.exit(1)
}
console.log(`测试注册检查通过：${testNames.length} 个脚本，未接入 ${listed.size} 个（live ${manifest.live?.length ?? 0}，待分拣 ${manifest.pending?.length ?? 0}）`)
