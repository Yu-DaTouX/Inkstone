/**
 * v3 提交归属的纯逻辑（D1 / D2 / D5 / D6）。
 *
 * 为什么单独提出来：这些判定跨在 Composer 的 React 生命周期和 store 的
 * await 边界两侧，散在组件里没法在 Node 里验证。「视图身份优先于已激活
 * 会话」「只清本次提交的附件」「本地命令是否需要先激活」都只依赖入参，
 * 放这里既能被生产代码共用，也能被隔离测试直接钉住。
 */
import { viewIdentityOf } from '../state/view-identity'

/** 只取提交归属需要的字段，避免依赖整个 Store 类型。 */
export interface SubmitOwnershipState {
  /** 正在看、但可能还没在 pi 侧激活的会话（视图身份的第一来源）。 */
  peekedSessionId: string | null
  /** 视图先铺上的会话文件；path-only 时必须与 id 成对取值，不能拿旧会话补。 */
  peekedPath?: string | null
  /** 已激活的会话投影；peek 窗口里它可能仍是上一条。 */
  session: { sessionId?: string } | null
}

/**
 * 一次提交应该归属哪条会话。
 *
 * `peekedSessionId` 是「屏幕已经铺上的目标身份」，优先级高于尚未跟上的
 * `session` 投影 —— 否则在「点开 B、还没激活」的窗口里会把消息/来源
 * 记到旧的 A 头上（D5 的提交侧、D6 的来源 id）。
 *
 * peek 存在（id 或路径）时成对只取 peek：path-only 的 B 身份未知，宁可
 * 返回 null（调用方据此不登记来源 / 等激活），也不能退回旧会话 A。
 */
export function viewingSubmitSessionId(state: SubmitOwnershipState): string | null {
  return viewIdentityOf({
    peekedSessionId: state.peekedSessionId,
    peekedPath: state.peekedPath ?? null,
    session: state.session
  }).sessionId
}

/**
 * 成功后要保留的附件列表：只移除**本次真正提交**的那些 id。
 *
 * 发送在途时用户仍可粘贴/拖入新附件；整批 `clearAttachments()` 会把它们
 * 一起吞掉且没有提示（D1）。按 id 过滤与失败恢复的并集写法对称。
 */
export function attachmentsAfterSubmit<T extends { id: string }>(
  current: readonly T[],
  sentIds: readonly string[]
): T[] {
  if (sentIds.length === 0) return current as T[]
  const sent = new Set(sentIds)
  const next = current.filter((item) => !sent.has(item.id))
  return next.length === current.length ? (current as T[]) : next
}

/** 会落到「当前激活实例」上的 yan 内置命令。 */
const INSTANCE_COMMANDS = new Set(['model', 'thinking', 'compact', 'clone'])

/**
 * 这条本地命令是否必须先保证「正在看的会话」已激活。
 *
 * `!`（bash）在实例的工作目录里执行，`/model` `/thinking` `/compact` `/clone`
 * 改的/读的也是当前实例。切换在途或激活失败时不能落到旧会话（D2）。
 * `/settings` `/login` `/browser` 这类纯界面动作不在此列，不该被切换状态挡住。
 */
export function localCommandNeedsActivatedTarget(raw: string): boolean {
  const text = raw.trimStart()
  if (text.startsWith('!')) return true
  const name = /^\/([^\s]+)/.exec(text)?.[1]?.toLowerCase()
  return !!name && INSTANCE_COMMANDS.has(name)
}

export interface LocalCommandGuardPort {
  /** 未 trim 的输入原文（`!` 判据与 composer-submit 一致）。 */
  raw: string
  /** 保证「正在看的会话」已激活；失败返回 false。 */
  ensureActivated: () => Promise<boolean>
  /** 真正执行本地命令（内部才会清文字/附件）。 */
  run: () => Promise<void> | void
  /** 安全失败时的提示；此时草稿必须原样保留。 */
  notifyBlocked: () => void
}

/**
 * 带激活守卫地执行一条本地命令。
 *
 * 激活失败或切换在途时**不调用 `run`**：调用方（`submitComposerInput`）
 * 会在 `run` 内部清文字，所以守卫必须在它之前，失败时草稿不动。
 */
export async function runLocalCommandGuarded(port: LocalCommandGuardPort): Promise<'ran' | 'blocked'> {
  if (localCommandNeedsActivatedTarget(port.raw)) {
    const activated = await port.ensureActivated()
    if (!activated) {
      port.notifyBlocked()
      return 'blocked'
    }
  }
  await port.run()
  return 'ran'
}
