import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join, parse } from 'node:path'

const GITCONFIG = `[user]
\tname = Inkstone Debug
\temail = debug@inkstone.invalid
[credential]
\thelper =
[init]
\tdefaultBranch = main
`

export function pathKey(env = process.env) {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH'
}

export function realDevices() {
  return process.env.YAN_DEBUG_REAL_DEVICES === '1'
}

export function instancePath(value = process.env[pathKey()] ?? '') {
  if (realDevices()) return value
  const adb = process.platform === 'win32' ? 'adb.exe' : 'adb'
  return value.split(delimiter).filter((dir) => dir && !existsSync(join(dir, adb))).join(delimiter)
}

export function homeLayout(home) {
  return {
    home,
    roaming: join(home, 'AppData', 'Roaming'),
    local: join(home, 'AppData', 'Local'),
    ssh: join(home, '.ssh'),
    gitconfig: join(home, '.gitconfig')
  }
}

export function createIsolatedHome(home) {
  const layout = homeLayout(home)
  for (const dir of [layout.roaming, layout.local, layout.ssh, join(home, 'Documents')]) mkdirSync(dir, { recursive: true })
  if (!existsSync(layout.gitconfig)) writeFileSync(layout.gitconfig, GITCONFIG)
  return layout
}

export function isolatedHomeEnv(home) {
  const layout = homeLayout(home)
  const drive = parse(home).root.replace(/[\\/]+$/, '')
  const slash = (path) => path.replaceAll('\\', '/')
  const sshOption = (name, value) => `-o ${name}="${slash(value)}"`
  return {
    USERPROFILE: home,
    HOME: home,
    ...(drive ? { HOMEDRIVE: drive, HOMEPATH: home.slice(drive.length) } : {}),
    APPDATA: layout.roaming,
    LOCALAPPDATA: layout.local,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    GH_CONFIG_DIR: join(layout.roaming, 'GitHub CLI'),
    HERMES_HOME: join(home, '.hermes'),
    GRADLE_USER_HOME: join(home, '.gradle'),
    ...(realDevices() ? {} : { ANDROID_USER_HOME: join(home, '.android'), ANDROID_AVD_HOME: join(home, '.android', 'avd') }),
    GIT_CONFIG_GLOBAL: layout.gitconfig,
    GIT_SSH_COMMAND: ['ssh -F none -o IdentityAgent=none -o IdentitiesOnly=yes', sshOption('IdentityFile', join(layout.ssh, 'id_none')), sshOption('UserKnownHostsFile', join(layout.ssh, 'known_hosts'))].join(' '),
    SSH_AUTH_SOCK: join(layout.ssh, 'agent.sock')
  }
}

export function isolatedProcessEnv(home) {
  return { ...isolatedHomeEnv(home), [pathKey()]: instancePath() }
}
