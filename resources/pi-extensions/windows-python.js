import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REDIRECTOR = /AppInstallerPythonRedirector\.exe$/i

const nodeFs = {
  exists: (path) => {
    try { lstatSync(path); return true } catch { return false }
  },
  readlink: (path) => {
    try { return readlinkSync(path) } catch { return '' }
  }
}

function isRedirector(fs, file) {
  return REDIRECTOR.test(fs.readlink(file))
}

export function planPythonPath(path, fs = nodeFs) {
  const entries = path.split(';')
  const index = entries.findIndex((dir) => dir && fs.exists(join(dir, 'python.exe')))
  if (index < 0 || !isRedirector(fs, join(entries[index], 'python.exe'))) return null
  const real = entries.slice(index + 1).find((dir) => dir && fs.exists(join(dir, 'python.exe')) && !isRedirector(fs, join(dir, 'python.exe')))
  if (!real) return null
  const scripts = join(real, 'Scripts')
  const insert = [real, ...(fs.exists(scripts) ? [scripts] : [])]
  const next = [...entries.slice(0, index), ...insert, ...entries.slice(index)]
  const firstPython3 = next.find((dir) => dir && fs.exists(join(dir, 'python3.exe')))
  const needsPython3 = !firstPython3 || isRedirector(fs, join(firstPython3, 'python3.exe'))
  return { path: next.join(';'), python: join(real, 'python.exe'), insertAt: index, needsPython3 }
}

export function ensurePython3Shim(dir, python) {
  const target = python.replace(/\\/g, '/').replace(/'/g, `'\\''`)
  const content = `#!/bin/sh\nexec '${target}' "$@"\n`
  const file = join(dir, 'python3')
  mkdirSync(dir, { recursive: true })
  let current = ''
  try { current = readFileSync(file, 'utf8') } catch {}
  if (current !== content) writeFileSync(file, content, { mode: 0o755 })
  return dir
}

const PYTHON_UTF8_DEFAULTS = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }

export function createPythonEnvFixer(options) {
  const fixPath = createPythonPathFixer(options)
  return (env) => {
    const next = fixPath(env)
    const present = new Set(Object.keys(next).map((name) => name.toUpperCase()))
    const missing = Object.entries(PYTHON_UTF8_DEFAULTS).filter(([name]) => !present.has(name))
    return missing.length === 0 ? next : { ...next, ...Object.fromEntries(missing) }
  }
}

export function createPythonPathFixer({ shimDir, fs = nodeFs, writeShim = ensurePython3Shim } = {}) {
  const cache = new Map()
  return (env) => {
    const key = Object.keys(env).find((name) => name.toLowerCase() === 'path')
    if (!key || typeof env[key] !== 'string') return env
    const original = env[key]
    if (!cache.has(original)) {
      let fixed = original
      try {
        const plan = planPythonPath(original, fs)
        if (plan) {
          const entries = plan.path.split(';')
          if (plan.needsPython3 && shimDir) entries.splice(plan.insertAt, 0, writeShim(shimDir, plan.python))
          fixed = entries.join(';')
        }
      } catch {
      }
      cache.set(original, fixed)
    }
    const fixed = cache.get(original)
    return fixed === original ? env : { ...env, [key]: fixed }
  }
}
