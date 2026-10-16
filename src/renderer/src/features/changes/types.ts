/**
 * R4「改动」面板的输入契约（纯类型）。
 *
 * owner 直接复用 R0 `features/workbench/types.ts` 的 `WorkspaceOwner`（唯一真源），
 * 这里只做别名导出，不重复定义字段。
 */
import type { GitRepoState, GitStatusEntry } from '../../../../shared/git'
import type { WorkspaceOwner } from '../workbench/types'

/** R4 的 owner 入参；与 R0 契约同源。 */
export type ChangesOwner = WorkspaceOwner

/** 仓库状态读取的返回形状，与 `window.yan.git.state` 对齐。 */
export interface GitStateView {
  repo: GitRepoState | null
  error?: string
}

/**
 * 面板的 Git 数据源。
 *
 * 默认实现包住正式的 `window.yan.git`；父会话或测试可以注入替身。
 * **只含只读读取** —— 暂存 / 还原 / 提交 / 推送 / 删除都不在这里，
 * 面板也从不调用这些写操作。
 *
 * `entries` 是逐文件状态条目，缺省实现走正式 `yan:git:changes`（只读）。
 * 宿主没有这条通道时**不提供**它，界面明说「未提供」，不静默装空列表。
 */
export interface ChangesGitSource {
  state(cwd: string): Promise<GitStateView>
  untracked(cwd: string): Promise<string[]>
  entries?(cwd: string): Promise<GitStatusEntry[]>
}

/**
 * 单文件补丁：`loadPatch` 的返回。
 *
 * `truncated` / `binary` 让界面能如实说明降级，而不是把截断当成完整补丁。
 */
export interface ChangesPatch {
  patch: string
  /** 补丁被字节上限截断（**不是完整内容**） */
  truncated?: boolean
  /** 二进制文件：补丁只含 git 的说明行 */
  binary?: boolean
}

/** 按路径读单文件补丁；缺省实现走正式 `yan:git:diff`。 */
export type PatchLoader = (cwd: string, path: string) => Promise<ChangesPatch>

/** 面板列表里的一行。 */
export interface ChangeItem {
  path: string
  /** 两位状态码（`M ` / ` M` / `MM` / `??` …），来自正式 status 解析。 */
  status: string
  untracked: boolean
}
