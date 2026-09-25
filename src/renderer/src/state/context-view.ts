import type { ContextNextStage, ContextOperationKind } from '../../../shared/ipc'
import type { TFunc } from '../i18n'

/**
 * 上下文工作集（N21-3）→ 界面文案。
 *
 * 为什么单独一个纯模块：这里有三件必须钉死、又不能靠截图发现的事 ——
 *   ① **未接管的阶段不许写成会触发**：阶段 3 只有 `compaction` 真的执行，
 *      清理 / 折叠是阶段 4 的事。「下一步」那行只能预报真的会发生的事，
 *      否则就是在界面上展示一套没有生效的策略（正是批注第 1 点要避免的错）。
 *   ② 阶段名与阶段种类的映射只有一处（`tool-sweep` → 「清理」），
 *      拼错会静默显示成空白。
 *   ③ 「约 168k 时」这类数字必须由工作集预算算出来，不能各写各的。
 */

/** 三个阶段在界面上的顺序（与工作集刻度的先后一致） */
export const CONTEXT_STAGES: readonly ContextOperationKind[] = [
  'tool-sweep',
  'episode-fold',
  'compaction'
]

/** `1596 → 1.6k`、`160000 → 160k`：不假装比上游更精确 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`
}

export function contextStageLabel(t: TFunc, kind: ContextOperationKind): string {
  if (kind === 'tool-sweep') return t('ctx.stageSweep')
  if (kind === 'episode-fold') return t('ctx.stageFold')
  if (kind === 'compaction') return t('ctx.stageCompact')
  return t('ctx.stageRecall')
}

/** 这个阶段具体做了什么（悬停说明里的那一句） */
export function contextStageWhat(t: TFunc, kind: ContextOperationKind): string {
  if (kind === 'tool-sweep') return t('ctx.stageWhatSweep')
  if (kind === 'episode-fold') return t('ctx.stageWhatFold')
  if (kind === 'compaction') return t('ctx.stageWhatCompact')
  return t('ctx.stageWhatRecall')
}

/**
 * 阶段刻度的悬停说明。
 *
 * 为什么把「是什么」和「什么时候」写在一句里：光写「工作集 70% 处」只回答了位置，
 * 用户真正想知道的是 **这个阶段会拿我的上下文干什么**（用户看到三个虚线格子就是这么问的）。
 * 未接管的阶段额外说清「现在不会触发」—— 不能让人以为它已经开始动上下文了。
 */
export function contextStageTip(
  t: TFunc,
  kind: ContextOperationKind,
  opts: { at: number; ratio: number; active: boolean }
): string {
  const name = contextStageLabel(t, kind)
  const what = contextStageWhat(t, kind)
  const pct = Math.max(0, Math.round(opts.ratio * 100))
  return opts.active
    ? t('ctx.stageTip', { name, what, pct, n: formatTokens(opts.at) })
    : t('ctx.stagePlannedTip', { name, what, pct })
}

/**
 * 「约 240k 时压缩上下文」。
 *
 * 时间放**前面**（用户 2026-09-25）：原来写「下一步：压缩上下文（约 240k 时）」，
 * 右栏拖到最窄时这一行会被折成两行，“下一步”和括号里那个时间各自占一行。
 * 前置数字后一句话就是一件事，窄栏下也能一次读完。
 *
 * 已经过线时**不报数字**（“约 240k 时”在人已经站在线上的时候是废话），
 * 改说“已达工作集上限”。
 */
export function nextContextStageText(t: TFunc, stage: ContextNextStage): string {
  if (stage.reached) return t('ctx.nextReached', { name: contextStageLabel(t, stage.kind) })
  if (stage.kind === 'tool-sweep') return t('ctx.nextSweep', { n: formatTokens(stage.at) })
  if (stage.kind === 'episode-fold') return t('ctx.nextFold', { n: formatTokens(stage.at) })
  if (stage.kind === 'compaction') return t('ctx.nextCompact', { n: formatTokens(stage.at) })
  return contextStageLabel(t, stage.kind)
}
