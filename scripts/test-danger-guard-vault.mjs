import './lib/test-isolate.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const PROJECT = 'C:/vaultproj'
const NAMES = ['api-keys.json', 'codex-accounts.json', 'image-config.json', 'oauth-accounts.json', 'relay-bridge.json', 'search-config.json']

await runSuite(import.meta.url, async (ok) => {
  const saved = { agent: process.env.PI_CODING_AGENT_DIR, data: process.env.YAN_DATA_DIR }
  const guard = await import('../resources/pi-extensions/danger-guard.js')
  const vaultReason = (reasons) => reasons.some((reason) => reason.startsWith('读取砚保存的账号与 Key'))
  const asks = (tool, input, label, cwd = PROJECT) => {
    const reasons = guard.detectDanger(tool, input, cwd)
    ok(vaultReason(reasons), `「危险操作询问」档要问：${label}`, JSON.stringify(reasons))
    const critical = guard.criticalDanger(tool, input, cwd)
    ok(!vaultReason(critical), `「不受限制」档不新增弹窗：${label}`, JSON.stringify(critical))
  }
  const quiet = (tool, input, label, cwd = PROJECT) => {
    const reasons = guard.detectDanger(tool, input, cwd)
    ok(!vaultReason(reasons), `不该问：${label}`, JSON.stringify(reasons))
  }
  try {
    for (const [agentDir, dataDir, label] of [
      [join(homedir(), '.pi', 'agent'), join(homedir(), '.pi', 'agent', 'yan'), '默认数据目录'],
      ['D:/vault-test/pi-agent', 'D:/vault-test/custom-yan-data', 'YAN_DATA_DIR 改到别处']
    ]) {
      process.env.PI_CODING_AGENT_DIR = agentDir
      process.env.YAN_DATA_DIR = dataDir
      for (const name of NAMES) asks('read', { path: join(dataDir, name) }, `${label} read ${name}`)
      asks('read', { path: join(dataDir, 'oauth-accounts.json.plaintext-20261116T000000Z-abc123.bak') }, `${label} read 明文备份`)
      asks('read', { path: join(dataDir, 'api-keys.json.plaintext-20261116T000000Z-abc123.bak').toUpperCase() }, `${label} 大小写不同的备份路径`)
      asks('read', { path: 'api-keys.json' }, `${label} 会话目录就是数据目录时读相对路径`, dataDir)
      asks('bash', { command: `cat "${dataDir.replace(/\\/g, '/')}/relay-bridge.json"` }, `${label} bash 写全路径`)
      asks('bash', { command: `cat ${dataDir.replace(/\\/g, '/')}/api-keys.json.plaintext-*.bak` }, `${label} bash 读备份通配`)
      asks('powershell', { command: `Get-Content "${dataDir}\\search-config.json"` }, `${label} PowerShell 反斜杠路径`)
      asks('bash', { command: 'cat yan/codex-accounts.json' }, `${label} 会话目录是 pi 目录时`, agentDir)
      quiet('read', { path: join(dataDir, 'desktop.json') }, `${label} 读 desktop.json`)
      quiet('read', { path: join(dataDir, 'credential-vault.log') }, `${label} 读 credential-vault.log`)
      quiet('read', { path: join(dataDir, 'credential-vault-state.json') }, `${label} 读计数状态文件`)
      quiet('read', { path: join(dataDir, 'sub', 'api-keys.json') }, `${label} 数据目录子文件夹里的同名文件`)
    }
    process.env.PI_CODING_AGENT_DIR = join(homedir(), '.pi', 'agent')
    process.env.YAN_DATA_DIR = join(homedir(), '.pi', 'agent', 'yan')
    asks('bash', { command: 'cat ~/.pi/agent/yan/codex-accounts.json' }, 'bash 用 ~ 读')
    asks('bash', { command: 'type "%YAN_DATA_DIR%\\api-keys.json"' }, 'cmd 用 %YAN_DATA_DIR%')
    asks('powershell', { command: 'Get-Content $env:YAN_DATA_DIR/oauth-accounts.json' }, 'PowerShell 用 $env:YAN_DATA_DIR')
    asks('bash', { command: 'cd ~/.pi/agent && cat yan/image-config.json | head' }, 'bash 先 cd 再读')

    quiet('read', { path: `${PROJECT}/api-keys.json` }, '项目里的同名 api-keys.json')
    quiet('read', { path: 'config/search-config.json' }, '项目里相对路径的同名文件')
    quiet('bash', { command: 'cat api-keys.json' }, '项目里 bash 读同名文件')
    quiet('bash', { command: 'node scripts/build.js --out relay-bridge.json' }, '项目命令里出现同名文件')
    quiet('bash', { command: 'cat src/api-keys.json.ts' }, '名字只是前缀的文件')
    quiet('bash', { command: 'cat ~/.pi/agent/yan/desktop.json' }, 'bash 读 desktop.json')
    quiet('read', { path: join(homedir(), '.pi', 'agent', 'settings.json') }, '读 pi 的 settings.json')
    quiet('write', { path: `${PROJECT}/api-keys.json`, content: '{}' }, '项目里写同名文件')

    const authFile = join(process.env.PI_CODING_AGENT_DIR, 'auth.json')
    ok(guard.criticalDanger('read', { path: authFile }, PROJECT).length > 0, '读 auth.json 在「不受限制」档仍按原样询问（现行为不变）')
    ok(guard.detectDanger('read', { path: authFile }, PROJECT).length > 0, '读 auth.json 在「危险操作询问」档仍询问')
    ok(guard.detectDanger('write', { path: join(process.env.YAN_DATA_DIR, 'api-keys.json'), content: '{}' }, PROJECT).length > 0, '写凭据文件仍按改砚配置询问（不放松）')
  } finally {
    if (saved.agent === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = saved.agent
    if (saved.data === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = saved.data
  }
})
