/**
 * 工具卡「来源」判定（实施-02 S4）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════════════
 * 迁移后模型维护任务清单的方式是：用 pi 的**原生 bash 工具**敲一句
 * `yan tasks apply --request-file …`。对模型来说这是 bash、对宿主来说这是
 * 砚的能力 —— 两者都对，但界面必须说清楚**这是砚内置的任务计划**，
 * 否则用户看到一行 bash 命令，以为模型在自己折腾。
 *
 * ── 边界（很重要，别扩写）──
 * · 这里**只生成展示标记**，不改变任何写入语义、不给任何权限。
 *   任务清单是否真的被改写，永远由宿主服务（收到 `tasks.apply` 请求）决定。
 * · 判定依据是**命令文本**，所以理论上模型写一句
 *   `echo "yan tasks apply"` 也能拿到这个标记。代价可接受：它只是标签，
 *   而且被标记的那条本来就是一条真实存在的 bash 调用（可展开看原文）。
 *   要更强的保证得让宿主把操作回执与 pi 的 toolCallId 关联，而 pi 的
 *   bash 工具**不把 toolCallId 传进子进程环境**，做不到 —— 与其造一个
 *   看起来精确其实靠猜的关联，不如老实按文本判定。
 * · 不伪造「原生独立工具事件」：卡片仍是 bash 卡，展开仍是原始命令与输出。
 */

/** bash 类工具名（pi 的原生工具叫 `bash`；其余是兼容写法）。 */
const SHELL_TOOLS = new Set(['bash', 'shell', 'run', 'exec'])

/**
 * `yan <组> <动作>` 的识别（两个内置组各一条）。
 *
 * 允许的形式（以 tasks apply 为例，goal 同理）：
 *   yan tasks apply …
 *   yan.cmd tasks apply …          （Windows 启动器）
 *   "C:\...\yan.cmd" tasks apply … （带路径 / 带引号）
 *   /usr/local/bin/yan tasks apply …
 *
 * 分隔符用「前面的**一个**词以 yan 结尾」而不是精确匹配整个可执行名 ——
 * 路径里可能有反斜杠与引号，抠得太死会把真实调用漏掉（漏掉只是没标签，
 * 但用户会以为迁移没生效）。
 */
const YAN_TASKS_APPLY = /(^|[\s"'`;&|(])(?:[^\s"'`]*[\\/])?yan(?:\.(?:cmd|exe|mjs))?["'`]?\s+tasks\s+apply(?:[\s"'`;&|)]|$)/i

/** `yan goal ready|report|status`：目标状态（实施-05 S3）。 */
const YAN_GOAL = /(^|[\s"'`;&|(])(?:[^\s"'`]*[\\/])?yan(?:\.(?:cmd|exe|mjs))?["'`]?\s+goal\s+(?:ready|report|status)(?:[\s"'`;&|)]|$)/i

/** 从工具调用的参数里取命令行文本（pi 的 bash 工具是 `{command}`）。 */
function commandTextOf(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  for (const key of ['command', 'cmd', 'script']) {
    const v = a[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
}

/**
 * 这条调用是不是「砚内置任务计划」？
 *
 * 返回匹配到的命令行原文（供卡片显示命令摘要），不匹配返回 null。
 */
export function taskPlanCommand(name: unknown, args: unknown): string | null {
  if (typeof name !== 'string' || !SHELL_TOOLS.has(name)) return null
  const text = commandTextOf(args)
  if (!text) return null
  return YAN_TASKS_APPLY.test(text) ? text : null
}

/**
 * 这条调用是不是「砚内置目标状态」（`yan goal …`，实施-05 S3）？
 *
 * 同 `taskPlanCommand`：**只是展示标记**，写入权永远在宿主（`yan:goal.*` 命令）。
 * 要认出 `goal ready` / `report` / `status` 三个动作 —— 只认 `ready` 会让
 * 「读了 status 才提交」那一步看起来像模型在乱敲命令。
 */
export function goalCommand(name: unknown, args: unknown): string | null {
  if (typeof name !== 'string' || !SHELL_TOOLS.has(name)) return null
  const text = commandTextOf(args)
  if (!text) return null
  return YAN_GOAL.test(text) ? text : null
}

/**
 * 卡片上显示的命令摘要。
 *
 * 折叠掉连续空白与换行：命令里常带 heredoc，原样铺会把一行卡撑成好几行。
 * 截断到 120 字符 —— 完整原文永远能在展开详情里看到。
 */
export function summarizeTaskPlanCommand(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 120 ? `${one.slice(0, 119)}…` : one
}

/** 语义化别名：目标状态卡也用同一套摘要规则（折叠空白 + 截断）。 */
export const summarizeYanCommand = summarizeTaskPlanCommand
