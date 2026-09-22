/*
 * 砚内置「提问」扩展 —— 让模型在信息不足时主动问用户。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是扩展（而不是桌面端自己造）
 * ══════════════════════════════════════════════════════════════════
 * pi 的「问答」能力来自扩展：扩展用 `ctx.ui.select/input/confirm` 提问，
 * 在 RPC 模式下 pi 把调用转成 `extension_ui_request`（stdout），宿主按
 * 同一个 id 回 `extension_ui_response`（stdin），等待中的 Promise 随之完成。
 * 砚的渲染端（components/shell/UiBridge.tsx）已经把 select/input/confirm/editor
 * 渲染成模态框，所以这里只要注册一个工具、调 ctx.ui.* 即可，无需改 RPC 协议。
 *
 * 参考：pi 官方仓库的 examples/extensions/question.ts（TUI 专用，用
 * ctx.ui.custom；RPC 模式用不了）。这里改用 ui.select/ui.input，RPC 兼容。
 *
 * ── 工作模式（实施-05）──
 * 提问行为由**会话级工作模式**决定（标准 / 澄清 / 自主），不再是全局布尔。
 * 宿主在每次推送 / 切换会话时把该实例的模式写到
 * `YAN_DATA_DIR/work-mode/<YAN_SESSION_ID>.json`（`YAN_SESSION_ID` 就是宿主注入的
 * 运行实例 id）。扩展每轮读它：
 *   · 自主   → before_agent_start 追加「自己决策、不要提问」，execute 也不弹窗；
 *   · 澄清   → 追加「先把目标问清」，弹窗照常；
 *   · 标准   → 追加「模糊时先问」，弹窗照常。
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
 * 为什么要它：「模式真的到达扩展了吗」在界面上看不出来 —— 模型不弹窗
 * 可能是扩展拦住了，也可能是模型自己没问。落一行 `{hook,mode,sessionId,file}`
 * 能把两种情形分开（与 `language.js` / `project-knowledge.js` 同一做法）。
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

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function textResult(text, details = {}) {
  return { content: [{ type: 'text', text }], details }
}

/** 标准模式：模糊时先问（改动前的默认行为） */
const STANDARD_GUIDANCE = [
  'Interactive questions:',
  '- If a request is genuinely ambiguous, or you are about to guess at a choice that materially changes the result, call the `question` tool and ask BEFORE doing the work.',
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
  '- This mode is READ-ONLY: writing tools (write / edit / task updates) are disabled, and bash only accepts `yan goal status|ready|report …` — nothing else, no shell operators.',
  '- Once the goal, deliverable, scope, constraints and acceptance criteria are all settled and nothing material is left open, submit it exactly once with `yan goal ready` using **inline arguments** (run `yan goal --help` for the shape) — you cannot write a request file in this mode. The mode switches to standard automatically; the NEXT turn can make changes.',
  '- Never claim work is finished in this mode: you cannot change anything yet.'
].join('\n')

/** 自主模式：别问，自己拿主意（追加到系统提示） */
const AUTONOMOUS_GUIDANCE = [
  'Autonomous mode is ON:',
  '- Do NOT ask the user questions, and do NOT call the `question` tool.',
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

const CUSTOM_LABEL = '其他（自行输入） / Other (type your own)'

export default function question(pi) {
  // 每轮开始前按当前模式调整系统提示（模式中途切换也能立刻生效）
  pi.on('before_agent_start', (event) => {
    const mode = currentWorkMode()
    noteModeDiagnostic('before_agent_start', mode)
    const extra = guidanceFor(mode)
    const base = String(event?.systemPrompt ?? '')
    return { systemPrompt: `${base}\n\n${extra}` }
  })

  pi.registerTool({
    name: 'question',
    label: 'Question',
    description:
      'Ask the user a question when a request is ambiguous and you need a decision to proceed. Use this before guessing. The user picks one of your options or types a custom answer.',
    parameters: schema(
      {
        question: { type: 'string', description: 'The question to ask the user' },
        options: {
          type: 'array',
          description: 'Options for the user to choose from (2-4 recommended)',
          items: schema(
            {
              label: { type: 'string', description: 'Display label for the option' },
              description: { type: 'string', description: 'Optional one-line explanation' }
            },
            ['label']
          )
        }
      },
      ['question', 'options']
    ),
    // 同一轮里多个问题必须顺序问，否则弹窗会互相覆盖（官方 question 示例也这么定）
    executionMode: 'sequential',

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const question = String(params?.question ?? '').trim()
      const options = Array.isArray(params?.options) ? params.options : []
      const labels = options.map((o) => String(o?.label ?? '')).filter(Boolean)

      const details = { question, options: labels, answer: null, wasCustom: false }

      // 自主模式：不问，让模型自己决定（这是「不向用户提出疑问」的兜底）
      const mode = currentWorkMode()
      noteModeDiagnostic('execute', mode)
      if (mode === 'autonomous') {
        return textResult(
          'Autonomous mode is ON: the user does not want to be asked. Choose a sensible default, state the assumption briefly, and continue.',
          { ...details, autonomous: true }
        )
      }

      // 没有 UI（理论上不会走到：桌面端始终有）——不要挂起，直接让模型自己决定
      if (!ctx?.hasUI || typeof ctx.ui?.select !== 'function') {
        return textResult('No interactive UI is available; make a reasonable assumption and continue.', details)
      }

      let answer = null
      let wasCustom = false

      try {
        if (labels.length === 0) {
          // 没有选项 → 纯文本输入
          const typed = await ctx.ui.input(question || '请输入', '输入你的答案')
          if (typeof typed === 'string' && typed.trim()) {
            answer = typed.trim()
            wasCustom = true
          }
        } else {
          const picked = await ctx.ui.select(question || '请选择', [...labels, CUSTOM_LABEL])
          if (picked === undefined) {
            // 用户取消：明确告诉模型，让它自己决定（而不是空着卡住）
            return textResult('The user cancelled the question. Make a reasonable assumption and continue.', details)
          }
          if (picked === CUSTOM_LABEL) {
            const typed = await ctx.ui.input(question || '请输入', '输入你的答案')
            if (typeof typed === 'string' && typed.trim()) {
              answer = typed.trim()
              wasCustom = true
            }
          } else {
            answer = picked
          }
        }
      } catch (error) {
        return textResult(
          `Asking the user failed (${error?.message || error}). Make a reasonable assumption and continue.`,
          details
        )
      }

      if (answer == null) {
        return textResult('The user did not provide an answer. Make a reasonable assumption and continue.', details)
      }

      const text = wasCustom
        ? `User wrote: ${answer}`
        : `User selected: ${answer}`
      return textResult(text, { ...details, answer, wasCustom })
    }
  })
}
