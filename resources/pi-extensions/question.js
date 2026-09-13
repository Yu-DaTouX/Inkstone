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
 * ── 自主模式 ──
 * 用户要求「在输入框下加一个自主模式，打开后不再提疑问」。
 * 扩展每次读取桌面端设置（desktop.json 的 `autonomous`）：
 *   · 开启时：before_agent_start 往系统提示里追加「自己决策、不要提问」；
 *     即使模型仍然调用了 question 工具，execute 也直接返回「请自行决定」，不弹窗。
 * 读取文件而不是环境变量：模式可以在会话中途切换，下一轮就生效。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function settingsFile() {
  const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
  return join(dir, 'desktop.json')
}

/** 自主模式是否开启（读桌面端设置；读不到就当关） */
function isAutonomous() {
  try {
    const j = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    return j?.autonomous === true
  } catch {
    return false
  }
}

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function textResult(text, details = {}) {
  return { content: [{ type: 'text', text }], details }
}

/** 鼓励在模糊时提问（自主模式关闭时追加到系统提示） */
const ASK_GUIDANCE = [
  'Interactive questions:',
  '- If a request is genuinely ambiguous, or you are about to guess at a choice that materially changes the result, call the `question` tool and ask BEFORE doing the work.',
  '- Ask only when the answer changes what you build; do not ask about trivia or things you can verify yourself.',
  '- Give 2-4 concrete options. The user can also pick the custom/typed answer.',
  '- Keep it to one question at a time unless several are truly independent.'
].join('\n')

/** 自主模式：别问，自己拿主意（追加到系统提示） */
const AUTONOMOUS_GUIDANCE = [
  'Autonomous mode is ON:',
  '- Do NOT ask the user questions, and do NOT call the `question` tool.',
  '- Make a sensible assumption, state it in one line, and carry the task through to completion.',
  '- Prefer reversible choices when several options are plausible.'
].join('\n')

const CUSTOM_LABEL = '其他（自行输入） / Other (type your own)'

export default function question(pi) {
  // 每轮开始前按当前模式调整系统提示（模式中途切换也能立刻生效）
  pi.on('before_agent_start', (event) => {
    const extra = isAutonomous() ? AUTONOMOUS_GUIDANCE : ASK_GUIDANCE
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
      if (isAutonomous()) {
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
