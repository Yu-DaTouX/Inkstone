import { useI18n } from '../../i18n'

export type SessionTextKey =
  | 'visual'
  | 'imageProgress'
  | 'subagent'
  | 'toolDetail'
  | 'outputMore'
  | 'outputLess'
  | 'moreItems'
  | 'placeholder'
  | 'subagentOpen'
  | 'subagentDetails'
  | 'subagentNoSummary'
  | 'subagentScopeWorktree'
  | 'subagentScopeReadOnly'
  | 'subagentScopeShared'
  | 'subagentReviewPending'
  | 'subagentPartial'
  | 'subagentPanel'
  | 'subagentKind'
  | 'subagentClose'
  | 'subagentResize'
  | 'subagentConclusion'
  | 'subagentSources'
  | 'subagentArtifacts'
  | 'subagentModel'
  | 'subagentScope'
  | 'subagentLatest'
  | 'subagentTranscript'
  | 'subagentDetailHint'
  | 'subagentCount'
  | 'subagentLiveCount'
  | 'subagentDoneCount'
  | 'subagentFailedCount'
  | 'subagentDeckHint'
  | 'subagentDeckLabel'
  | 'subagentDeckJump'
  | 'subagentDeckGo'
  | 'subagentShowLess'
  | 'subagentRetried'
  | 'subagentResumed'
  | 'subagentNotRetried'
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
  visual: '结构化图块（{lang}）暂不支持在这里渲染。',
  imageProgress: '生图进度暂不支持在这里显示。',
  subagent: '子 Agent 卡片暂不支持在这里显示。',
  toolDetail: '差异与终端详情将在右侧面板打开；这里先显示已记录的命令与输出。',
  outputMore: '展开全部输出（{n} 行）',
  outputLess: '收起输出',
  moreItems: '另外 {n} 项',
  placeholder: '此内容暂未在 v3 渲染。',
  subagentOpen: '并排打开（未迁移）',
  subagentDetails: '摘要',
  subagentNoSummary: '暂无摘要。',
  subagentScopeWorktree: '工作树',
  subagentScopeReadOnly: '只读',
  subagentScopeShared: '共享目录',
  subagentReviewPending: '待审查',
  subagentPartial: '结论可能不完整',
  subagentPanel: '子 Agent 详情',
  subagentKind: '子 Agent',
  subagentClose: '关闭详情',
  subagentResize: '调整大小',
  subagentConclusion: '结论',
  subagentSources: '来源',
  subagentArtifacts: '成果',
  subagentModel: '模型',
  subagentScope: '范围',
  subagentLatest: '最近动作',
  subagentTranscript: '分屏查看完整转录',
  subagentDetailHint: '查看详情',
  subagentCount: '{n} 个子 Agent',
  subagentLiveCount: '{n} 进行中',
  subagentDoneCount: '{n} 完成',
  subagentFailedCount: '{n} 失败',
  subagentDeckHint: '滚轮 · ↑↓ 翻张',
  subagentDeckLabel: '子 Agent 卡片，聚焦后用上下方向键翻张',
  subagentDeckJump: '翻到这一张',
  subagentDeckGo: '第 {n} 个',
  subagentShowLess: '收起',
  subagentRetried: '已自动重试 {n} 次',
  subagentResumed: '已自动续跑 1 次',
  subagentNotRetried: '未自动重试',
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
  visual: "Structured block ({lang}) can't be rendered here yet.",
  imageProgress: "Image generation progress isn't shown here yet.",
  subagent: "Subagent cards aren't shown here yet.",
  toolDetail: 'Diffs and terminal details open in the side panel; recorded command and output are shown here.',
  outputMore: 'Show all output ({n} lines)',
  outputLess: 'Collapse output',
  moreItems: '{n} more',
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
  subagentResize: 'Resize',
  subagentConclusion: 'Conclusion',
  subagentSources: 'Sources',
  subagentArtifacts: 'Outputs',
  subagentModel: 'Model',
  subagentScope: 'Scope',
  subagentLatest: 'Latest step',
  subagentTranscript: 'Open full transcript side by side',
  subagentDetailHint: 'View details',
  subagentCount: '{n} subagents',
  subagentLiveCount: '{n} in progress',
  subagentDoneCount: '{n} done',
  subagentFailedCount: '{n} failed',
  subagentDeckHint: 'Wheel · ↑↓ to flip',
  subagentDeckLabel: 'Subagent cards, use the up and down arrow keys to flip when focused',
  subagentDeckJump: 'Flip to this one',
  subagentDeckGo: 'No. {n}',
  subagentShowLess: 'Show less',
  subagentRetried: 'Retried {n} times',
  subagentResumed: 'Auto-continued once',
  subagentNotRetried: 'Not retried',
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
