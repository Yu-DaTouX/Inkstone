/**
 * 子 Agent worktree 结果处置的纯逻辑（WP-27b）。
 *
 * 只做判定与取数，不碰 React / DOM：
 *   · `subagentReviewGate` 决定「这条运行现在能不能处置、能做什么」——
 *     只有隔离 worktree 的终态结果、且带归档补丁时才画查看差异 / 采纳；
 *     放弃只要求工作树仍在，不依赖补丁是否读得出来；
 *   · `loadSubagentPatch` 经正式只读文件接口读取宿主归档的真实补丁文本，
 *     交给 v3 `DiffView` 渲染。补丁路径来自这条运行自己的 `run.diff.patchPath`，
 *     不取当前前台会话，也不按会话重指向。
 *
 * 处置动作本身（merge / discard）仍走既有 store / 后端契约，本模块不新造授权。
 */
import type { SubagentRun } from '../../../../shared/ipc'

/** 可处置的两种动作；与后端 `merge` / `discard` 一一对应。 */
export type SubagentReviewAction = 'merge' | 'discard'

/** 不能处置时给界面 / 测试的一句可判定原因。 */
export type SubagentReviewBlock =
  | 'not-worktree'
  | 'running'
  | 'no-worktree'
  | 'nothing-to-review'
  | 'no-patch'

export interface SubagentReviewGate {
  /** 至少有一种可处置动作 */
  canReview: boolean
  /** 归档补丁可读，能查看差异并采纳 */
  canPatch: boolean
  /** 工作树仍在，能明确放弃（补丁归档保留） */
  canDiscard: boolean
  /** 不能处置的原因；可处置时为 null */
  blocked: SubagentReviewBlock | null
}

/** 只用到运行快照里与处置有关的那几项，便于测试直接造对象。 */
export type ReviewableRun = Pick<SubagentRun, 'isolation' | 'review' | 'status' | 'diff'>

/**
 * 处置闸门。规则与后端一致：
 *   · 只认 `worktree` 隔离；受控只读目录 / 共享目录没有可采纳的隔离结果；
 *   · 运行仍在 `starting` / `running` 时不能动（后端也会拒绝）；
 *   · `pending` / `conflict` 才是待审阅；已 `archived` 的工作树在退出时已清理，
 *     本批不凭归档补丁再开一个「伪工作树」入口（补丁仍可经 v2「打开补丁」找回）；
 *   · 采纳要求归档补丁存在且确有文件；放弃只要求工作树还在。
 */
export function subagentReviewGate(run: ReviewableRun): SubagentReviewGate {
  const worktree = run.isolation === 'worktree'
  const running = run.status === 'starting' || run.status === 'running'
  const reviewing = run.review === 'pending' || run.review === 'conflict'
  const files = run.diff?.files ?? 0
  const canPatch = worktree && !running && reviewing && !!run.diff?.patchPath && files > 0
  const canDiscard = worktree && !running && reviewing
  const canReview = canPatch || canDiscard
  let blocked: SubagentReviewBlock | null = null
  if (!canReview) {
    if (!worktree) blocked = 'not-worktree'
    else if (running) blocked = 'running'
    else if (!reviewing) blocked = run.review === 'archived' ? 'no-worktree' : 'nothing-to-review'
    else blocked = 'no-patch'
  } else if (!canPatch) {
    /* 还能放弃，但补丁不可用：界面据此说明「无可读补丁」而不画采纳。 */
    blocked = 'no-patch'
  }
  return { canReview, canPatch, canDiscard, blocked }
}

export interface SubagentPatch {
  patch: string
  /** 超过宿主 2MB 文本上限，只读到前一段 */
  truncated: boolean
}

/** `loadSubagentPatch` 需要的宿主只读文件接口（`window.yan` 的子集）。 */
export interface SubagentPatchIo {
  describeFiles(paths: string[]): Promise<Array<{ ok: boolean; path?: string; error?: string }>>
  readFileText(path: string): Promise<{ ok: boolean; text?: string; truncated?: boolean; error?: string }>
}

/**
 * 读这条运行归档的真实补丁。
 *
 * 宿主的文本预览只认**已登记**的文件，所以先 `describeFiles` 登记这次补丁，
 * 再 `readFileText` 读取；两处都由主进程复核路径与大小。任一环节失败都抛出
 * 明确原因，调用方保留原状态并就地提示，不静默当空补丁。
 */
export async function loadSubagentPatch(patchPath: string, io?: SubagentPatchIo): Promise<SubagentPatch> {
  const api = io ?? (typeof window !== 'undefined' ? (window.yan as SubagentPatchIo | undefined) : undefined)
  if (!api?.describeFiles || !api.readFileText) throw new Error('宿主文件接口不可用')
  const granted = await api.describeFiles([patchPath])
  const first = granted[0]
  if (!first?.ok) throw new Error(first?.error ?? '补丁文件不可读')
  const res = await api.readFileText(first.path ?? patchPath)
  if (!res.ok || typeof res.text !== 'string') throw new Error(res.error ?? '补丁读取失败')
  return { patch: res.text, truncated: res.truncated === true }
}

/**
 * 处置动作的窄结果。宿主对业务失败**不 reject**，而是以 `{ ok:false, error }` 解析，
 * 与 preload 的 `window.yan.subagents.merge / discard` 同形。
 */
export interface SubagentActionResult {
  ok: boolean
  error?: string
}

/** 只取两条正式处置通道，便于对话框与测试复用同一适配。 */
export interface SubagentActionIo {
  merge(id: string): Promise<SubagentActionResult>
  discard(id: string): Promise<SubagentActionResult>
}

function subagentActionIo(io?: SubagentActionIo): SubagentActionIo {
  if (io) return io
  const api = typeof window !== 'undefined' ? window.yan?.subagents : undefined
  if (!api?.merge || !api?.discard) throw new Error('子 Agent 处置接口不可用')
  return { merge: (id) => api.merge(id), discard: (id) => api.discard(id) }
}

/**
 * 采纳：仍走既有 `window.yan.subagents.merge`（同一正式 backend 入口）。
 * 成功不改本地状态，由后端 push 更新运行；`{ ok:false }` 转成明确失败交给对话框，
 * 不静默 resolve，也不靠扫描全局 notices 判断成败。
 */
export async function mergeSubagentResult(id: string, io?: SubagentActionIo): Promise<void> {
  const res = await subagentActionIo(io).merge(id)
  if (!res?.ok) throw new Error(res?.error ?? '合并子代理结果失败')
}

/** 放弃：同 `mergeSubagentResult`，窄结果失败即抛出明确原因。 */
export async function discardSubagentResult(id: string, io?: SubagentActionIo): Promise<void> {
  const res = await subagentActionIo(io).discard(id)
  if (!res?.ok) throw new Error(res?.error ?? '放弃子代理结果失败')
}
