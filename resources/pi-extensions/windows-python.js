/**
 * Windows 上 bash 工具里的 `python` / `python3` 指向真正安装的 Python（由 shell-fallback.js 接入）。
 *
 * Windows 自带的「应用执行别名」在 `...\Microsoft\WindowsApps` 放了 python.exe / python3.exe，
 * 它们只是商店安装引导（链接到 AppInstallerPythonRedirector.exe）：打印「Python was not found」
 * 且退出码为 0。这个目录常排在用户安装的 Python 之前，模型调用 `python` 便得到误导性结果，
 * 而官方安装包本身没有 python3.exe，`python3` 总是落到引导程序上。
 *
 * 只在 PATH 上第一个 python.exe 是安装引导、且后面有真正的 Python 时调整：把它所在目录
 * （及其 Scripts）插到引导目录前面，并在缺 python3 时放一个转发脚本。其余情况不改 PATH。
 * 另在未设置时加 `PYTHONIOENCODING=utf-8`：Python 输出到管道时按系统 ANSI 编码（中文系统为 GBK），
 * 不认控制台代码页；只管标准输入输出，不改 open() 的默认编码。
 * 只影响 bash 工具执行的命令，不改系统设置。
 */

import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REDIRECTOR = /AppInstallerPythonRedirector\.exe$/i

const nodeFs = {
  /* 引导程序是指向受保护目录的链接，existsSync 跟随链接会因 EACCES 得到 false，只看链接本身 */
  exists: (path) => {
    try { lstatSync(path); return true } catch { return false }
  },
  readlink: (path) => {
    try { return readlinkSync(path) } catch { return '' }
  }
}

/** 某目录下的 exe 是否为商店安装引导。 */
function isRedirector(fs, file) {
  return REDIRECTOR.test(fs.readlink(file))
}

/**
 * 计算调整后的 PATH。返回 `{ path, python, needsPython3 }`；不需要调整时返回 null。
 * `path` 为 `;` 分隔的 PATH 原值。
 */
export function planPythonPath(path, fs = nodeFs) {
  const entries = path.split(';')
  const index = entries.findIndex((dir) => dir && fs.exists(join(dir, 'python.exe')))
  if (index < 0 || !isRedirector(fs, join(entries[index], 'python.exe'))) return null
  const real = entries.slice(index + 1).find((dir) => dir && fs.exists(join(dir, 'python.exe')) && !isRedirector(fs, join(dir, 'python.exe')))
  if (!real) return null
  const scripts = join(real, 'Scripts')
  const insert = [real, ...(fs.exists(scripts) ? [scripts] : [])]
  const next = [...entries.slice(0, index), ...insert, ...entries.slice(index)]
  /* 调整后排在前面的目录里若仍没有真正的 python3.exe，就需要转发脚本 */
  const firstPython3 = next.find((dir) => dir && fs.exists(join(dir, 'python3.exe')))
  const needsPython3 = !firstPython3 || isRedirector(fs, join(firstPython3, 'python3.exe'))
  return { path: next.join(';'), python: join(real, 'python.exe'), insertAt: index, needsPython3 }
}

/** 写 bash 可执行的 python3 转发脚本（内容不变就不重写），返回所在目录。 */
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

/**
 * 返回调整 Python 相关环境变量的函数（PATH 按原值缓存）；用于 bash 工具的 spawnHook。
 * env 的键在 Windows 上大小写不定，按不区分大小写查找。
 */
export function createPythonEnvFixer(options) {
  const fixPath = createPythonPathFixer(options)
  return (env) => {
    const next = fixPath(env)
    if (Object.keys(next).some((name) => name.toUpperCase() === 'PYTHONIOENCODING')) return next
    return { ...next, PYTHONIOENCODING: 'utf-8' }
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
        /* 判断失败就沿用原 PATH */
      }
      cache.set(original, fixed)
    }
    const fixed = cache.get(original)
    return fixed === original ? env : { ...env, [key]: fixed }
  }
}
