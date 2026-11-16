import './lib/test-isolate.mjs'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, relative, resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'
import { cleanEnv } from '../debug/lib/env.mjs'
import { createIsolatedHome, isolatedHomeEnv, pathKey } from '../debug/lib/isolated-home.mjs'
import { sandboxEnv } from '../debug/lib/sandbox.mjs'
import { demoEnv } from '../debug/lib/demo.mjs'

const realHomes = [homedir(), process.env.USERPROFILE, process.env.HOME].filter(Boolean).map((dir) => resolve(dir).toLowerCase())
const inside = (path, root) => { const rel = relative(resolve(root).toLowerCase(), resolve(path).toLowerCase()); return rel === '' || (!rel.startsWith('..') && !rel.includes(':')) }
const outsideRealHome = (path, home) => realHomes.every((real) => !inside(path, real) || inside(path, home))

await runSuite(import.meta.url, async (ok) => {
  const root = mkdtempSync(join(tmpdir(), 'inkstone-debug-home-'))
  const saved = { path: process.env[pathKey()], devices: process.env.YAN_DEBUG_REAL_DEVICES }
  try {
    const home = join(root, 'home')
    const adbDir = join(root, 'platform-tools')
    mkdirSync(adbDir, { recursive: true })
    writeFileSync(join(adbDir, process.platform === 'win32' ? 'adb.exe' : 'adb'), '')
    process.env[pathKey()] = [adbDir, saved.path].join(delimiter)
    delete process.env.YAN_DEBUG_REAL_DEVICES

    const layout = createIsolatedHome(home)
    const homeEnv = isolatedHomeEnv(home)
    for (const key of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR', 'HERMES_HOME', 'GRADLE_USER_HOME', 'ANDROID_USER_HOME', 'ANDROID_AVD_HOME', 'GIT_CONFIG_GLOBAL', 'SSH_AUTH_SOCK']) {
      ok(homeEnv[key] && inside(homeEnv[key], home), `${key} 在隔离主目录内`, homeEnv[key])
    }
    if (process.platform === 'win32') ok(resolve(homeEnv.HOMEDRIVE + homeEnv.HOMEPATH) === resolve(home), 'HOMEDRIVE+HOMEPATH 指向隔离主目录')
    ok(/-F none/.test(homeEnv.GIT_SSH_COMMAND) && /IdentityAgent=none/.test(homeEnv.GIT_SSH_COMMAND) && homeEnv.GIT_SSH_COMMAND.includes(home.replaceAll('\\', '/')), 'git 的 ssh 不读真实 ~/.ssh 与代理')

    const box = { piDir: join(root, 'pi'), dataDir: join(root, 'yan'), userData: join(root, 'electron'), downloads: join(root, 'downloads'), androidSdk: join(root, 'sdk'), runDir: root, home }
    const env = cleanEnv(sandboxEnv(box, { fake: true }))
    const keys = Object.keys(env).map((key) => key.toUpperCase())
    ok(keys.length === new Set(keys).size, '子进程环境变量没有大小写重复的键')
    for (const key of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR']) ok(env[key] === homeEnv[key], `sandboxEnv 设置 ${key}`)
    const childPath = env[Object.keys(env).find((key) => key.toUpperCase() === 'PATH')]
    ok(!childPath.split(delimiter).includes(adbDir), 'PATH 去掉含 adb 的目录')
    const demoPath = Object.entries(cleanEnv({ ...sandboxEnv(box), ...demoEnv({ ...box, demo: { dir: join(root, 'demo'), stateFile: join(root, 'gh.json') } }) })).filter(([key]) => key.toUpperCase() === 'PATH')
    ok(demoPath.length === 1 && !demoPath[0][1].split(delimiter).includes(adbDir), '--demo 的 PATH 同样去掉 adb 且只有一个 PATH 键')

    const probe = join(root, 'probe.mjs')
    writeFileSync(probe, [
      "import { homedir } from 'node:os'",
      "import { join } from 'node:path'",
      "const home = homedir()",
      "console.log(JSON.stringify({ home, piHome: process.env.HOME || home, agentsSkills: join(process.env.HOME || home, '.agents', 'skills'), codex: process.env.CODEX_HOME || join(home, '.codex'), claude: process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), hermes: process.env.HERMES_HOME || join(home, '.hermes'), npmPrefix: join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm'), chrome: join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data') }))"
    ].join('\n'))
    const child = spawnSync(process.execPath, [probe], { env, encoding: 'utf8', windowsHide: true })
    ok(child.status === 0, '子进程探针运行', child.stderr)
    const seen = JSON.parse(child.stdout)
    ok(resolve(seen.home) === resolve(home), '子进程 os.homedir() 是隔离主目录', seen.home)
    for (const [name, path] of Object.entries(seen)) ok(inside(path, home) && outsideRealHome(path, home), `子进程解析 ${name} 不指向真实主目录`, path)

    const git = (...args) => spawnSync('git', args, { cwd: root, env, encoding: 'utf8', windowsHide: true })
    const helpers = git('config', '--show-origin', '--get-all', 'credential.helper')
    const lines = helpers.stdout.split(/\r?\n/).filter(Boolean)
    ok(lines.length > 0 && /\t$/.test(lines.at(-1)) && lines.at(-1).includes('.gitconfig'), '全局 credential.helper 置空，覆盖系统凭据助手', helpers.stdout)
    const origin = git('config', '--global', '--show-origin', '--list').stdout.split('\t')[0].replace(/^file:/, '').replace(/^"|"$/g, '').replaceAll('\\\\', '\\')
    ok(resolve(layout.gitconfig) === resolve(origin), 'git 全局配置读隔离主目录', origin)
    ok(git('config', '--global', 'user.email').stdout.trim() === 'debug@inkstone.invalid', 'git 提交身份为调试身份')
    ok(readFileSync(layout.gitconfig, 'utf8').includes('helper ='), '.gitconfig 写入空凭据助手')

    process.env.YAN_DEBUG_REAL_DEVICES = '1'
    const real = cleanEnv(sandboxEnv(box))
    ok(!real.ANDROID_USER_HOME && real[Object.keys(real).find((key) => key.toUpperCase() === 'PATH')].split(delimiter).includes(adbDir), 'YAN_DEBUG_REAL_DEVICES=1 时保留 adb')
  } finally {
    process.env[pathKey()] = saved.path
    if (saved.devices === undefined) delete process.env.YAN_DEBUG_REAL_DEVICES
    else process.env.YAN_DEBUG_REAL_DEVICES = saved.devices
    rmSync(root, { recursive: true, force: true })
  }
})
