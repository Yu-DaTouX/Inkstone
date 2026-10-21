#!/usr/bin/env node
// 动态导入失效时的自动恢复：判定 + 限频（vite:preloadError）
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = new URL('..', import.meta.url)
const dir = await mkdtemp(join(tmpdir(), 'yan-preload-recovery-'))
const outfile = join(dir, 'preload-recovery.mjs')

await build({
  entryPoints: [new URL('src/renderer/src/lib/preload-recovery.ts', ROOT).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  outfile,
  logLevel: 'error'
})

const mod = await import(pathToFileURL(outfile).href)

let pass = 0
let fail = 0
function ok(cond, label, detail) {
  if (cond) {
    pass++
    console.log(`  [ok] ${label}`)
  } else {
    fail++
    console.log(`  [x] ${label}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
  }
}

console.log('## 判定：只有「chunk 不在了」才算可恢复')
{
  ok(mod.isStaleChunkError('Failed to fetch dynamically imported module: file:///E:/x/assets/index-BB7f-gK2.js'), 'Chrome 的旧 chunk 报错', null)
  ok(mod.isStaleChunkError('error loading dynamically imported module'), 'Firefox', null)
  ok(mod.isStaleChunkError('Importing a module script failed.'), 'Safari', null)
  ok(mod.isStaleChunkError('Unable to preload CSS for /assets/x.css'), 'CSS 预加载失败', null)
  ok(!mod.isStaleChunkError('Cannot read properties of undefined (reading \'map\')'), '普通渲染异常不算', null)
  ok(!mod.isStaleChunkError(''), '空消息不算', null)
}

console.log('## 限频：自动重载一次，短时间内不反复刷新')
{
  let now = 1_000_000
  const store = new Map()
  let reloads = 0
  const deps = {
    onPreloadError: (handler) => {
      deps._handler = handler
    },
    reload: () => {
      reloads++
    },
    now: () => now,
    read: (key) => store.get(key) ?? null,
    write: (key, value) => store.set(key, value)
  }
  mod.installPreloadRecovery(deps)
  ok(typeof deps._handler === 'function', '注册了 preloadError 处理器', null)

  deps._handler()
  ok(reloads === 1, '第一次失配自动重载', reloads)
  ok(store.get(mod.PRELOAD_RELOAD_KEY) === String(now), '记下重载时刻', store.get(mod.PRELOAD_RELOAD_KEY))

  now += 1000
  deps._handler()
  ok(reloads === 1, '同一分钟内的第二次失配不再重载（避免死循环）', reloads)

  now += mod.PRELOAD_RELOAD_MIN_INTERVAL_MS
  deps._handler()
  ok(reloads === 2, '超过间隔后允许再重载', reloads)
}

console.log('## 边界：sessionStorage 不可用时不崩')
{
  let reloads = 0
  const deps = {
    onPreloadError: (handler) => {
      deps._handler = handler
    },
    reload: () => {
      reloads++
    },
    now: () => 1,
    read: () => null,
    write: () => {
      throw new Error('存储不可用')
    }
  }
  let threw = false
  try {
    mod.installPreloadRecovery(deps)
    deps._handler()
  } catch {
    threw = true
  }
  ok(!threw, '写入失败不抛异常')
  ok(reloads === 1, '写入失败时仍然重载（宁可多刷一次，也不停在错误页）', reloads)
}

await rm(dir, { recursive: true, force: true })
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
