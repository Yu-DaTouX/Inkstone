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
 *
 * ── 提问频率（全局 + 会话覆盖）──
 * 在标准 / 计划模式下，还要叠加用户设置的提问频率（少问 / 适中默认 / 多问，
 * 见 `src/shared/question-frequency.ts`）。**会话级**四态（inherit / sparse /
 * balanced / eager）写在宿主那份工作模式快照里：显式值优先，`inherit` 回落
 * 到 `desktop.json.questionFrequency`。扩展每轮都重读两边，所以改设置或切会话
 * 下一轮就生效。脏值 / 缺失归到 `balanced`。它只调「何时问」的指引，
 * 不保证精确次数、不改历史与当前运行轮；自主模式仍固定不问，权限审批与
 * 高风险确认不受影响。
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
 * 提问频率三档（与 `src/shared/question-frequency.ts` 一致）。
 *
 * 扩展在无构建环境里运行，import 不了 shared 的 TS，所以这里保留一份等价实现；
 * 两边由 `scripts/test-question-frequency.mjs` 对照，避免列表 / 默认档漂移。
 */
export const QUESTION_FREQUENCIES = ['sparse', 'balanced', 'eager']
export const DEFAULT_QUESTION_FREQUENCY = 'balanced'

/** 会话级四态（与 shared 的 `SESSION_QUESTION_FREQUENCIES` 一致）。 */
export const SESSION_QUESTION_FREQUENCIES = ['inherit', ...QUESTION_FREQUENCIES]
export const DEFAULT_SESSION_QUESTION_FREQUENCY = 'inherit'

/** 非法 / 缺失值安全归一到默认档。 */
export function normalizeQuestionFrequency(value) {
  return QUESTION_FREQUENCIES.includes(value) ? value : DEFAULT_QUESTION_FREQUENCY
}

/** 非法 / 缺失值安全归一到继承（旧快照没有这个字段时也走这里）。 */
export function normalizeSessionQuestionFrequency(value) {
  return SESSION_QUESTION_FREQUENCIES.includes(value) ? value : DEFAULT_SESSION_QUESTION_FREQUENCY
}

/** 会话偏好 + 全局偏好 → 本轮实际档位；inherit 回落全局，显式值优先。 */
export function resolveQuestionFrequency(sessionValue, globalValue) {
  const preference = normalizeSessionQuestionFrequency(sessionValue)
  return preference === 'inherit' ? normalizeQuestionFrequency(globalValue) : preference
}

/**
 * 模式诊断（只在 `YAN_QUESTION_EXT_LOG` 存在时写一行）。
 *
 * 为什么要它：「模式真的到达扩展了吗」在界面上看不出来 —— 交互面板由宿主
 * `yan question ask` 控制，模型可能没有按提示调用 CLI，也可能正处于自主档。
 * 落一行 `{hook,mode,sessionId,file}` 能把模式注入与宿主交互分开诊断
 * （与 `language.js` / `project-knowledge.js` 同一做法）。
 */
function noteModeDiagnostic(hook, mode, frequency) {
  const log = process.env.YAN_QUESTION_EXT_LOG
  if (!log) return
  try {
    appendFileSync(
      log,
      JSON.stringify({
        at: new Date().toISOString(),
        hook,
        mode,
        frequency: frequency ?? null,
        sessionId: process.env.YAN_SESSION_ID ?? null,
        file: workModeFile()
      }) + '\n',
      'utf8'
    )
  } catch {
    /* 诊断失败不影响提问逻辑 */
  }
}

/** 会话快照里的归属字段与当前 ctx 的稳定会话是否一致。
 *
 * 快照按 runner 写，实例被复用到另一条会话时，文件里可能还留着上一条会话的值。
 * 宿主写入时记下 `sessionId` / `sessionFile`，这里与 `ctx.sessionManager` 核对；
 * 不一致就当没有快照（回落全局 / 默认），不把旧会话的偏好带进新会话。
 * 旧快照没有归属字段时维持旧行为。
 */
function normalizeOwnerPath(value) {
  return typeof value === 'string' ? value.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '') : undefined
}

function ownerPathEquals(a, b) {
  const left = normalizeOwnerPath(a)
  const right = normalizeOwnerPath(b)
  if (!left || !right) return false
  return left === right || left.toLowerCase() === right.toLowerCase()
}

function snapshotOwnedBySession(record, ctx) {
  const snapId = typeof record?.sessionId === 'string' && record.sessionId.trim() ? record.sessionId.trim() : undefined
  const snapFile = typeof record?.sessionFile === 'string' && record.sessionFile.trim() ? record.sessionFile : undefined
  if (!snapId && !snapFile) return true
  let manager
  try {
    manager = ctx?.sessionManager
  } catch {
    manager = undefined
  }
  const ctxId = typeof manager?.getSessionId === 'function' ? manager.getSessionId() : undefined
  const ctxFile = typeof manager?.getSessionFile === 'function' ? manager.getSessionFile() : undefined
  /* 拿不到任何 ctx 身份（旧 pi / 无会话）：无法核对，维持旧行为，不因此清空偏好 */
  if (!ctxId && !ctxFile) return true
  if (snapId && ctxId && snapId === ctxId) return true
  if (snapFile && ownerPathEquals(snapFile, ctxFile)) return true
  return false
}

/** 读宿主写的快照；归属不符 / 读不到都返回 null（调用方回落全局 / 默认）。 */
function readOwnedSnapshot(ctx) {
  try {
    const record = JSON.parse(readFileSync(workModeFile(), 'utf8'))
    if (!record || typeof record !== 'object') return null
    return snapshotOwnedBySession(record, ctx) ? record : null
  } catch {
    return null
  }
}

/** 当前会话的工作模式；脏值 / 缺失按回退链处理。 */
function currentWorkMode(ctx) {
  const snapshot = readOwnedSnapshot(ctx)
  if (WORK_MODES.includes(snapshot?.mode)) return snapshot.mode
  try {
    const settings = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    if (WORK_MODES.includes(settings?.defaultWorkMode)) return settings.defaultWorkMode
    return settings?.autonomous === true ? 'autonomous' : 'standard'
  } catch {
    return 'standard'
  }
}

/**
 * 当前会话的提问频率；每轮读一次快照与全局设置，中途改设置或切会话下一轮生效。
 *
 * 优先级：会话快照里的显式档 → `desktop.json.questionFrequency` → `balanced`。
 * `inherit`（含快照缺失 / 脏值）回落全局；显式值不被全局变更覆盖。
 */
export function currentQuestionFrequency(ctx) {
  const sessionValue = readOwnedSnapshot(ctx)?.questionFrequency
  const preference = normalizeSessionQuestionFrequency(sessionValue)
  if (preference !== 'inherit') return preference
  try {
    return normalizeQuestionFrequency(JSON.parse(readFileSync(settingsFile(), 'utf8'))?.questionFrequency)
  } catch {
    return DEFAULT_QUESTION_FREQUENCY
  }
}

/** 会话快照里的原始偏好（诊断用；缺项 / 脏值归一到 inherit）。 */
export function currentSessionQuestionFrequency(ctx) {
  return normalizeSessionQuestionFrequency(readOwnedSnapshot(ctx)?.questionFrequency)
}

/** 标准模式的机制说明：提问通道、选项数量与节流。频率档位只决定「什么时候问」。 */
const STANDARD_MECHANICS = [
  'Interactive questions use `yan question ask`. Give at most 3 concrete options (the panel adds a free-text row); one question at a time unless several are truly independent.'
].join('\n')

/**
 * 三档频率对「何时问」的差别。
 *
 * 少问不是不问、多问不是每题都问：它们只调模型收到的指引，不是次数保证。
 */
const FREQUENCY_GUIDANCE = {
  sparse: [
    'Question frequency: SPARSE. Infer a reasonable reading and keep working, stating the assumption in one line; confirm only before a key decision or a risky / hard-to-reverse action.'
  ].join('\n'),
  balanced: [
    'Question frequency: BALANCED (default). Ask when a materially different reading would change the result; do not ask what you can verify yourself.'
  ].join('\n'),
  eager: [
    'Question frequency: EAGER. When several reasonable readings exist, confirm the goal with one short question before executing; never ask every few steps, never re-ask what is already settled, and never force a question onto a simple task.'
  ].join('\n')
}

/**
 * 频率偏好绝不放宽的边界（权限审批、高风险确认、工作模式、用户明确指定）。
 */
const QUESTION_BOUNDARY = [
  'This preference only tunes guidance: it never relaxes approvals, permissions, or high-risk confirmations, and an explicit user instruction to ask (or not to ask) wins over the frequency setting without widening the granted scope.'
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
  '- Give at most 3 concrete options; the panel always offers one row for a typed reply, so the user can write their own answer.',
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

/**
 * 按工作模式与提问频率拼装指引。
 *
 * ⚠️ 工作模式优先：自主档固定「不要问」，不拼接频率（否则会与禁止交互矛盾）；
 * 计划档保留自己的只读约束与「先问关键问题」，频率作为补充。
 */
function guidanceFor(mode, frequency) {
  if (mode === 'autonomous') return AUTONOMOUS_GUIDANCE
  const clause = FREQUENCY_GUIDANCE[normalizeQuestionFrequency(frequency)]
  if (mode === 'clarify') return `${CLARIFY_GUIDANCE}\n${clause}\n${QUESTION_BOUNDARY}`
  return `${STANDARD_MECHANICS}\n${clause}\n${QUESTION_BOUNDARY}`
}

export default function question(pi) {
  // 每轮开始前按当前模式调整系统提示（模式中途切换也能立刻生效）
  pi.on('before_agent_start', (event, ctx) => {
    const mode = currentWorkMode(ctx)
    const frequency = currentQuestionFrequency(ctx)
    noteModeDiagnostic('before_agent_start', mode, frequency)
    const extra = guidanceFor(mode, frequency)
    const base = String(event?.systemPrompt ?? '')
    /* 同时写具名分区：只转发结构化部分的 provider（pi-claude-bridge → Claude Code）会丢掉整段覆盖的文本 */
    const sections = event?.systemPromptOptions?.sections
    if (sections && typeof sections === 'object') sections.inkstone_question = extra
    return { systemPrompt: `${base}\n\n${extra}` }
  })
}
