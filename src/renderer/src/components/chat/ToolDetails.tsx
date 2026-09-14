import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { ToolDetail } from './MessageParts'
import type { FileDiff, UIToolCall } from '../../../../shared/ipc'

/**
 * 工具详情的**分型渲染**（方案 4.1）。
 *
 * 为什么要分：以前所有工具展开后都套同一个「终端窗口」外壳 ——
 * 搜索、读文件、看网页这些**本来就不是命令**，套上 `$` prompt 行
 * 只会让人以为它们在 shell 里跑过。现在：
 *
 *   · `command`  → 紧凑终端窗口（Terminal.tsx，1 行命令 + 2 行输出）
 *   · `change`   → 文件改动卡片（路径 + 状态 + 前后片段 / 写入内容）
 *   · `result`   → 直接给结果（路径/参数 + 输出），没有外壳
 */

/** 工具 → 详情类型。未知工具按「结果」处理（显示通用图标与真实名称） */
export function detailKind(name: string): 'command' | 'change' | 'result' {
  if (name === 'bash' || name === 'shell' || name === 'run' || name === 'exec') return 'command'
  if (
    name === 'edit' ||
    name === 'write' ||
    name === 'multi_edit' ||
    name === 'multiEdit' ||
    name === 'apply_patch' ||
    name === 'patch'
  )
    return 'change'
  return 'result'
}

function callPath(call: UIToolCall): string {
  const a = (call.args ?? {}) as Record<string, unknown>
  if (typeof a.path === 'string') return a.path
  if (typeof a.file_path === 'string') return a.file_path
  if (typeof a.filePath === 'string') return a.filePath
  return ''
}

/** 从 call.details 里取出执行前后快照算出的真实差异（没有就是 null） */
function readFileDiff(details: unknown): FileDiff | null {
  if (!details || typeof details !== 'object') return null
  const d = (details as { fileDiff?: unknown }).fileDiff
  if (!d || typeof d !== 'object') return null
  const diff = d as Partial<FileDiff>
  if (typeof diff.path !== 'string' || !diff.before || !diff.after) return null
  return diff as FileDiff
}

/**
 * 文件改动详情。
 *
 * 两层信息（方案 5.3）：
 *   ① **可靠差异**：执行前后快照算出的逐行 patch + 增删行数（有就用它）；
 *   ② **可查看**：没有快照（旧会话 / 第三方工具）时退回展示工具参数里的
 *      前后片段或写入内容，并如实说明“替换片段”。
 *
 * 失败调用一律标明「未成功应用」，不能让用户以为改上了。
 */
export function FileChangeDetail({ call }: { call: UIToolCall }) {
  const t = useT()
  const path = callPath(call)
  const running = call.status === 'running' || call.status === 'pending'
  const failed = call.status === 'error'
  const diff = readFileDiff(call.details)

  const stateClass = running ? 'run' : failed ? 'err' : 'ok'
  const stateText = running ? t('term.running') : failed ? t('tool.failed') : t('term.ok')

  const tooLarge = !!(diff?.before.tooLarge || diff?.after.tooLarge)
  const statusText =
    diff?.status === 'created'
      ? t('tool.diffCreated')
      : diff?.status === 'deleted'
        ? t('tool.diffDeleted')
        : diff?.status === 'unchanged'
          ? t('tool.diffUnchanged')
          : ''

  return (
    <div className="fd" data-testid="file-change-detail">
      <div className="fd-head">
        <Icon name="tag" size={12} />
        <span className="fd-path" title={path || diff?.path}>
          {path || diff?.path || call.name}
        </span>
        {statusText ? <span className="fd-status">{statusText}</span> : null}
        <span className="spacer" />
        {/* 有真实差异时给增删行数（方案 5.3 要求） */}
        {diff && diff.added >= 0 ? (
          <span className="fd-stat add" data-testid="file-diff-added">
            +{diff.added}
          </span>
        ) : null}
        {diff && diff.removed >= 0 ? (
          <span className="fd-stat del" data-testid="file-diff-removed">
            -{diff.removed}
          </span>
        ) : null}
        <span className={`fd-state ${stateClass}`}>{stateText}</span>
      </div>
      {failed ? <div className="fd-note">{t('tool.notApplied')}</div> : null}
      <div className="fd-body">
        {diff ? (
          <>
            {tooLarge ? <div className="fd-note">{t('tool.diffTooLarge')}</div> : null}
            {diff.patch ? (
              <pre className="fd-patch" data-testid="file-diff-patch">
                {diff.patch}
              </pre>
            ) : !tooLarge && diff.status !== 'unchanged' ? (
              <div className="fd-note">{t('tool.diffNoPatch')}</div>
            ) : null}
          </>
        ) : (
          <ToolDetail call={call} />
        )}
      </div>
    </div>
  )
}

/**
 * 普通工具结果：**不套外壳**（方案 4.1）。
 * 搜索 / 读取 / 浏览器操作本来就该直接看结果，
 * 包一层「终端标题栏」只会制造「它跑了命令」的错觉。
 */
export function ToolResultDetail({ call }: { call: UIToolCall }) {
  return (
    <div className="trd" data-testid="tool-result-detail">
      <ToolDetail call={call} />
    </div>
  )
}
