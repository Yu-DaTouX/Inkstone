#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-smooth-reveal-'))
const outfile = join(dir, 'smooth-reveal.mjs')
await build({ entryPoints: [join(ROOT, 'src/renderer/src/features/session/smooth-reveal.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
const { nextRevealLength, REVEAL_SNAP_CHARS, REVEAL_DRAIN_MS } = await import(pathToFileURL(outfile).href)
await rm(dir, { recursive: true, force: true })

let pass = 0
function check(label, fn) {
  fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

const chunk = '砚'.repeat(240)

check('小积压直接显示全文', () => {
  const text = '你好'.repeat(10)
  assert.equal(nextRevealLength(text, 0, 0), text.length)
  assert.equal(nextRevealLength(text + 'x'.repeat(REVEAL_SNAP_CHARS), 20, 16), text.length + REVEAL_SNAP_CHARS)
})

check('已追上或超出时停在全文长度', () => {
  assert.equal(nextRevealLength('abc', 3, 16), 3)
  assert.equal(nextRevealLength('abc', 9, 16), 3)
})

check('大段按帧分步显示，不一次到位', () => {
  const next = nextRevealLength(chunk, 0, 16)
  assert.ok(next > 0 && next < chunk.length, String(next))
})

check('大段在约 DRAIN_MS 的数倍内显示完', () => {
  let shown = 0
  let ms = 0
  while (shown < chunk.length && ms < REVEAL_DRAIN_MS * 4) {
    shown = nextRevealLength(chunk, shown, 16)
    ms += 16
  }
  assert.equal(shown, chunk.length)
  assert.ok(ms >= 32 && ms < REVEAL_DRAIN_MS * 4, String(ms))
})

check('不把代理对切成两半', () => {
  const text = '😀'.repeat(200)
  let shown = 0
  while (shown < text.length) {
    shown = nextRevealLength(text, shown, 16)
    const code = text.charCodeAt(shown - 1)
    assert.ok(!(code >= 0xd800 && code <= 0xdbff), `停在高位代理 @${shown}`)
  }
})

check('时间为零时至少前进一个字', () => {
  assert.equal(nextRevealLength(chunk, 10, 0), 11)
})

process.stdout.write(`smooth-reveal: ${pass} 项通过\n`)
