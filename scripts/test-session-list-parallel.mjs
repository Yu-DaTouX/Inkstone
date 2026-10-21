#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'yan-list-parallel-'))
const sessionsDir = join(root, 'sessions')
const projectDir = join(sessionsDir, '-E-fake-project-')
const TMP_OUT = join(root, 'bundles')

for (const dir of [sessionsDir, projectDir, TMP_OUT, join(root, 'data'), join(root, 'pi')]) {
  await mkdir(dir, { recursive: true })
}
process.env.YAN_DATA_DIR = join(root, 'data')
process.env.YAN_PI_DIR = join(root, 'pi')
process.env.YAN_SESSIONS_DIR = sessionsDir

const FS_STUB = 'fs-stub'
const STUB_SOURCE = `
export * from 'node:fs/promises'
import * as real from 'node:fs/promises'

const probe = globalThis.__fsProbe ?? (globalThis.__fsProbe = { inFlight: 0, peak: 0, delayMs: 0 })
const deny = () => globalThis.__fsDeny ?? []

export async function open(path, flags) {
  const target = String(path)
  if (deny().some((part) => target.includes(part))) {
    const error = new Error('EACCES: permission denied, open ' + target)
    error.code = 'EACCES'
    throw error
  }
  const fh = await real.open(path, flags)
  const wrapped = Object.create(fh)
  wrapped.read = async (...args) => {
    probe.inFlight += 1
    if (probe.inFlight > probe.peak) probe.peak = probe.inFlight
    try {
      if (probe.delayMs) await new Promise((done) => setTimeout(done, probe.delayMs))
      return await fh.read(...args)
    } finally {
      probe.inFlight -= 1
    }
  }
  wrapped.close = () => fh.close()
  wrapped.stat = (...args) => fh.stat(...args)
  return wrapped
}
`

const stubPlugin = {
  name: 'fs-stub',
  setup(b) {
    b.onResolve({ filter: /^node:fs\/promises$/ }, (args) => {
      if (args.importer === FS_STUB) return { path: 'node:fs/promises', external: true }
      return { path: FS_STUB, namespace: 'stub' }
    })
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: STUB_SOURCE,
      loader: 'js',
      resolveDir: ROOT
    }))
  }
}

async function bundle(name, plugins) {
  const outfile = join(TMP_OUT, `${name}.mjs`)
  await build({
    entryPoints: [join(ROOT, 'src/main/sessions.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    plugins,
    logLevel: 'error'
  })
  return import(pathToFileURL(outfile).href)
}

const plain = await bundle('sessions-plain', [])
const probed = await bundle('sessions-probed', [stubPlugin])

let pass = 0
async function check(label, fn) {
  await fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

const BASE = Date.UTC(2025, 0, 1)
const created = []

function sessionText({ id, cwd = 'E:\\fake', ts, name, parentSession, messages }) {
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      cwd,
      timestamp: new Date(ts).toISOString(),
      ...(parentSession ? { parentSession } : {})
    })
  ]
  if (name) lines.push(JSON.stringify({ type: 'session_info', name }))
  for (const [i, m] of messages.entries()) {
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `${id}-${i}`,
        timestamp: new Date(ts + (i + 1) * 1000).toISOString(),
        message: { role: m.role, content: m.text, timestamp: ts + (i + 1) * 1000 }
      })
    )
  }
  return lines.join('\n') + '\n'
}

async function writeSession(file, spec) {
  const path = join(projectDir, file)
  await writeFile(path, spec.text)
  await utimes(path, new Date(spec.ts), new Date(spec.ts))
  created.push({ file, ts: spec.ts, spec })
  return path
}

async function seed(count, prefix) {
  created.length = 0
  for (const name of await listDir()) await rm(join(projectDir, name), { force: true })
  for (let i = 0; i < count; i++) {
    const ts = BASE + i * 60_000
    const id = `${prefix}-${i}`
    await writeSession(`${prefix}-${String(i).padStart(3, '0')}.jsonl`, {
      ts,
      text: sessionText({
        id,
        ts,
        messages: [
          { role: 'user', text: `第 ${i} 条用户消息` },
          { role: 'assistant', text: `第 ${i} 条回复` },
          { role: 'user', text: `第 ${i} 条追问` }
        ]
      })
    })
  }
}

async function listDir() {
  const { readdir } = await import('node:fs/promises')
  try {
    return await readdir(projectDir)
  } catch {
    return []
  }
}

function resetProbe(delayMs) {
  globalThis.__fsProbe ??= { inFlight: 0, peak: 0, delayMs: 0 }
  globalThis.__fsProbe.inFlight = 0
  globalThis.__fsProbe.peak = 0
  globalThis.__fsProbe.delayMs = delayMs
  globalThis.__fsDeny = []
  return globalThis.__fsProbe
}

try {
  await seed(40, 's')

  await check('40 个会话全部返回，按 mtime 降序且保持顺序', async () => {
    const list = await plain.listSessions(500)
    assert.equal(list.length, 40)
    const names = list.map((item) => item.path.split(/[\\/]/).pop())
    const expected = [...created].sort((a, b) => b.ts - a.ts).map((item) => item.file)
    assert.deepEqual(names, expected)
    assert.deepEqual(list.map((item) => item.updatedAt), [...list].map((item) => item.updatedAt).sort((a, b) => b - a))
  })

  await check('title 取首条用户消息，lastReply 取尾部 assistant', async () => {
    const list = await plain.listSessions(500)
    const newest = list[0]
    assert.equal(newest.title, '第 39 条用户消息')
    assert.equal(newest.lastReply?.text, '第 39 条回复')
    assert.equal(newest.messageCount, 3)
    assert.equal(newest.cwd, 'E:\\fake')
  })

  await check('limit 只取最新的 N 条', async () => {
    const list = await plain.listSessions(5)
    assert.equal(list.length, 5)
    assert.equal(list[0].title, '第 39 条用户消息')
    assert.equal(list[4].title, '第 35 条用户消息')
  })

  await check('缓存命中返回同一 summary 对象', async () => {
    const first = await plain.listSessions(500)
    const second = await plain.listSessions(500)
    assert.equal(first.length, second.length)
    for (let i = 0; i < first.length; i++) assert.equal(second[i], first[i])
  })

  await check('mtime 变化后重建该条 summary，其余仍复用缓存', async () => {
    const before = await plain.listSessions(500)
    const target = join(projectDir, created[10].file)
    const spec = created[10].spec
    await writeFile(target, sessionText({ id: 's-touched', ts: spec.ts + 5_000, messages: [{ role: 'user', text: '改过的标题' }] }))
    await utimes(target, new Date(spec.ts + 5_000), new Date(spec.ts + 5_000))
    const after = await plain.listSessions(500)
    const touched = after.find((item) => item.path === target)
    assert.equal(touched.title, '改过的标题')
    assert.equal(touched.messageCount, 1)
    assert.notEqual(touched, before.find((item) => item.path === target))
    const untouchedBefore = before.find((item) => item.path.endsWith(created[20].file))
    const untouchedAfter = after.find((item) => item.path.endsWith(created[20].file))
    assert.equal(untouchedAfter, untouchedBefore)
  })

  await check('文件消失后不再出现在列表', async () => {
    const target = join(projectDir, created[3].file)
    await rm(target, { force: true })
    const list = await plain.listSessions(500)
    assert.equal(list.length, 39)
    assert.ok(!list.some((item) => item.path === target))
  })

  await check('0 字节与二进制垃圾文件不抛错且不影响其他条目', async () => {
    await writeFile(join(projectDir, 'zz-empty.jsonl'), '')
    await writeFile(join(projectDir, 'zz-garbage.jsonl'), Buffer.from([0, 255, 254, 10, 0, 1, 2]))
    await writeFile(join(projectDir, 'zz-oneline.jsonl'), JSON.stringify({ type: 'session', id: 'one' }) + 'x'.repeat(400_000))
    const list = await plain.listSessions(500)
    assert.equal(list.length, 42)
    assert.equal(list.filter((item) => item.title === '(无标题)').length, 3)
  })

  await check('named 会话用 session_info 名称作标题', async () => {
    const ts = BASE + 10 * 60_000
    await writeSession('named.jsonl', {
      ts,
      text: sessionText({ id: 'named', ts, name: '手工命名', messages: [{ role: 'user', text: '原始标题' }] })
    })
    const list = await plain.listSessions(500)
    const named = list.find((item) => item.id === 'named')
    assert.equal(named.title, '手工命名')
    assert.equal(named.named, true)
  })

  await check('分支会话带 branchOrigin', async () => {
    const parentTs = BASE + 20 * 60_000
    await writeSession('branch-parent.jsonl', {
      ts: parentTs,
      text: sessionText({ id: 'branch-parent', ts: parentTs, messages: [{ role: 'user', text: '父会话标题' }] })
    })
    const childTs = parentTs + 120_000
    const childText = [
      JSON.stringify({ type: 'session', version: 3, id: 'branch-child', cwd: 'E:\\fake', timestamp: new Date(childTs).toISOString(), parentSession: 'branch-parent' }),
      JSON.stringify({ type: 'message', id: 'm0', timestamp: new Date(parentTs).toISOString(), message: { role: 'user', content: '分支起点标题' } }),
      JSON.stringify({ type: 'message', id: 'm1', timestamp: new Date(parentTs + 1000).toISOString(), message: { role: 'assistant', content: '分支起点回复' } }),
      JSON.stringify({ type: 'message', id: 'm2', timestamp: new Date(childTs).toISOString(), message: { role: 'user', content: '子会话标题' } })
    ].join('\n') + '\n'
    const childPath = join(projectDir, 'branch-child.jsonl')
    await writeFile(childPath, childText)
    await utimes(childPath, new Date(childTs), new Date(childTs))
    created.push({ file: 'branch-child.jsonl', ts: childTs, spec: { ts: childTs, text: childText } })
    const list = await plain.listSessions(500)
    const child = list.find((item) => item.id === 'branch-child')
    assert.equal(child.parentSession, 'branch-parent')
    assert.equal(child.branchOrigin, '分支起点标题')
  })

  await check('并发池确实并行且不超过 8', async () => {
    await seed(24, 'p')
    const probe = resetProbe(3)
    const list = await probed.listSessions(500)
    assert.equal(list.length, 24)
    assert.ok(probe.peak >= 2, `peak=${probe.peak} 说明仍是串行`)
    assert.ok(probe.peak <= 8, `peak=${probe.peak} 超过并发上限`)
  })

  await check('单个文件打开失败只跳过该条，其余顺序不变', async () => {
    await seed(12, 'd')
    resetProbe(0)
    globalThis.__fsDeny = ['d-003.jsonl', 'd-007.jsonl']
    const list = await probed.listSessions(500)
    const expected = [...created]
      .sort((a, b) => b.ts - a.ts)
      .map((item) => item.file)
      .filter((file) => !file.includes('d-003') && !file.includes('d-007'))
    assert.equal(list.length, 10)
    assert.deepEqual(list.map((item) => item.path.split(/[\\/]/).pop()), expected)
  })
} finally {
  await rm(root, { recursive: true, force: true })
}

process.stdout.write(`\n${pass} passed\n`)
