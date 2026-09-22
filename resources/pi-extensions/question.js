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
 * 提问行为由**会话级工作模式**决定（标准 / 澄清 / 自主），不再是全局布尔。
 * 宿主在每次推送 / 切换会话时把该实例的模式写到
 * `YAN_DATA_DIR/work-mode/<YAN_SESSION_ID>.json`（`YAN_SESSION_ID` 就是宿主注入的
 * 运行实例 id）。扩展每轮读它：
 *   · 自主   → before_agent_start 追加「自己决策、不要调用 yan question ask」；
 *   · 澄清   → 追加「先把目标问清」，允许宿主 CLI 提问；
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
 * 澄清模式：先把目标问清楚。
 *
 * S2 只交付“提问行为 + 提示”这一层；「就绪后自动转标准并开始」是 S3 的原子转移
 * （需要宿主校验 readiness），所以这里的措辞**不承诺**自动开始。
 */
const CLARIFY_GUIDANCE = [
  'Clarify mode is ON: settle the goal before doing the work.',
  '- Ask the ONE question whose answer most changes what you would build; several truly independent questions may be grouped.',
  '- Never re-ask what the user already told you; check the repository first when the answer is discoverable there.',
  '- For low-impact unknowns, state a one-line assumption instead of asking.',
  '- Give 2-4 concrete options. The user can also pick the custom/typed answer.',
  /*
   * 就绪转移（实施-05 S3）：通道是宿主 CLI，不是新工具。
   * 这两句必须说清「本轮仍只读」—— 模式切换按轮生效，提交完就写文件会失败。
   */
  '- This mode is READ-ONLY: writing tools (write / edit / task updates) are disabled, and bash only accepts `yan goal status|ready|report …` or `yan question ask …` — nothing else, no shell operators.',
  '- Once the goal, deliverable, scope, constraints and acceptance criteria are all settled and nothing material is left open, submit it exactly once with `yan goal ready` using **inline arguments** (run `yan goal --help` for the shape) — you cannot write a request file in this mode. The mode switches to standard automatically; the NEXT turn can make changes.',
  '- Never claim work is finished in this mode: you cannot change anything yet.'
].join('\n')

/** 自主模式：别问，自己拿主意（追加到系统提示） */
const AUTONOMOUS_GUIDANCE = [
  'Autonomous mode is ON:',
  '- Do NOT ask the user questions, and do NOT call `yan question ask`.',
  '- Make a sensible assumption, state it in one line, and carry the task through to completion.',
  '- Prefer reversible choices when several options are plausible.',
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
