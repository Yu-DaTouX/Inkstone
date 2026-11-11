#!/usr/bin/env node
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { runSuite } from './lib/test-suite.mjs'

const FS_STUB = `
const real = process.getBuiltinModule('fs')
const counters = (globalThis.__qlogFs ??= { stat: 0, read: 0, copy: 0, failCode: null })
const guard = () => {
  if (counters.failCode) {
    const error = new Error('stub ' + counters.failCode)
    error.code = counters.failCode
    throw error
  }
}
export const existsSync = (...a) => real.existsSync(...a)
export const mkdirSync = (...a) => real.mkdirSync(...a)
export const renameSync = (...a) => real.renameSync(...a)
export const writeFileSync = (...a) => real.writeFileSync(...a)
export const rmSync = (...a) => real.rmSync(...a)
export const statSync = (...a) => { counters.stat++; guard(); return real.statSync(...a) }
export const readFileSync = (...a) => { counters.read++; guard(); return real.readFileSync(...a) }
export const copyFileSync = (...a) => { counters.copy++; return real.copyFileSync(...a) }
`

await runSuite(import.meta.url, async (ok, compile) => {
  const { QuestionLogStore } = await compile('src/main/question-log.ts', {
    external: ['electron'],
    plugins: [{
      name: 'fs-stub',
      setup(b) {
        b.onResolve({ filter: /^node:fs$/ }, () => ({ path: 'fs', namespace: 'fs-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'fs-stub' }, () => ({ contents: FS_STUB, loader: 'js' }))
      }
    }]
  })
  const counters = (globalThis.__qlogFs ??= { stat: 0, read: 0, copy: 0, failCode: null })
  const dir = mkdtempSync(join(tmpdir(), 'yan-qlog-iso-'))
  const file = join(dir, 'question-log.json')
  const store = new QuestionLogStore(() => file)
  const backups = () => readdirSync(dir).filter((name) => name.includes('.corrupt-'))
  const entry = (question) => ({ question, options: [], answer: 'a', cancelled: false, at: Date.now() })

  try {
    writeFileSync(file, '{ not json', 'utf8')
    for (let i = 0; i < 5; i++) store.list('session-a')
    ok(backups().length === 1 && counters.copy === 1, '损坏文件连续多次 list 只备份一次', `${backups().length}/${counters.copy}`)
    ok(readFileSync(file, 'utf8') === '{ not json', '损坏原文件保留')

    const appended = store.append('session-a', entry('q1'))
    ok(appended?.length === 1 && store.list('session-a').length === 1, '损坏后 append 自愈并写入新记录')
    ok(backups().length === 1, '自愈写入不再产生新备份')

    store.list('session-a')
    const readsBefore = counters.read
    for (let i = 0; i < 5; i++) store.list('session-a')
    ok(counters.read === readsBefore, '文件未变化时 list 走 stat 缓存，不重复读盘')

    writeFileSync(file, '{ other broken text', 'utf8')
    store.list('session-a')
    ok(backups().length === 2, '内容变化的新损坏文件会各备份一次', String(backups().length))

    writeFileSync(file, JSON.stringify({ version: 1, sessions: { 'session-b': [{ question: 'x', at: 1 }] } }), 'utf8')
    ok(store.list('session-b').length === 1, '外部改写后缓存失效并读到新内容')

    counters.failCode = 'EBUSY'
    let threw = false
    let result
    try {
      result = store.append('session-b', entry('q2'))
    } catch {
      threw = true
    }
    ok(!threw && result === null, '读盘 EBUSY 时 append 不抛，返回 null 表示未保存')
    let listed
    try {
      listed = store.list('session-b')
    } catch {
      listed = 'threw'
    }
    ok(Array.isArray(listed) && listed.length === 0, '读盘 EBUSY 时 list 降级为空表，不抛')
    counters.failCode = 'EPERM'
    ok(store.append('session-b', entry('q3')) === null, '读盘 EPERM 同样降级')
    counters.failCode = null

    const recovered = store.append('session-b', entry('q4'))
    ok(recovered?.length === 2 && recovered[1].question === 'q4', '故障解除后正常追加，原记录未丢')
  } finally {
    counters.failCode = null
    rmSync(dir, { recursive: true, force: true })
  }
})
