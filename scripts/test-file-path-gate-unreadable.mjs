import './lib/test-isolate.mjs'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const GATE = 'src/main/file-path-gate.ts'
const ADDED = [
  "    const code = (error as NodeJS.ErrnoException | undefined)?.code\n",
  "    if (code === 'EPERM' || code === 'EACCES') return { ok: false, reason: 'unreadable', root: rootReal, lexical }\n"
]

function deny(path, kind) {
  if (process.platform === 'win32') {
    return spawnSync('icacls', [path, '/deny', `${process.env.USERNAME}:(${kind === 'dir' ? 'RD' : 'R'})`], { encoding: 'utf8' }).status === 0
  }
  try { chmodSync(path, 0); return true } catch { return false }
}

function allow(path) {
  if (process.platform === 'win32') spawnSync('icacls', [path, '/remove:d', process.env.USERNAME], { encoding: 'utf8' })
  else try { chmodSync(path, 0o755) } catch {}
}

function readable(path) {
  try { readFileSync(path); return true } catch { return false }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const source = readFileSync(GATE, 'utf8')
  ok(ADDED.every((line) => source.includes(line)), '守卫里只新增了按错误码分出「没权限」的两行')
  const previous = ADDED.reduce((text, line) => text.replace(line, ''), source).replace(" | 'unreadable'", '').replace('} catch (error) {\n    if (!isWithin(rootReal, lexical))', '} catch {\n    if (!isWithin(rootReal, lexical))')
  ok(previous !== source && !previous.includes("'unreadable'"), '能还原出改前的守卫源码')
  const now = await compile(GATE, { platform: 'node' })
  const before = await compile(null, { platform: 'node', stdin: { contents: previous, resolveDir: resolve('src/main'), loader: 'ts', sourcefile: 'file-path-gate-before.ts' } })

  const base = mkdtempSync(join(tmpdir(), 'inkstone-gate-'))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'locked-dir'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'a')
  writeFileSync(join(root, 'locked.txt'), 'x')
  writeFileSync(join(root, 'locked-dir', 'inner.txt'), 'y')
  writeFileSync(join(outside, 'b.ts'), 'b')
  const lockedFile = deny(join(root, 'locked.txt'), 'file')
  const lockedDir = deny(join(root, 'locked-dir'), 'dir')
  try {
    const cases = [
      ['src/a.ts', {}],
      ['src', {}],
      ['src/missing.ts', {}],
      ['missing-dir/x.ts', {}],
      ['../outside/b.ts', {}],
      ['src/../../outside/b.ts', {}],
      ['C:/Windows/win.ini', {}],
      ['bad\0name', {}],
      [join(root, 'src', 'a.ts'), {}],
      [join(root, 'src', 'a.ts'), { allowAbsolute: true }],
      [join(outside, 'b.ts'), { allowAbsolute: true }],
      [join(outside, 'missing.ts'), { allowAbsolute: true }],
      ['locked.txt', {}],
      ['locked-dir/inner.txt', {}],
      ['locked-dir', {}],
      [join(root, 'locked.txt'), { allowAbsolute: true }],
      ['\\\\server\\share\\a.txt', {}],
      ['\\\\server\\share\\a.txt', { allowAbsolute: true }],
      ['//server/share/a.txt', { allowAbsolute: true }],
      ['\\\\?\\UNC\\server\\share\\a.txt', { allowAbsolute: true }]
    ]
    for (const [target, options] of cases) {
      const a = await before.scopedPath(root, target, options)
      const b = await now.scopedPath(root, target, options)
      const label = JSON.stringify(target.replace(base, '<tmp>')) + (options.allowAbsolute ? '（允许绝对路径）' : '')
      ok(a.ok === b.ok && a.real === b.real && a.root === b.root && a.lexical === b.lexical, `放行结果与改前一致：${label}`, JSON.stringify({ before: a, now: b }))
      if (!a.ok && a.reason !== 'missing') ok(a.reason === b.reason, `非「不存在」类的拦截原因不变：${label}`, `${a.reason} → ${b.reason}`)
      if (!a.ok && a.reason === 'missing') ok(b.reason === 'missing' || b.reason === 'unreadable', `原来报「不存在」的只可能细分成「没权限」：${label}`, b.reason)
    }
    for (const target of ['\\\\server\\share\\a.txt', '//server/share/a.txt']) {
      const blocked = await now.scopedPath(root, target, { allowAbsolute: true })
      ok(blocked.ok === false && blocked.reason === 'invalid', `网络路径仍被拦截：${target}`, JSON.stringify(blocked))
    }
    const missing = await now.scopedPath(root, 'src/missing.ts')
    ok(missing.reason === 'missing' && missing.creatable === true, '真的不存在仍报 missing，creatable 照旧')
    const rootGone = await now.scopedPath(join(base, 'no-root'), 'a.ts')
    ok(rootGone.reason === 'root_missing', '根目录不存在仍报 root_missing')
    if (lockedFile && !readable(join(root, 'locked.txt'))) {
      const locked = await now.scopedPath(root, 'locked.txt')
      ok(locked.ok === false && locked.reason === 'unreadable', '没有读权限的文件报 unreadable，不再说不存在', JSON.stringify(locked))
    } else console.log('  - 跳过：当前环境造不出读不了的文件（提升的权限会绕过拒绝访问）')
    if (process.platform === 'win32' || lockedDir) console.log(`  · 目录去掉列目录权限：${lockedDir ? '已设置' : '未设置'}`)
  } finally {
    allow(join(root, 'locked.txt'))
    allow(join(root, 'locked-dir'))
    rmSync(base, { recursive: true, force: true })
  }
})
