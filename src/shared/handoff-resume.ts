/**
 * 交接「续接消息」的正文与消费证据（实施-05 S5b-3b）。
 *
 * ══════════════════════════════════════════════════════════
 * 它守的是什么
 * ══════════════════════════════════════════════════════════
 * §8 第 5 条要求「用 `resumeId` 发送一次，JSONL 消费证据确认 `resumed`」。
 * 这句话拆成两件互相对账的事，而它们**必须由同一份定义**：
 *
 *   · 发出去的正文里要有一个**稳定、唯一、可搜**的标记（`resumeId`）——
 *     否则「发过了」这件事在磁盘上不可判（重启后只能瞎猜，或者重发一遍）；
 *   · 判「已经发过」时按**同一个标记**在目的会话文件里找（`hasResumeEvidence`）——
 *     标记写法一变，两边就对不上，表现为「明明发过了却每次重启都重发」。
 *
 * ── 为什么正文只带交接包，不带历史 ──
 *   §8 明写「**不**把全部历史重新灌进新会话」。目的会话要的是「接着干什么」，
 *   不是「之前发生过什么」；把历史灌进去会让交接重新付出一次它本想省下的上下文。
 *
 * ── 为什么标记要独占一行 ──
 *   证据检测是**字符串包含**（会话文件可能很大，逐行 JSON.parse 不值得）。
 *   独占一行可以让它在任何一次 grep / 日志里都自证身份，也让替换检测不会
 *   误命中模型自己复述出来的同一串（模型复述时会连带那段空白与换行）。
 */

import type { HandoffPackage } from './handoff'

/** 标记前缀（`[yan-handoff-resume:<id>]`）。改它等于让已有证据全部失效。 */
export const RESUME_ID_TAG = 'yan-handoff-resume'

/** 续接消息里给模型的角色说明（一句话，不夹带语言 / 风格要求）。 */
const RESUME_HEADER = '这是一个**跨会话交接**：上面的对话换了新会话继续，下面是上一个会话留下的交接包。'

const RESUME_FOOTER =
  '请按交接包**继续推进**，不要重新确认已经确认过的信息、不要重做已经完成的部分；先做接下来该做的事。\n' +
  '接手后先跑一次 `yan goal status` 看当前 revision（宿主已经把目标与验收标准带过来了），' +
  '再用 `yan goal report` 把**这一段的**进展与证据登记上 —— 交接包里写的进度是上一段的复述，' +
  '不能当作新的完成证据。'

/** `resumeId` 的标记行（证据检测认这一行）。 */
export function resumeMarker(resumeId: string): string {
  return `[${RESUME_ID_TAG}:${String(resumeId ?? '').trim()}]`
}

function bullet(label: string, items: string[]): string[] {
  if (!items.length) return []
  return [`${label}：`, ...items.map((item) => `- ${item}`)]
}

/**
 * 构造发给目的会话的第一条消息正文。
 *
 * 只带交接包的内容栏；`source*` / `generatedAt` 这些宿主填的元数据不进正文
 * （它们对模型没有意义，只会占 token）。
 */
export function buildResumeText(pkg: HandoffPackage | null | undefined, resumeId: string): string {
  const id = String(resumeId ?? '').trim()
  const lines: string[] = [RESUME_HEADER, '', resumeMarker(id)]
  if (pkg) {
    lines.push('', `用户目标：${pkg.goal}`, `交付物：${pkg.deliverable}`)
    lines.push(...bullet('约束与授权', pkg.constraints))
    lines.push(...bullet('验收标准', pkg.acceptance))
    lines.push(...bullet('已经完成（有证据）', pkg.done))
    lines.push(...bullet('未完成 / 失败与原因', pkg.remaining))
    lines.push(...bullet('下一步', pkg.nextActions))
    lines.push(...bullet('阻塞', pkg.blockers))
    lines.push(...bullet('涉及的文件', pkg.files))
    lines.push(...bullet('其它说明', pkg.notes))
  } else {
    /* 没有包时**不静默造一份空包**：正文如实说明，模型会自己重新问一遍 */
    lines.push('', '（这次交接没有留下交接包，请从当前工作目录看出该做什么，必要时向用户确认。）')
  }
  lines.push('', RESUME_FOOTER)
  return lines.join('\n')
}

/**
 * 目的会话文件里有没有「这条 resume 已经发出去」的证据。
 *
 * 判据是字符串包含（`rawText` 是会话文件原文）：会话文件可能几十 MB，
 * 为了一个标记整份 JSON.parse 不值得。标记独占一行且带有 id，
 * 误判的概率来自「模型把这一行原样复述进会话」—— 那种情况也确实是证据
 * （说明这条消息已经在会话里了），不算误判。
 */
export function containsResumeEvidence(rawText: unknown, resumeId: string): boolean {
  const text = typeof rawText === 'string' ? rawText : ''
  const marker = resumeMarker(resumeId)
  if (!text || marker === `[${RESUME_ID_TAG}:]`) return false
  return text.includes(marker)
}

/**
 * 在会话文件文本里判「续行之后**真的跑起来了**」（实施-15 A-3 / 审核 R6）。
 *
 * 与 `containsResumeEvidence` 的差别就是「已投递」与「已运行」：
 * 标记行是宿主拼的本地文本（写文件不需要模型参与），而助手输出只能由模型产生 ——
 * 所以看标记**之后**有没有 `"role":"assistant"`。
 */
export function hasRunStartedAfterMarker(rawText: unknown, resumeId: string): boolean {
  const text = typeof rawText === 'string' ? rawText : ''
  const marker = resumeMarker(resumeId)
  if (!text || marker === `[${RESUME_ID_TAG}:]`) return false
  const at = text.indexOf(marker)
  if (at < 0) return false
  return /"role"\s*:\s*"assistant"/.test(text.slice(at + marker.length))
}

/**
 * 从消息列表里判证据（探针 / 诊断用；主进程走 `containsResumeEvidence`）。
 *
 * 认两种角色：
 *   · `user` —— 旧链路（宿主 `agent.send`）留下的记录，只读识别，不再产生；
 *   · `custom` —— 实施-14 F4 之后的薄层控制消息（`yan-handoff-resume`）。
 * 助手 / 工具的复述不算。
 */
export function hasResumeEvidence(
  messages: { role?: string; text?: unknown; content?: unknown }[],
  resumeId: string
): boolean {
  const marker = resumeMarker(resumeId)
  if (!resumeId || marker === `[${RESUME_ID_TAG}:]`) return false
  return messages.some((message) => {
    if (message?.role !== 'user' && message?.role !== 'custom') return false
    const body =
      typeof message.text === 'string'
        ? message.text
        : typeof message.content === 'string'
          ? message.content
          : ''
    return body.includes(marker)
  })
}

/** 一行预览（界面 / 诊断）。 */
export function resumePreview(text: string, limit = 160): string {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}
