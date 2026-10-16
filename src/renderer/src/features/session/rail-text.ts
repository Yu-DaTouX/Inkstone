/**
 * 会话导航轨与停滞卡的自有文案（v3 WP-21b / WP-23b）。
 *
 * 为什么不复用两份 i18n：任务边界把 i18n 列为并发代理热点，这里不占用。
 * 轨道标题沿用正式 i18n 的 `outline.label` / `outline.tick`（v2 已在用），
 * 停滞说明卡是 v3 新增，先放在本文件；等迁移统一后再并入正式 i18n。
 */
import type { RunPhase } from '../../../../shared/runs'
import { formatDuration, phaseDetail, phaseWord, type RunLang } from '../../state/runs-v3'

export interface RailText {
  /** 停滞说明卡标题 */
  stalledTitle: string
  /** 可用动作：停止 */
  stop: string
  /** 停滞只是提示，不自动续跑 / 不自动停止 */
  autoNote: string
  /** 带倒计时的自动重试：「{s} 后重试」 */
  retryIn: string
  /** 已停滞时长：「已停滞 {s}」 */
  stalledFor: string
}

const ZH: RailText = {
  stalledTitle: '运行停滞',
  stop: '停止',
  autoNote: '停滞只是更早的可见信号，不会自动续跑或停止；是否继续由你决定。',
  retryIn: '{s} 后重试',
  stalledFor: '已停滞 {s}'
}

const EN: RailText = {
  stalledTitle: 'Run stalled',
  stop: 'Stop',
  autoNote: 'Stalling is only an early signal. Nothing auto-resumes or stops; the next step is yours.',
  retryIn: 'retrying in {s}',
  stalledFor: 'stalled for {s}'
}

export function railText(lang: string): RailText {
  return lang === 'en-US' ? EN : ZH
}

function fill(template: string, vars: Record<string, string>): string {
  let out = template
  for (const [name, value] of Object.entries(vars)) out = out.split(`{${name}}`).join(value)
  return out
}

/** 停滞卡要展示的「原因 / 详情 / 计时」，全部来自运行快照的 phase 与已有文案函数。 */
export interface StallReason {
  /** 阶段短词：无响应 / 工具无输出 / 重试中 / 限流等待 / 重复输出 */
  word: string
  /** 结构化详情：重试次数、工具名、循环中止说明等；没有就 null */
  detail: string | null
  /** 计时行：自动重试优先显示倒计时，否则显示已停滞时长 */
  timing: string
}

/**
 * 纯函数：把 `stalled` 阶段翻译成卡片文案。非停滞阶段返回 null。
 * 只读快照，不做任何停止 / 续跑动作。
 */
export function stallReason(lang: RunLang, phase: RunPhase, now: number): StallReason | null {
  if (phase.kind !== 'stalled') return null
  const text = railText(lang)
  const resumeAt = phase.retry?.resumeAt
  const timing =
    resumeAt !== undefined && resumeAt > now
      ? fill(text.retryIn, { s: formatDuration(resumeAt - now, lang) })
      : fill(text.stalledFor, { s: formatDuration(Math.max(0, now - phase.since), lang) })
  return { word: phaseWord(lang, phase), detail: phaseDetail(lang, phase), timing }
}
