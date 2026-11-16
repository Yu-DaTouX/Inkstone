import fs, { realpathSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD_FLAG = Symbol.for('inkstone.testRealDataGuard')

const APP_DATA_NAMES = ['yan-desktop', '砚', 'Inkstone']

const WRITE_PATH_ARGS = {
  writeFile: [0], appendFile: [0], mkdir: [0], rmdir: [0], rm: [0], unlink: [0], truncate: [0],
  chmod: [0], chown: [0], lchown: [0], lchmod: [0], utimes: [0], lutimes: [0], mkdtemp: [0],
  createWriteStream: [0], symlink: [1], link: [1], copyFile: [1], cp: [1], rename: [0, 1]
}

const WRITE_FLAG_BITS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC

function stripWindowsPrefix(path) {
  return path.replace(/^\\\\[?.]\\UNC\\/i, '\\\\').replace(/^\\\\[?.]\\/, '')
}

function normalize(path) {
  const absolute = resolve(stripWindowsPrefix(path))
  let head = absolute
  const tail = []
  for (;;) {
    try {
      head = realpathSync.native(head)
      break
    } catch {
      const parent = dirname(head)
      if (parent === head) break
      tail.unshift(basename(head))
      head = parent
    }
  }
  const real = tail.length ? join(head, ...tail) : head
  return process.platform === 'win32' ? real.toLowerCase() : real
}

function protectedRoots() {
  const candidates = [join(homedir(), '.pi', 'agent')]
  if (process.platform === 'win32') {
    const bases = new Set([join(homedir(), 'AppData', 'Roaming')])
    if (process.env.APPDATA?.trim()) bases.add(process.env.APPDATA.trim())
    for (const base of bases) for (const name of APP_DATA_NAMES) candidates.push(join(base, name))
  }
  return [...new Set(candidates.map(normalize))]
}

function pathOf(value) {
  if (typeof value === 'string') return value
  if (value instanceof URL) return value.protocol === 'file:' ? fileURLToPath(value) : null
  if (Buffer.isBuffer(value)) return value.toString()
  return null
}

function writesByFlags(flags) {
  if (flags === undefined || flags === null) return false
  if (typeof flags === 'number') return (flags & WRITE_FLAG_BITS) !== 0
  return /[wa+]/.test(String(flags))
}

export function realDataGuardMessage(path) {
  return `测试进程禁止写入用户真实数据目录：${path}。请在测试开头 import './lib/test-isolate.mjs'，或让数据目录走 YAN_* 环境变量指向临时目录。`
}

export function installRealDataGuard() {
  if (fs[GUARD_FLAG]) return
  const roots = protectedRoots()
  const violation = (value) => {
    const text = pathOf(value)
    if (text === null) return null
    const target = normalize(text)
    for (const root of roots) {
      const rel = relative(root, target)
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return text
    }
    return null
  }
  const fail = (path) => Object.assign(new Error(realDataGuardMessage(path)), { code: 'EINKSTONE_TEST_REAL_DATA' })
  const wrap = (target, name, check, promise) => {
    const original = target[name]
    if (typeof original !== 'function') return
    target[name] = function guarded(...args) {
      const bad = check(args)
      if (bad) {
        const error = fail(bad)
        if (promise) return Promise.reject(error)
        throw error
      }
      return original.apply(this, args)
    }
  }
  const byIndexes = (indexes) => (args) => {
    for (const index of indexes) {
      const bad = violation(args[index])
      if (bad) return bad
    }
    return null
  }
  const byFlags = (args) => {
    const flags = typeof args[1] === 'function' ? undefined : args[1]
    return writesByFlags(flags) ? violation(args[0]) : null
  }
  for (const [name, indexes] of Object.entries(WRITE_PATH_ARGS)) {
    wrap(fs, name, byIndexes(indexes), false)
    wrap(fs, `${name}Sync`, byIndexes(indexes), false)
    wrap(fs.promises, name, byIndexes(indexes), true)
  }
  wrap(fs, 'open', byFlags, false)
  wrap(fs, 'openSync', byFlags, false)
  wrap(fs.promises, 'open', byFlags, true)
  Object.defineProperty(fs, GUARD_FLAG, { value: true })
  syncBuiltinESMExports()
}
