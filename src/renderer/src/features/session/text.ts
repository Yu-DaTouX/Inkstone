/**
 * v3 会话模块自有的少量文案。
 *
 * ⚠️ 为什么不放两份 i18n：任务边界禁止修改 i18n（并发代理也在用）。
 * 这里只收「v3 尚未迁移、需要明确回退提示」这一类临时句子；等迁移完成后
 * 应当并入正式 i18n 并删除本文件。键名与语义都标注出来，避免被误当成长期文案源。
 */
import { useI18n } from '../../i18n'

export type SessionTextKey =
  /** 结构化图块（yan-chart 等，WP-32 迁移） */
  | 'visual'
  /** 尚未换装的生图进度 */
  | 'imageProgress'
  /** 子 Agent 卡片（WP-27 迁移） */
  | 'subagent'
  /** 工具差异 / 终端详情（WP-30 右侧面板迁移） */
  | 'toolDetail'
  /** 工具长输出的展开与收起 */
  | 'outputMore'
  | 'outputLess'
  /** 空会话骨架之外的占位 */
  | 'placeholder'
  /* ---- WP-27a 子 Agent 行 ---- */
  | 'subagentOpen'
  | 'subagentDetails'
  | 'subagentNoSummary'
  | 'subagentScopeWorktree'
  | 'subagentScopeReadOnly'
  | 'subagentScopeShared'
  | 'subagentReviewPending'
  | 'subagentPartial'
  /* 子 Agent 侧边详情 */
  | 'subagentPanel'
  | 'subagentKind'
  | 'subagentClose'
  | 'subagentConclusion'
  | 'subagentSources'
  | 'subagentArtifacts'
  | 'subagentModel'
  | 'subagentScope'
  | 'subagentLatest'
  | 'subagentTranscript'
  | 'subagentDetailHint'
  | 'subagentGroup'
  /* ---- WP-21c 错误卡 / 压缩标记 / 分支摘要 ---- */
  | 'compactionTitle'
  | 'branchFrom'
  | 'errorTitleRetryable'
  | 'errorTitleQuotaUsage'
  | 'errorTitleQuotaRate'
  | 'errorTitleAuth'
  | 'errorTitleContext'
  | 'errorTitleAborted'
  | 'errorTitleRefused'
  | 'errorTitleRequest'
  | 'errorRetry'
  | 'errorModel'
  | 'errorCompact'

const ZH: Record<SessionTextKey, string> = {
  visual: '结构化图块（{lang}）暂未在 v3 渲染；完整效果请切回 v2 界面。',
  imageProgress: '生图进度暂未在 v3 渲染；请切回 v2 界面查看进度。',
  subagent: '子 Agent 卡片暂未在 v3 渲染；请切回 v2 界面查看。',
  toolDetail: '差异与终端详情将在右侧面板打开；这里先显示已记录的命令与输出。',
  outputMore: '展开全部输出（{n} 行）',
  outputLess: '收起输出',
  placeholder: '此内容暂未在 v3 渲染。',
  subagentOpen: '并排打开（未迁移）',
  subagentDetails: '摘要',
  subagentNoSummary: '暂无摘要。',
  subagentScopeWorktree: '工作树',
  subagentScopeReadOnly: '只读',
  subagentScopeShared: '共享目录',
  subagentReviewPending: '待审阅',
  subagentPartial: '结论可能不完整',
  subagentPanel: '子代理详情',
  subagentKind: '子代理',
  subagentClose: '关闭详情',
  subagentConclusion: '结论',
  subagentSources: '来源',
  subagentArtifacts: '成果',
  subagentModel: '模型',
  subagentScope: '范围',
  subagentLatest: '最近动作',
  subagentTranscript: '分屏查看完整转录',
  subagentDetailHint: '查看详情',
  subagentGroup: '{n} 个子代理 · {live} 个进行中',
  compactionTitle: '上下文已压缩',
  branchFrom: '从「{text}」分出去',
  errorTitleRetryable: '模型侧错误',
  errorTitleQuotaUsage: '额度已用完',
  errorTitleQuotaRate: '请求过于频繁',
  errorTitleAuth: '认证或权限失败',
  errorTitleContext: '上下文超限',
  errorTitleAborted: '本轮已取消',
  errorTitleRefused: '服务商拦截',
  errorTitleRequest: '模型或参数不受支持',
  errorRetry: '重试',
  errorModel: '换模型',
  errorCompact: '压缩上下文'
}

const EN: Record<SessionTextKey, string> = {
  visual: 'Structured block ({lang}) is not rendered in v3 yet; switch to the v2 UI for the full view.',
  imageProgress: 'Image generation progress is not rendered in v3 yet; switch to the v2 UI to view its progress.',
  subagent: 'Sub-agent cards are not rendered in v3 yet; switch to the v2 UI to view them.',
  toolDetail: 'Diffs and terminal details open in the side panel; recorded command and output are shown here.',
  outputMore: 'Show all output ({n} lines)',
  outputLess: 'Collapse output',
  placeholder: 'This content is not rendered in v3 yet.',
  subagentOpen: 'Open side-by-side (not migrated)',
  subagentDetails: 'Summary',
  subagentNoSummary: 'No summary yet.',
  subagentScopeWorktree: 'Worktree',
  subagentScopeReadOnly: 'Read-only',
  subagentScopeShared: 'Shared folder',
  subagentReviewPending: 'Awaiting review',
  subagentPartial: 'Conclusion may be incomplete',
  subagentPanel: 'Subagent details',
  subagentKind: 'Subagent',
  subagentClose: 'Close details',
  subagentConclusion: 'Conclusion',
  subagentSources: 'Sources',
  subagentArtifacts: 'Outputs',
  subagentModel: 'Model',
  subagentScope: 'Scope',
  subagentLatest: 'Latest step',
  subagentTranscript: 'Open full transcript side by side',
  subagentDetailHint: 'View details',
  subagentGroup: '{n} subagents · {live} in progress',
  compactionTitle: 'Context compacted',
  branchFrom: 'Branched from “{text}”',
  errorTitleRetryable: 'Model error',
  errorTitleQuotaUsage: 'Quota exhausted',
  errorTitleQuotaRate: 'Too many requests',
  errorTitleAuth: 'Authentication or permission failed',
  errorTitleContext: 'Context limit exceeded',
  errorTitleAborted: 'Turn cancelled',
  errorTitleRefused: 'Blocked by provider',
  errorTitleRequest: 'Model or request unsupported',
  errorRetry: 'Retry',
  errorModel: 'Switch model',
  errorCompact: 'Compact context'
}

export function sessionText(lang: string, key: SessionTextKey, vars?: Record<string, string | number>): string {
  let s = (lang === 'en-US' ? EN : ZH)[key]
  if (vars) for (const [n, v] of Object.entries(vars)) s = s.split(`{${n}}`).join(String(v))
  return s
}

export function useSessionText(): (key: SessionTextKey, vars?: Record<string, string | number>) => string {
  const { lang } = useI18n()
  return (key, vars) => sessionText(lang, key, vars)
}
