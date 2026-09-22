/*
 * 工作模式的**工具策略执行**（实施-05 S3）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这件事留在薄层里（而不是宿主）
 * ══════════════════════════════════════════════════════════════════
 * 澄清档的验收口径是「工具集**真的**受限」，而限制工具集只有两条路：
 *   · `--tools`（启动参数，运行中改不了）；
 *   · `setActiveTools`（**扩展 API**）。
 * pi 的 RPC 面**没有**工具命令 —— 实测 `get_tools` / `set_active_tools`
 * 都回 `Unknown command`（证据-04-S1 §3.2）。所以按 01 的边界划分，
 * 这条属于「宿主无法通过 CLI / RPC 表达的策略执行」，正是允许留在薄层的那一类。
 *
 * 宿主仍然是策略的真源：它把「这个实例当前是什么模式」写进
 * `YAN_DATA_DIR/work-mode/<YAN_SESSION_ID>.json`，这里只负责执行。
 *
 * ── 门禁顺序（证据-05-S1 实验 1 定的）──
 *   ① 工具表（主）：澄清档把非只读工具**从表里拿掉** —— 模型看不到它，
 *      连「试图调用再被拒」都不会发生；
 *   ② `tool_call` 兜底：万一工具表没刷新成功（或第三方工具不在白名单里），
 *      直接 block。实测这是真门禁（同一条命令在对照组真写了文件）；
 *   ③ 提示词（说明）：在 `question.js` 里，只负责让模型知道为什么。
 *
 * ⚠️ 白名单必须**显式列全**：`grep` / `find` / `ls` 默认不在激活集里（01-S1 实测）。
 *    提问不再是模型工具；澄清档通过下面的受限 `yan question ask` bash 形状完成。
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 澄清档允许的工具：只读查询 + **受限的 bash**。
 *
 * 为什么**不**放 `write` / `edit`：那是真正的写入口，直接拿掉。
 * 为什么要放 `bash`（但这不等于放行 bash）：
 *   澄清档的「就绪提交」通道是宿主 CLI（`yan goal ready`，实施-05 §4 定的），
 *   而敲 CLI 要用 bash 工具 —— 把 bash 拿掉，澄清档就永远提交不了、也就永远好不了。
 *   所以 bash 留着，但**命令形状**由下面的白名单卡死（见 `isAllowedBashCommand`）：
 *   只接受 `yan goal status|ready|report`、`yan question ask` 或严格形状的
 *   `yan context recall --ref ctx://…`，且整条命令里**不得出现
 *   任何 shell 元字符**（`;` `&&` `|` `>` 反引号 `$` 换行……）。
 *   这不是「对任意 shell 命令做脆弱的只读判断」（§4 禁止的那种），
 *   而是「只允许这一条经审查的命令」—— 白名单，不是启发式。
 *
 * 归档回读也走宿主 CLI；提问与回读都不向澄清档恢复业务模型工具。
 */
const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls', 'bash']

/** 澄清档允许的宿主 bash 形状：目标状态 / 提问 / 只读归档回读。 */
const GOAL_COMMAND = /^\s*(?:"[^"]*[\\/])?yan(?:\.(?:cmd|exe|mjs))?\s+goal\s+(?:status|ready|report)(?:\s|$)/
const QUESTION_COMMAND = /^\s*(?:"[^"]*[\\/])?yan(?:\.(?:cmd|exe|mjs))?\s+question\s+ask(?:\s|$)/
const CONTEXT_REF = 'ctx:\\/\\/(?:tool|file|diff|episode)\\/[A-Za-z0-9._~%:-]{1,200}'
const CONTEXT_RECALL_COMMAND = new RegExp(
  `^\\s*(?:"[^"]*[\\\\/])?yan(?:\\.(?:cmd|exe|mjs))?\\s+context\\s+recall\\s+--ref\\s+(?:${CONTEXT_REF}|"${CONTEXT_REF}")\\s*$`
)

/**
 * 元字符一律拒。
 *
 * 没有这一条，`yan goal status; rm -rf …` 这类拼接会绕过上面那条白名单：
 * 命令**以** `yan goal status` 开头，但它干的不只这件事。
 */
const SHELL_METACHARS = /[;&|<>`$(){}[\]\n\r]/

function dataDir() {
  return process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
}

/** 宿主写给这个运行实例的模式快照（与 question.js 同一个文件）。 */
function workModeFile() {
  const key = process.env.YAN_SESSION_ID?.trim() || 'session'
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session'
  return join(dataDir(), 'work-mode', `${safe}.json`)
}

const WORK_MODES = ['standard', 'clarify', 'autonomous']

function currentWorkMode() {
  try {
    const mode = JSON.parse(readFileSync(workModeFile(), 'utf8'))?.mode
    if (WORK_MODES.includes(mode)) return mode
  } catch {
    /* 宿主还没写（刚启动）—— 走回退链 */
  }
  try {
    const settings = JSON.parse(readFileSync(join(dataDir(), 'desktop.json'), 'utf8'))
    if (WORK_MODES.includes(settings?.defaultWorkMode)) return settings.defaultWorkMode
    return settings?.autonomous === true ? 'autonomous' : 'standard'
  } catch {
    return 'standard'
  }
}

/**
 * 诊断（只在 `YAN_WORK_MODE_EXT_LOG` 存在时写）。
 *
 * 「工具集真的收紧了没有」在界面上看不出来 —— 模型没写文件可能是被门禁挡住，
 * 也可能是它本来就只需要读。落一行「模式 / 基线 / 实际生效集合 / 拦下了谁」
 * 才能把两种情形分开（与 question.js / language.js 同一做法）。
 */
function note(hook, payload) {
  const log = process.env.YAN_WORK_MODE_EXT_LOG
  if (!log) return
  try {
    appendFileSync(
      log,
      JSON.stringify({
        at: new Date().toISOString(),
        hook,
        sessionId: process.env.YAN_SESSION_ID ?? null,
        ...payload
      }) + '\n',
      'utf8'
    )
  } catch {
    /* 诊断失败不影响策略 */
  }
}

/** 这条 bash 命令是不是允许的宿主 CLI 形状？ */
function isAllowedBashCommand(command) {
  if (!command) return false
  if (SHELL_METACHARS.test(command)) return false
  return GOAL_COMMAND.test(command) || QUESTION_COMMAND.test(command) || CONTEXT_RECALL_COMMAND.test(command)
}

/** 工具名归一：`getActiveTools()` 在 0.85.1 回字符串数组，这里顺手兼容对象形态。 */
function toolName(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && typeof entry.name === 'string') return entry.name
  return ''
}

export default function workModePolicy(pi) {
  /** 宿主给的原始激活集（`--tools` 决定）。**只在第一次收紧前记录**，之后它是恢复用的基线。 */
  let baseTools = null
  /** 当前是否处于「已被本扩展收紧」的状态（决定退出澄清档时要不要恢复）。 */
  let restricted = false
  /** 最近一次读到的模式（`tool_call` 兜底要用）。 */
  let mode = 'standard'

  const applyTools = (names) => {
    try {
      pi.setActiveTools?.(names)
      return null
    } catch (err) {
      return String(err?.message ?? err)
    }
  }

  pi.on('before_agent_start', () => {
    mode = currentWorkMode()
    if (mode === 'clarify') {
      /* 记录基线要在收紧**之前**：收紧后就看不到宿主给的原始集了 */
      if (!baseTools) baseTools = (pi.getActiveTools?.() ?? []).map(toolName).filter(Boolean)
      const target = baseTools.filter((name) => READ_ONLY_TOOLS.includes(name))
      const err = applyTools(target)
      restricted = true
      note('before_agent_start', { mode, base: baseTools, applied: target, err })
      return
    }
    /*
     * 非澄清档**一律不动工具表**（除了从澄清档退回来的那一次）。
     *
     * 为什么：这个扩展在所有会话里都加载。若每轮都无条件 `setActiveTools`，
     * 就等于拿一个「启动时的快照」去覆盖工具表 —— 其他薄层
     * 或后续注册的工具会被沏掉，而且症状与本次改动毫无关系，很难查。
     */
    if (restricted) {
      const err = applyTools(baseTools ?? [])
      restricted = false
      note('before_agent_start', { mode, base: baseTools, applied: baseTools ?? [], err, restored: true })
    }
  })

  /*
   * 兜底：澄清档下除了「只读集 + 允许形状的宿主 CLI」一律拒绝。
   *
   * ⚠️ 返回值的 `content` / `isError` 会被 pi 忽略（实测固定成
   *    「Tool execution was blocked」+ isError），所以这里不要费劲写文案 ——
   *    要让模型理解原因，只能靠提示词，或者干脆把工具从表里拿掉。
   */
  pi.on('tool_call', (event) => {
    const name = String(event?.toolName ?? '')
    if (mode !== 'clarify' || !name) return undefined
    if (name === 'bash') {
      const command = String((event?.input ?? {})?.command ?? '')
       if (isAllowedBashCommand(command)) return undefined
      note('tool_call_blocked', { mode, tool: name, command: command.slice(0, 140) })
      return { block: true }
    }
    if (READ_ONLY_TOOLS.includes(name)) return undefined
    note('tool_call_blocked', { mode, tool: name })
    return { block: true }
  })
}
