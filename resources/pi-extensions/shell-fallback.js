/**
 * Windows 命令行适配：没有 Git Bash 时退到 PowerShell；有 Git Bash 时修正 bash 工具的命令交付。
 *
 * 随包 pi 在 Windows 上只有找得到 bash.exe 才能跑 `bash` 工具。宿主在启动 pi 时发现
 * 找不到（也没装受管 Git），就设置 `YAN_SHELL=powershell`；这里在每轮开始前把工具表里的
 * `bash` 换成 pi 自带的 `powershell`（Windows 自带，不需要任何下载），模型看到的就是一个能用的命令行工具，
 * 而不是每次调用都失败的 bash。
 *
 * 有 Git Bash 时，用同名工具覆盖 pi 的 `bash`：参数、说明、输出处理沿用 pi 原生定义，
 * 只把命令改经临时文件交给 bash（原因见 shell-transport.js），并让 `python` / `python3` 绕过商店安装引导
 * （见 windows-python.js）。每条命令前把所在控制台切到 UTF-8（`chcp.com 65001`）：PowerShell、cmd 等
 * 原生程序按控制台代码页输出，中文系统默认 936（GBK），pi 按 UTF-8 读就是乱码。每个 bash
 * 有自己的控制台，代码页不会留到宿主或用户终端。另在执行前拦下 bash 双引号里会改坏
 * PowerShell 脚本的写法（见 windows-powershell.js）。其他平台不碰。
 *
 * 必须在 work-mode.js **之前**加载：它记录「宿主给的原始工具集」作恢复基线，要记到换好之后的这一份。
 */

import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileTransportOperations } from './shell-transport.js'
import { createPythonEnvFixer } from './windows-python.js'
import { findPowerShellInBash, findPowerShellQuotingConflict, powerShellConflictReason, powerShellInBashReason } from './windows-powershell.js'

const UTF8_CONSOLE = 'chcp.com 65001 >/dev/null 2>&1'

function toolName(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && typeof entry.name === 'string') return entry.name
  return ''
}

/**
 * 注册经临时文件交付的 `bash`。每次执行按当前目录读取 pi 设置里的 shellPath 与
 * shellCommandPrefix，与 pi 内置 bash 的取值一致。
 */
export function registerBashFileTransport(pi, core, { fixEnv = createPythonEnvFixer({ shimDir: join(tmpdir(), 'yan-python-shim') }) } = {}) {
  const spawnHook = (context) => ({ ...context, env: fixEnv(context.env) })
  const bashTool = (cwd) => {
    const settings = core.SettingsManager.create(cwd)
    const shellPath = settings.getShellPath()
    return core.createBashToolDefinition(cwd, {
      shellPath,
      commandPrefix: settings.getShellCommandPrefix(),
      spawnHook,
      operations: fileTransportOperations(core.createLocalBashOperations({ shellPath }), { preamble: UTF8_CONSOLE })
    })
  }
  const template = core.createBashToolDefinition(process.cwd())
  pi.registerTool({
    ...template,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      bashTool(ctx?.cwd ?? process.cwd()).execute(toolCallId, params, signal, onUpdate, ctx)
  })
}

/**
 * 取 pi 的公开导出。打包后扩展由 jiti 转译，包名别名可用；开发态仓库是
 * `"type": "module"`，扩展按原生 ESM 加载，别名不生效，改从 pi 入口旁的 index.js 导入
 * （与入口共用同一份模块实例）。
 */
async function loadPiCore() {
  try {
    return await import('@earendil-works/pi-coding-agent')
  } catch (error) {
    const index = process.argv[1] ? join(dirname(process.argv[1]), 'index.js') : ''
    if (!index || !existsSync(index)) throw error
    return await import(pathToFileURL(index).href)
  }
}

export default async function shellFallback(pi) {
  if (process.env.YAN_SHELL === 'powershell') {
    pi.on('before_agent_start', () => {
      try {
        const names = (pi.getActiveTools?.() ?? []).map(toolName).filter(Boolean)
        if (names.includes('powershell') && !names.includes('bash')) return
        const next = names.filter((name) => name !== 'bash')
        if (!next.includes('powershell')) next.push('powershell')
        pi.setActiveTools?.(next)
      } catch {
        /* 换不成就保持原样：宁可 bash 报「没找到」，也不能让整个回合起不来 */
      }
    })
    return
  }
  if (process.platform !== 'win32') return
  try {
    registerBashFileTransport(pi, await loadPiCore())
  } catch {
    /* 拿不到 pi 的工具工厂（版本变动等）就保留原生 bash，不让 pi 启动失败 */
  }
  pi.on('tool_call', (event) => {
    if (event?.toolName !== 'bash') return undefined
    const command = event.input?.command
    const token = findPowerShellQuotingConflict(command)
    if (token) return { block: true, reason: powerShellConflictReason(token) }
    const cmdlet = findPowerShellInBash(command)
    return cmdlet ? { block: true, reason: powerShellInBashReason(cmdlet) } : undefined
  })
}
