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

const path = ['C:\\yan\\bin', APPS, REAL + '\\', REAL + '\\Scripts\\'].join(';')
const plan = planPythonPath(path, fakeFs({ ...stubFiles, ...realFiles, [join(REAL + '\\', 'python.exe')]: '', [join(REAL + '\\', 'Scripts')]: '' }))
assert.equal(plan.insertAt, 1)
assert.deepEqual(plan.path.split(';').slice(0, 4), ['C:\\yan\\bin', REAL + '\\', join(REAL + '\\', 'Scripts'), APPS])
assert.equal(plan.needsPython3, true)

const withPy3 = planPythonPath([APPS, REAL].join(';'), fakeFs({ ...stubFiles, ...realFiles, [join(REAL, 'python3.exe')]: '' }))
assert.equal(withPy3.needsPython3, false)

assert.equal(planPythonPath([APPS].join(';'), fakeFs(stubFiles)), null, '没有真实 Python')
assert.equal(planPythonPath([REAL, APPS].join(';'), fakeFs({ ...stubFiles, ...realFiles })), null, '真实 Python 已在前')
assert.equal(planPythonPath([APPS, REAL].join(';'), fakeFs({ [join(APPS, 'python.exe')]: STORE_PY, ...realFiles })), null, '商店里装的真实 Python 不动')
assert.equal(planPythonPath('C:\\Windows', fakeFs({})), null, '没有任何 python')

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

const envFixer = createPythonEnvFixer({ fs: fakeFs({}) })
assert.equal(envFixer({ PATH: 'C:\\Windows' }).PYTHONIOENCODING, 'utf-8')
assert.equal(envFixer({ PATH: 'C:\\Windows', PythonIOEncoding: 'gbk' }).PYTHONIOENCODING, undefined)
assert.equal(envFixer({ PATH: 'C:\\Windows' }).PYTHONUTF8, '1', '文件读写默认 UTF-8')
const userUtf8 = envFixer({ PATH: 'C:\\Windows', PythonUtf8: '0' })
assert.equal(userUtf8.PYTHONUTF8, undefined, '用户已设置 PYTHONUTF8 时不覆盖')
assert.equal(userUtf8.PythonUtf8, '0')
assert.equal(userUtf8.PYTHONIOENCODING, 'utf-8')
const preset = { PATH: 'C:\\Windows', PYTHONIOENCODING: 'gbk', PYTHONUTF8: '0' }
assert.equal(envFixer(preset), preset, '都已设置时原样返回')

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
