import './test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

export const CJS_REQUIRE_BANNER = "import { createRequire as __inkstoneCreateRequire } from 'node:module'; const require = __inkstoneCreateRequire(import.meta.url);"

export function buildTest(entry, outfile, options = {}) {
  const banner = { ...options.banner, js: `${CJS_REQUIRE_BANNER}${options.banner?.js ?? ''}` }
  return build({ ...(options.stdin ? {} : { entryPoints: [entry] }), outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', ...options, banner })
}

export async function runSuite(url, run) {
  if (!process.argv[1] || pathToFileURL(resolve(process.argv[1])).href !== url) return
  let checks = 0
  const dirs = []
  const ok = (condition, label, detail = '') => {
    assert.ok(condition, detail ? `${label}: ${detail}` : label)
    checks++
    console.log(`  ✓ ${label}`)
  }
  const compile = async (entry, options) => {
    const dir = await mkdtemp(resolve('node_modules/.inkstone-test-build-'))
    dirs.push(dir)
    const outfile = join(dir, 'module.mjs')
    await buildTest(entry, outfile, options)
    return import(pathToFileURL(outfile).href)
  }
  try {
    await run(ok, compile)
    assert.ok(checks > 0, '没有执行任何断言')
    console.log(`${checks}/${checks} 通过`)
  } finally {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  }
}
