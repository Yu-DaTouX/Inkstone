#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { parseHTML } from 'linkedom'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-reply-appear-'))
const outfile = join(dir, 'reply-appear.mjs')
await build({ entryPoints: [join(ROOT, 'src/renderer/src/features/session/reply-appear.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error', external: ['react'] })
const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
globalThis.window = window
globalThis.document = window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { act } = React
const { useAppearDelay } = await import(pathToFileURL(outfile).href)

const seen = []
function Probe({ ids, waiting }) {
  const visible = useAppearDelay(ids, waiting, 160)
  seen.push(ids.map((id) => `${id}:${visible(id)}`).join(','))
  return null
}
const root = createRoot(document.getElementById('root'))
const render = (ids, waiting) => act(async () => root.render(React.createElement(Probe, { ids, waiting })))
const wait = (ms) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })

await render(['a'], false)
await render(['a'], true)
assert.ok(seen[seen.length - 1].endsWith('a:true'), `已显示的前言在工具出现时被隐藏: ${seen.join(' | ')}`)
await render(['a', 'b'], true)
assert.ok(seen[seen.length - 1].includes('b:false'), '新答复应先延迟')
await wait(220)
assert.ok(seen[seen.length - 1].includes('b:true'), '延迟后应显示')
await render(['a', 'b', 'c'], true)
assert.ok(seen[seen.length - 1].includes('a:true') && seen[seen.length - 1].includes('b:true'), '旧段不应再隐藏')
await render(['a', 'b', 'c'], false)
assert.ok(seen[seen.length - 1].includes('c:true'), '回合结束后全部显示')
process.stdout.write('  ✓ reply-appear\n')
await act(async () => root.unmount())
await rm(dir, { recursive: true, force: true })
