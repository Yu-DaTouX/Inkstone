/**
 * 主进程侧的上下文策略入口（N21-3）。
 *
 * 纯逻辑（预算公式、触发决策、阶段挑选）在 `src/shared/context-policy.ts` ——
 * 判定与显示必须是同一套规则，所以它不能只住在主进程里。
 * 这里只放**需要主进程环境**的那一件事：把 `YAN_CONTEXT_POLICY` 读成策略。
 *
 * 为什么要 env 覆盖：策略的真实触发要求上下文涨到工作集（默认 240k），
 * 那是几十万 token 的额度。测试把 `workingSetCap` 调到一两千，
 * 就能用一次普通回合走完「过线 → 调 compact() → 记录来源」这条真路径
 * （与 N21-2 把 `reserveTokens` 调到比窗口还大是同一个手法）。
 * 参数写错一律退回默认值，不会让预算变成 NaN。
 */
import { DEFAULT_CONTEXT_POLICY, policyFrom } from '../shared/context-policy'
import type { ContextPolicy } from '../shared/ipc'

let cachedRaw: string | null = null
let cached: ContextPolicy = DEFAULT_CONTEXT_POLICY

/**
 * 当前生效的策略。
 *
 * 按原始字符串记忆化：env 在进程内变了（测试会改）能立刻跟上，
 * 又不会每帧重新 JSON.parse。
 */
export function activeContextPolicy(env: NodeJS.ProcessEnv = process.env): ContextPolicy {
  const raw = env.YAN_CONTEXT_POLICY ?? ''
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cached = policyFrom(raw)
  }
  return cached
}
