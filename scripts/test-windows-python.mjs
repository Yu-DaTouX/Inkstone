/**
 * bash 工具里的 python / python3 绕过 Windows 商店安装引导（resources/pi-extensions/windows-python.js）。
 *
 * 纯函数部分用伪文件系统覆盖：引导在前时插入真实目录与 Scripts、补 python3 转发；
 * 无真实 Python、商店真实 Python、真实 Python 已在前时不改 PATH。
 * Windows 上再用本机 Git Bash 执行一次转发脚本。
 *
 * 用法：node scripts/test-windows-python.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPythonEnvFixer, createPythonPathFixer, ensurePython3Shim, planPythonPath } from '../resources/pi-extensions/windows-python.js'

const STUB = 'C:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.29.379.0_x64__8wekyb3d8bbwe\\AppInstallerPythonRedirector.exe'
const STORE_PY = 'C:\\Program Files\\WindowsApps\\PythonSoftwareFoundation.Python.3.12_3.12.10_x64__qbz5n2kfra8p0\\python3.12.exe'
const APPS = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps'
const REAL = 'C:\\Users\\u\\AppData\\Local\\Programs\\Python\\Python311'

function fakeFs(files) {
  return {
    exists: (path) => path in files,
    readlink: (path) => files[path] ?? ''
  }
}
const stubFiles = { [join(APPS, 'python.exe')]: STUB, [join(APPS, 'python3.exe')]: STUB }
const realFiles = { [join(REAL, 'python.exe')]: '', [join(REAL, 'Scripts')]: '' }

/* 引导在前、真实 Python 在后：插到引导目录前，需要 python3 转发 */
const path = ['C:\\yan\\bin', APPS, REAL + '\\', REAL + '\\Scripts\\'].join(';')
const plan = planPythonPath(path, fakeFs({ ...stubFiles, ...realFiles, [join(REAL + '\\', 'python.exe')]: '', [join(REAL + '\\', 'Scripts')]: '' }))
assert.equal(plan.insertAt, 1)
assert.deepEqual(plan.path.split(';').slice(0, 4), ['C:\\yan\\bin', REAL + '\\', join(REAL + '\\', 'Scripts'), APPS])
assert.equal(plan.needsPython3, true)

/* 真实目录自带 python3.exe：不需要转发 */
const withPy3 = planPythonPath([APPS, REAL].join(';'), fakeFs({ ...stubFiles, ...realFiles, [join(REAL, 'python3.exe')]: '' }))
assert.equal(withPy3.needsPython3, false)

/* 不调整的情形 */
assert.equal(planPythonPath([APPS].join(';'), fakeFs(stubFiles)), null, '没有真实 Python')
assert.equal(planPythonPath([REAL, APPS].join(';'), fakeFs({ ...stubFiles, ...realFiles })), null, '真实 Python 已在前')
assert.equal(planPythonPath([APPS, REAL].join(';'), fakeFs({ [join(APPS, 'python.exe')]: STORE_PY, ...realFiles })), null, '商店里装的真实 Python 不动')
assert.equal(planPythonPath('C:\\Windows', fakeFs({})), null, '没有任何 python')

/* fixer：PATH 键大小写不定；转发目录插在引导目录前；不需要时返回原 env */
let shimCalls = 0
const fixer = createPythonPathFixer({ shimDir: 'C:\\shim', fs: fakeFs({ ...stubFiles, ...realFiles }), writeShim: (dir) => { shimCalls++; return dir } })
const env = { Path: [APPS, REAL].join(';'), OTHER: '1' }
const fixed = fixer(env)
assert.deepEqual(fixed.Path.split(';'), ['C:\\shim', REAL, join(REAL, 'Scripts'), APPS, REAL])
assert.equal(fixed.OTHER, '1')
assert.equal(fixer(env).Path, fixed.Path)
assert.equal(shimCalls, 1, '同一 PATH 只计算一次')
const untouched = { PATH: 'C:\\Windows' }
assert.equal(fixer(untouched), untouched)

/* 编码：未设置时补 PYTHONIOENCODING，已设置（任意大小写）不覆盖 */
const envFixer = createPythonEnvFixer({ fs: fakeFs({}) })
assert.equal(envFixer({ PATH: 'C:\\Windows' }).PYTHONIOENCODING, 'utf-8')
assert.equal(envFixer({ PATH: 'C:\\Windows', PythonIOEncoding: 'gbk' }).PYTHONIOENCODING, undefined)

/* 真实 Git Bash 执行转发脚本（不需要本机装 Python：转发到一个固定输出的程序） */
if (process.platform === 'win32') {
  const dir = await mkdtemp(join(tmpdir(), "yan-py-shim-it's "))
  const bash = join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe')
  ensurePython3Shim(dir, join(process.env.SystemRoot, 'System32', 'whoami.exe'))
  const before = ensurePython3Shim(dir, join(process.env.SystemRoot, 'System32', 'whoami.exe'))
  assert.equal(before, dir)
  const r = spawnSync(bash, ['-c', 'python3 /?'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir};${process.env.PATH}` } })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /WHOAMI/i, '转发到目标程序并带上参数')
  await rm(dir, { recursive: true, force: true })
}

console.log('windows-python: ok')
