/**
 * 子代理结束 → 通知父会话的模型。
 *
 * 只做投递决策：向谁投、要不要投。文本格式在 `shared/subagent-notice.ts`。
 *
 * 规则：
 *   · 只通知终态里「模型可能还在等它」的运行：完成与失败。用户手动停止的不通知
 *     （是用户自己按的，模型没有理由被叫醒）；
 *   · 按父会话找运行实例：用户此刻在看别的会话时，通知仍回到发起它的那个会话；
 *     该会话已经关掉（没有实例）就不投，不去唤醒无关会话；
 *   · 空闲时开新一轮、正忙时排队（`send` 的既有语义）；整理上下文等暂不接收的时段
 *     `send` 会拒绝，这里不重试——模型之后仍可以用 `yan subagent list` 查到。
 */
import type { SubagentRun } from '../shared/ipc'
import { buildSubagentNotice } from '../shared/subagent-notice'

export interface NoticeTarget {
  send(text: string, images: undefined, mode: 'followUp'): Promise<{ ok: boolean; error?: string }>
}

export interface SubagentNotifierDeps {
  /** 按稳定会话 id / 运行实例 id 找到父会话的实例 */
  find(run: SubagentRun): NoticeTarget | null
  /** 开关：设置里关闭后不再自动唤醒模型 */
  enabled(): boolean | Promise<boolean>
}

export function createSubagentNotifier(deps: SubagentNotifierDeps): (run: SubagentRun) => void {
  return (run) => {
    if (run.status !== 'done' && run.status !== 'error') return
    void (async () => {
      if (!(await deps.enabled())) return
      /* 开关读盘期间会话可能关了：投递前再找一次 */
      const target = deps.find(run)
      if (!target) return
      await target.send(buildSubagentNotice(run), undefined, 'followUp')
    })().catch(() => undefined)
  }
}
