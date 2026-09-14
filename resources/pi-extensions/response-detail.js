/*
 * 砚内置「回复详细程度」扩展 —— 把界面上的三档偏好变成系统提示。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要单独一个扩展（而不是桌面端自己拼提示）
 * ══════════════════════════════════════════════════════════════════
 *   · 桌面端能控制的只有 `prompt` 的 message 文本，改它等于把偏好
 *     掺进用户消息里（会污染会话记录，也影响缓存指纹）；
 *   · pi 的 `before_agent_start` 是**唯一**合适的注入点：它有 systemPrompt，
 *     且只在每轮开始时跑一次（不会逐 token 改提示）。
 *
 * ── 三档 ──
 *   brief     先给结果、改动摘要与必要验证，减少过程解释
 *   standard  **不加任何东西**（保持原提示不变，缓存前缀不动）
 *   detailed  补充实现取舍、关键步骤、例子与适用边界
 *
 * ⚠️ 三档都不得改变任务完成范围，也不直接调低推理强度 ——
 *    这是「怎么讲」，不是「做多少」。
 * ⚠️ 读文件而不是环境变量：档位可以在会话中途切换，下一轮就生效。
 *    （与 question.js 读 autonomous 同一套做法。）
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function settingsFile() {
  const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
  return join(dir, 'desktop.json')
}

/** 当前档位（读桌面端设置；读不到 / 脏值都当 standard） */
function responseDetail() {
  try {
    const j = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    const v = j?.responseDetail
    return v === 'brief' || v === 'detailed' ? v : 'standard'
  } catch {
    return 'standard'
  }
}

const BRIEF = [
  'Response detail: BRIEF.',
  '- Lead with the result and what changed; keep explanation to the minimum needed to trust it.',
  '- Still report errors, blockers and anything the user must decide.',
  '- Do not change the scope of the task; brevity is about wording, not about doing less.'
].join('\n')

const DETAILED = [
  'Response detail: DETAILED.',
  '- Besides the result, explain the trade-offs behind key choices, the steps that mattered,',
  '  a concrete example where it helps, and the boundaries where the approach applies or does not.',
  '- Still report errors, blockers and anything the user must decide.',
  '- Do not change the scope of the task; detail is about explanation, not about doing more.'
].join('\n')

export default function responseDetailExtension(pi) {
  pi.on('before_agent_start', (event) => {
    const mode = responseDetail()
    /* standard：原样返回（不写 systemPrompt），保持提示与缓存不变 */
    if (mode === 'standard') return
    const base = String(event?.systemPrompt ?? '')
    const extra = mode === 'brief' ? BRIEF : DETAILED
    return { systemPrompt: base ? `${base}\n\n${extra}` : extra }
  })
}
