/*
 * 砚内置「提问」薄层 —— 为工作模式提供提问指引；真正的交互入口是
 * 宿主 `yan question ask`，不是模型工具。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么还保留薄层（而不是把它删掉）
 * ══════════════════════════════════════════════════════════════════
 * 工作模式的语言指引仍需要在每轮开始时贴近模型上下文，且 pi 没有等价的
 * CLI / RPC 系统提示钩子，所以这一小段生命周期桥接继续留在薄层。真正的
 * 提问请求由宿主能力服务处理：模型用原生 `bash` 调 `yan question ask`，
 * 主进程复用现有问题面板和同一个 `yan:respondUi` IPC；薄层不再注册业务工具，
 * 也不直接读取 `ctx.ui.*`。
 *
 * ── 工作模式（实施-05）──
 * 提问行为由**会话级工作模式**决定（标准 / 计划 / 自主），不再是全局布尔。
 * 宿主在每次推送 / 切换会话时把该实例的模式写到
 * `YAN_DATA_DIR/work-mode/<YAN_SESSION_ID>.json`（`YAN_SESSION_ID` 就是宿主注入的
 * 运行实例 id）。扩展每轮读它：
 *   · 自主   → before_agent_start 追加「自己决策、不要调用 yan question ask」；
 *   · 计划   → 追加「先把目标问清」，允许宿主 CLI 提问；
 *   · 标准   → 追加「模糊时先问」，允许宿主 CLI 提问。
 * 读取文件而不是环境变量/内存：模式会在会话中途切换，下一轮就生效。
 *
 * 回退链（文件缺失时）：新字段 `defaultWorkMode` → 旧布尔 `autonomous` → 标准。
 * 新字段优先，所以从「自主」改回「标准」的用户不会被旧布尔再拽回自主。
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function dataDir() {
  return process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
}

function settingsFile() {
  return join(dataDir(), 'desktop.json')
}

/** 宿主写给这个运行实例的模式快照。 */
function workModeFile() {
  const key = process.env.YAN_SESSION_ID?.trim() || 'session'
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session'
  return join(dataDir(), 'work-mode', `${safe}.json`)
}

const WORK_MODES = ['standard', 'clarify', 'autonomous']

/**
 * 模式诊断（只在 `YAN_QUESTION_EXT_LOG` 存在时写一行）。
 *
 * 为什么要它：「模式真的到达扩展了吗」在界面上看不出来 —— 交互面板由宿主
 * `yan question ask` 控制，模型可能没有按提示调用 CLI，也可能正处于自主档。
 * 落一行 `{hook,mode,sessionId,file}` 能把模式注入与宿主交互分开诊断
 * （与 `language.js` / `project-knowledge.js` 同一做法）。
 */
function noteModeDiagnostic(hook, mode) {
  const log = process.env.YAN_QUESTION_EXT_LOG
  if (!log) return
  try {
    appendFileSync(
      log,
      JSON.stringify({
        at: new Date().toISOString(),
        hook,
        mode,
        sessionId: process.env.YAN_SESSION_ID ?? null,
        file: workModeFile()
      }) + '\n',
      'utf8'
    )
  } catch {
    /* 诊断失败不影响提问逻辑 */
  }
}

/** 当前会话的工作模式；脏值 / 缺失按回退链处理。 */
function currentWorkMode() {
  try {
    const mode = JSON.parse(readFileSync(workModeFile(), 'utf8'))?.mode
    if (WORK_MODES.includes(mode)) return mode
  } catch {
    /* 文件还没写（宿主刚启动）—— 走回退链 */
  }
  try {
    const settings = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    if (WORK_MODES.includes(settings?.defaultWorkMode)) return settings.defaultWorkMode
    return settings?.autonomous === true ? 'autonomous' : 'standard'
  } catch {
    return 'standard'
  }
}

/** 标准模式：模糊时先问（改动前的默认行为） */
const STANDARD_GUIDANCE = [
  'Interactive questions:',
  '- If a request is genuinely ambiguous, or you are about to guess at a choice that materially changes the result, call `yan question ask` and ask BEFORE doing the work.',
  '- Ask only when the answer changes what you build; do not ask about trivia or things you can verify yourself.',
  '- Give 2-4 concrete options. The user can also pick the custom/typed answer.',
  '- Keep it to one question at a time unless several are truly independent.'
].join('\n')

/**
 * 计划档（内部 id 仍叫 `clarify`）：先读、先出计划，动手之前把事谈定。
 *
 * 为什么保留旧 id：它是 `work-modes.json` 里的存量值（已落盘的会话很多），
 * 改 id 就要写一次迁移，而迁移本身没有用户可见收益。界面名与提示词里的
 * 定位是「计划」（2026-09-22 用户口径）。
 *
 * 2026-09-22 调整：不再只是「把目标问清楚」，而是**产出计划** —— 模型要
 * 用 `yan goal report` 把步骤登记进目标（只写在回复里的计划不算计划）。
 */
const CLARIFY_GUIDANCE = [
  'Plan mode is ON: produce a plan before doing the work.',
  /*
   * 只读限制放在最前面：它决定了这个档位能做与不能做的事，
   * 也解释了为什么「计划」只能靠 `yan goal report` 落盘。
   */
  '- This mode is READ-ONLY: writing tools (write / edit / task updates) are disabled, and bash only accepts `yan goal status|ready|report …` or `yan question ask …` — nothing else, no shell operators.',
  '- Start by reading what already exists (read / grep / find / ls) instead of asking what you could find out yourself.',
  '- Ask the ONE question whose answer most changes the plan; several truly independent questions may be grouped. Never re-ask what the user already told you.',
  '- Give 2-4 concrete options. The user can also pick the custom/typed answer.',
  '- For low-impact unknowns, state a one-line assumption instead of asking.',
  /*
   * 计划要**落盘**才是计划：用户看的是右栏的步骤列表，不是一条长回复。
   * 通道是宿主 CLI（`report` 的 planning 阶段），所以只读档也能登记。
   */
  '- Register the plan itself with `yan goal report` (phase `planning` with concrete `steps`; one step is fine for a small task) and keep those steps updated as you learn more. A plan that lives only in your reply is not a plan.',
  '- Once the goal, deliverable, scope, constraints and acceptance criteria are all settled and nothing material is left open, submit them exactly once with `yan goal ready` using **inline arguments** (run `yan goal --help` for the shape) — you cannot write a request file in this mode. The mode switches to standard automatically; the NEXT turn can make changes.',
  '- Never claim work is finished in this mode: you cannot change anything yet.'
].join('\n')

/**
 * 自主档：不问问题，自己分析并解决。
 *
 * 2026-09-22 调整：重心从「自己拿主意」移到「自己**诊断**」——
 * 原来的措辞只要求做决定，于是模型容易停在第一个看起来合理的猜测上，
 * 把一个没查清的问题当成了解决方案。
 */
const AUTONOMOUS_GUIDANCE = [
  'Autonomous mode is ON: diagnose and solve on your own.',
  '- Do NOT ask the user questions, and do NOT call `yan question ask`.',
  '- Find the actual cause or constraint yourself first (read the code, run the failing case, check the real state) instead of stopping at the first plausible guess.',
  '- Then pick the approach you can defend, say why in one line, and carry it through: implement, verify, and keep the evidence.',
  '- Make a sensible assumption, state it in one line, and prefer reversible choices when several options are plausible.',
  '- The host registers your user request as the active goal before this turn. Start by running `yan goal status` to read the current goal revision, turn the request into a concrete plan, and keep that goal moving; do not wait for the user to create a plan.',
  /*
   * 目标推进（实施-05 S3 §5）：自主档最容易犯的错是「一轮文本结束就当完成」。
   * 通道同样是宿主 CLI（`yan goal report`），完成要证据、阻塞要说原因。
   */
  '- Report goal progress with `yan goal report` (run `yan goal --help` for the request shape): `completed` needs concrete evidence, `blocked` needs the reason, and a task-list checkbox is not evidence.',
  /*
   * 大任务自主闭环（实施-05 S3c）：先把计划登记下来（事后能看到「做到哪一步」），
   * 报完就收尾本轮 —— 宿主会自动把模型叫回来继续，不需要用户再说一句话。
   */
  '- Register the concrete plan first (phase `planning` with `steps`; one step is fine for a small task), then work through those steps and keep the steps updated.',
  '- End your turn once you reported progress: the host automatically calls you back to continue until the goal is `completed` or `blocked`. Never wait for the user to say "continue".',
  '- If the same failure repeats without new information, report `blocked` instead of retrying the same thing.'
].join('\n')

function guidanceFor(mode) {
  if (mode === 'autonomous') return AUTONOMOUS_GUIDANCE
  if (mode === 'clarify') return CLARIFY_GUIDANCE
  return STANDARD_GUIDANCE
}

export default function question(pi) {
  // 每轮开始前按当前模式调整系统提示（模式中途切换也能立刻生效）
  pi.on('before_agent_start', (event) => {
    const mode = currentWorkMode()
    noteModeDiagnostic('before_agent_start', mode)
    const extra = guidanceFor(mode)
    const base = String(event?.systemPrompt ?? '')
    return { systemPrompt: `${base}\n\n${extra}` }
  })
}
