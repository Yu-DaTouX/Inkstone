/*
 * 砚内置「界面语言 → 推理/回复语言」扩展。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不用 `--append-system-prompt`（原来的做法）
 * ══════════════════════════════════════════════════════════════════
 *   · 那个 flag 是**进程启动时**固定的：同一个工作目录下的新会话会复用
 *     已有 pi 进程，所以「切了界面语言」和「模型换语言」之间隔着一整个
 *     进程生命周期；
 *   · 为了让它生效只能在切语言时**重建 pi 实例**（restartAgent）——
 *     代价是把所有后台会话一起掐掉，还会让界面短暂失去当前会话的历史（D37）。
 *
 * `before_agent_start` / `before_provider_request` 是每轮都会跑的钩子，
 * 于是切语言**下一轮就生效**（不必重建实例），历史会话与新会话一视同仁。
 * 设置读取方式与 `response-detail.js` 一致（读 desktop.json，不读环境变量）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要写两个钩子（实测数据，别删掉第二个）
 * ══════════════════════════════════════════════════════════════════
 * 只往系统提示**末尾**追加时，这句话会落在 11k 字符提示的最后 60 个字符里 ——
 * 实测模型**不服从**（界面英文、用户中文提问，回复仍是中文；推理里也看不到
 * 这条要求）。而同样的句子交给 `--append-system-prompt`（位置在提示**前部**，
 * 约 1900 字符处）时模型服从。换成「贴近用户消息的一条独立 developer 消息」后，
 * 实测 2/2 服从。所以默认仍然走这条路径；但本地 llama.cpp 的 Qwen chat
 * template 只允许开头出现 system 消息，不接受历史中间再插 system。对明确
 * 标成 `local` 的 provider，改为把同一句追加到最后一条 user 内容，保持消息
 * 形状合法，同时仍然贴近当前问题。
 *
 * 所以：
 *   · ① `before_provider_request`：在最后一条用户消息**前面**插一条独立消息
 *        （主通道，位置最强，且不动提示前缀，缓存友好）；
 *   · ② `before_agent_start`：仍把同一句追加到系统提示末尾
 *        （保底：payload 结构不认识的 provider 也还有这一份）。
 * 两处是**同一句话**，不是两条要求 —— 边界仍是「界面语言只由这一句约束」。
 *
 * ── 边界（用户明确要求，别扩写）──
 *   · 只有**一句**：界面语言决定「推理与回复用哪种语言」，不多不少；
 *   · 不注入「必须用某种语言思考」之外的任何语言要求，也不改写模型返回的原文；
 *   · 语言不受用户消息语言影响（中文界面用英文提问也要中文回）。
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function settingsFile() {
  const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
  return join(dir, 'desktop.json')
}

/** 界面语言（读不到 / 认不出就当没有要求，绝不猜一种语言强加给模型） */
function language() {
  try {
    const j = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    const v = j?.lang
    return v === 'zh-CN' || v === 'en-US' ? v : null
  } catch {
    return null
  }
}

/**
 * 界面语言 → 一句指令。
 *
 * 与桌面端本来那份措辞保持一致：**推理（思考过程）**也要跟随界面语言
 * （用户报过：回复是中文，但推理过程还是英文）。
 */
export function languageSystemPrompt(lang) {
  if (lang === 'zh-CN') {
    return '推理（思考过程）与回复都必须使用简体中文：即使用户用其他语言提问、工具结果是英文，思考过程里也不要改用英文。'
  }
  if (lang === 'en-US') {
    return 'Both your reasoning (the thinking process) and the final reply must be in English: do not switch language inside the thinking process, even if the user writes in another language or tool output is in Chinese.'
  }
  return null
}

/**
 * 诊断钩子：`YAN_LANG_EXT_LOG` 指向一个文件时，每次注入写一行 JSON。
 * 排查「注入到底有没有发生」用它，比问模型靠不靠谱（也用于 live 探针取证）。
 */
function trace(hook, extra) {
  const file = process.env.YAN_LANG_EXT_LOG
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify({ ts: Date.now(), hook, ...extra }) + '\n')
  } catch {
    /* 写不进去不影响注入本身 */
  }
}

export default function languageExtension(pi) {
  /** 在最后一条 user 消息前插一条独立消息（位置最强，见文件头实测说明） */
  pi.on('before_provider_request', (event, ctx) => {
    const payload = event?.payload
    const messages = payload?.messages
    if (!payload || !Array.isArray(messages) || messages.length === 0) return

    const text = languageSystemPrompt(language())
    if (!text) {
      trace('payload', { lang: language(), injected: false, count: messages.length })
      return
    }

    let at = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        at = i
        break
      }
    }
    if (at < 0) return
    /*
     * 角色跟着该 provider 已经在用的写法：pi 会把 system 映射成 developer
     * （openai 系新模型只认 developer），照抄第一个系统角色的写法最安全。
     */
    if (ctx?.model?.provider === 'local') {
      trace('payload', { lang: language(), injected: true, at, count: messages.length, role: 'inline-user' })
      const current = messages[at]
      const suffix = `\n\n${text}`
      const content = current?.content
      const nextContent =
        typeof content === 'string'
          ? `${content}${suffix}`
          : Array.isArray(content)
            ? [...content, { type: 'text', text: suffix }]
            : `${String(content ?? '')}${suffix}`
      const next = messages.map((message, index) => (index === at ? { ...message, content: nextContent } : message))
      return { ...payload, messages: next }
    }
    const already = messages.find((m) => m?.role === 'system' || m?.role === 'developer')?.role
    const role = already === 'system' || already === 'developer' ? already : 'system'
    /* 诊断只记位置 / 角色 / 条数，不写提示或推理原文 */
    trace('payload', { lang: language(), injected: true, at, count: messages.length, role })
    const next = [...messages.slice(0, at), { role, content: text }, ...messages.slice(at)]
    return { ...payload, messages: next }
  })

  pi.on('before_agent_start', (event) => {
    const text = languageSystemPrompt(language())
    trace('start', { lang: language(), injected: !!text, baseLen: String(event?.systemPrompt ?? '').length })
    if (!text) return
    const base = String(event?.systemPrompt ?? '')
    return { systemPrompt: base ? `${base}\n\n${text}` : text }
  })
}
