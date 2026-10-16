/**
 * 工具步骤：**默认折叠**的一行摘要 +（展开后的）步骤列表 +（始终可见的）进行中步骤。
 *
 * 参考 v2 `chat/ToolRow.tsx` / `chat/TurnProcess.tsx` 的行为，但不引入 v2 控件与
 * v2 CSS：步骤行的分组、运行/失败始终可见、详情读取已记录内容（不重跑工具）等
 * 规则保留；差异与终端详情在 WP-30 右侧面板迁移前，先在行内显示原始命令与输出。
 *
 * 失败的那一步自动展开详情；长输出先截断成预览，展开/收起用共享按钮（原生可聚焦）。
 *
 * 纯逻辑（调用森林、是否收敛、目标摘要、文件差异读取）取自 `shared/tool-call-tree`
 * 与 `shared/ipc` 的类型，不复制 v2 组件。
 */
import { useState, type JSX, type ReactNode } from 'react'
import { useI18n, useT, type TFunc } from '../../i18n'
import type { FileDiff, UIToolCall } from '../../../../shared/ipc'
import { flattenToolNodes, isSettledToolNode, toolCallForest, type ToolCallNode } from '../../../../shared/tool-call-tree'
import { useSessionText } from './text'
import { callPath, readFileDiff } from './turn-changes'
import { summarize, toolGroupLabel } from './tool-summary'
import { Icon } from './Icon'
import { Button, IconButton } from '../../ui'
import { McpAppResult, McpAppStepAudit } from '../artifacts/McpAppFrame'

/** 长输出预览行数：超出先只渲染这么多行，展开后再铺全 */
const OUTPUT_PREVIEW_LINES = 16

/** 工具 → 详情类型；未知工具按「结果」处理 */
export function detailKind(name: string): 'command' | 'change' | 'result' {
  if (name === 'bash' || name === 'powershell' || name === 'shell' || name === 'run' || name === 'exec') return 'command'
  if (name === 'edit' || name === 'write' || name === 'multi_edit' || name === 'multiEdit' || name === 'apply_patch' || name === 'patch') return 'change'
  return 'result'
}

function durationSecs(call: UIToolCall): number | null {
  const { startedAt, endedAt } = call
  if (typeof startedAt !== 'number' || typeof endedAt !== 'number' || endedAt <= startedAt) return null
  return Math.max(1, Math.round((endedAt - startedAt) / 1000))
}

function isRunning(call: UIToolCall): boolean {
  return call.status === 'running' || call.status === 'pending'
}

/** 「改了 M 个文件 +a −d」的汇总：只统计有执行前后快照的改动，拿不到就不写 */
function changeStats(tools: UIToolCall[]): { files: number; additions: number; deletions: number } | null {
  const paths = new Set<string>()
  let additions = 0
  let deletions = 0
  let counted = 0
  for (const call of tools) {
    if (isRunning(call)) continue
    const diff = readFileDiff(call.details)
    if (!diff || diff.status === 'unchanged') continue
    paths.add(diff.path || callPath(call) || call.id)
    if (diff.added >= 0 && diff.removed >= 0) {
      additions += diff.added
      deletions += diff.removed
      counted += 1
    }
  }
  if (!paths.size) return null
  return { files: paths.size, additions, deletions: counted > 0 ? deletions : -1 }
}

/** 摘要行：按类别写「已搜索 3 次, 已读取 2 个文件… 以及另外 4 项操作」，改动与失败跟在后面 */
function summaryText(t: TFunc, zh: boolean, tools: UIToolCall[], failed: number): { label: string; stats: ReactNode } {
  const stats = changeStats(tools)
  const label = toolGroupLabel(tools, zh) + (failed > 0 ? (zh ? `（${failed} 个失败）` : ` (${failed} failed)`) : '')
  const statNode: ReactNode = stats
    ? stats.additions >= 0 && stats.deletions >= 0
      ? <><span className="v3-add">+{stats.additions}</span><span className="v3-del">−{stats.deletions}</span></>
      : t('tool.wsChanges', { n: stats.files })
    : null
  return { label, stats: statNode }
}

export function ToolSteps({ tools }: { tools: UIToolCall[] }): JSX.Element | null {
  const t = useT()
  const zh = useI18n().lang !== 'en-US'
  const tt = useSessionText()
  const [manual, setManual] = useState<boolean | null>(null)
  if (!tools.length) return null

  const forest = toolCallForest(tools)
  const running = tools.filter(isRunning)
  const failed = tools.filter((c) => c.status === 'error' && !c.cancelled).length
  /* 失败时自动展开那一步（失败是首要信息）；用户手动开合优先 */
  const open = manual ?? failed > 0
  const { label, stats } = summaryText(t, zh, tools, failed)

  return (
    <section className="v3-steps" data-testid="v3-steps" aria-label={t('proc.title')}>
      <button className="v3-steps-sum" aria-expanded={open} onClick={() => setManual(!open)} data-testid="v3-steps-toggle">
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} className="v3-chev" />
        <span className="v3-steps-label">{label}</span>
        {stats ? <span className="v3-steps-stats">{stats}</span> : null}
      </button>

      {open ? (
        <div className="v3-steps-list" data-testid="v3-steps-list">
          {forest.map((node) => <StepNode key={node.call.id} node={node} depth={0} />)}
        </div>
      ) : (
        /* 折叠时仍把「正在跑的那一步」单独铺出来：运行中不能什么都看不见 */
        running.length ? (
          <div className="v3-steps-live" data-testid="v3-steps-live">
            {forest.filter((node) => !isSettledToolNode(node)).map((node) => <StepNode key={node.call.id} node={node} depth={0} />)}
          </div>
        ) : null
      )}

      {/* 详情去向提示：差异/终端在 WP-30 右侧面板落地前，先说清楚当前显示的是原始记录 */}
      {open && tools.some((c) => detailKind(c.name) === 'command' || detailKind(c.name) === 'change') ? (
        <div className="v3-steps-note"><Icon name="external" size={13} /><span>{tt('toolDetail')}</span></div>
      ) : null}
    </section>
  )
}

/** 一步（可能带嵌套子调用）：标题行 + 展开详情 */
function StepNode({ node, depth }: { node: ToolCallNode; depth: number }): JSX.Element {
  const t = useT()
  const [manual, setManual] = useState<boolean | null>(null)
  const call = node.call
  const running = isRunning(call)
  const failed = call.status === 'error' && !call.cancelled
  /* 失败的那一步自动展开详情；用户手动开合优先 */
  const open = manual ?? failed
  const secs = durationSecs(call)
  const target = summarize(call) || t('tool2.noTarget')
  const state = running ? 'run' : failed ? 'err' : call.cancelled ? 'warn' : 'ok'
  /* 第四级以下平铺，避免无限缩进 */
  const children = depth + 1 >= 4 ? flattenToolNodes(node.children) : node.children

  return (
    <div className="v3-step" data-state={call.status} data-tool={call.name} data-depth={depth}>
      <button className="v3-step-head" aria-expanded={open} onClick={() => setManual(!open)} title={target} data-testid="v3-step">
        <span className={`v3-dot ${state}`} aria-hidden />
        {running ? null : <Icon name={failed ? 'warn' : call.cancelled ? 'stop' : 'check'} size={13} />}
        <span className="v3-step-verb">{call.name}</span>
        <span className="v3-step-target">{detailKind(call.name) === 'command' ? <span className="v3-dollar">$ </span> : null}{target}</span>
        {secs !== null && !running ? <span className="v3-step-time">{secs}s</span> : null}
        {failed ? <span className="v3-badge err">{t('tool.failed')}</span> : call.cancelled ? <span className="v3-badge warn">{t('tool.cancelled')}</span> : call.incomplete ? <span className="v3-badge warn">{t('tool2.incomplete')}</span> : null}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} className="v3-chev" />
      </button>
      {open ? <StepDetail call={call} /> : null}
      {children.length ? <div className="v3-step-nest" role="group" aria-label={t('tool2.nestLabel', { n: children.length })}>{children.map((child) => <StepNode key={child.call.id} node={child} depth={depth + 1} />)}</div> : null}
    </div>
  )
}

/** 展开后的已记录内容：不会重新执行工具，也不会重新读盘 */
function StepDetail({ call }: { call: UIToolCall }): JSX.Element {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const kind = detailKind(call.name)
  const diff = readFileDiff(call.details)
  const args = call.args as Record<string, unknown> | undefined
  const onlyCommand = typeof args?.command === 'string' && Object.keys(args).every((k) => k === 'command' || k === 'timeout')
  const argsText = onlyCommand ? '' : call.args && Object.keys(call.args as object).length ? JSON.stringify(call.args, null, 2) : call.argsRaw ?? ''
  const copyText = [call.args ? JSON.stringify(call.args, null, 2) : call.argsRaw ?? '', call.output ?? ''].filter(Boolean).join('\n\n')
  const copy = (): void => {
    void navigator.clipboard.writeText(copyText || summarize(call)).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1600) },
      () => undefined
    )
  }

  return (
    <div className="v3-step-detail" data-kind={kind}>
      <div className="v3-step-detail-bar">
        {call.historySummary ? <span className="v3-step-note">{t('tool2.historySummary')}</span> : null}
        <span className="v3-code-sp" />
        <IconButton size="sm" aria-label={t('tool.copyDetail')} onPress={copy}><Icon name={copied ? 'check' : 'copy'} size={14} /></IconButton>
      </div>
      {call.nestedCallsIncomplete ? <div className="v3-step-note">{t('tool2.nestedIncomplete')}</div> : null}
      {call.images?.length ? (
        <div className="v3-step-images">
          {call.images.map((im, i) => im.data ? <img key={i} src={`data:${im.mimeType};base64,${im.data}`} alt="" className="v3-md-image" /> : im.url ? <img key={i} src={im.url} alt="" className="v3-md-image" /> : null)}
        </div>
      ) : null}
      {kind === 'change' ? (
        <ChangeDetail call={call} diff={diff} />
      ) : (
        <>
          {onlyCommand ? null : argsText ? <pre className="v3-step-pre args">{argsText}</pre> : null}
          {call.output ? <StepOutput text={call.output} /> : call.status === 'ok' ? <div className="v3-step-note">{t('tool.noOutput')}</div> : null}
          {call.name.startsWith('mcp__') ? (
            <>
              <McpAppResult callId={call.id} title={call.name} />
              <McpAppStepAudit callId={call.id} />
            </>
          ) : null}
        </>
      )}
    </div>
  )
}

/**
 * 已记录的输出：超过预览行数时先截断，再给一个共享按钮展开/收起。
 * 截断只发生在渲染层，不修改记录；按钮是原生按钮（Tab 可达，`aria-expanded` 反映状态）。
 */
function StepOutput({ text }: { text: string }): JSX.Element {
  const tt = useSessionText()
  const [expanded, setExpanded] = useState(false)
  const lines = text.split('\n')
  const truncated = lines.length > OUTPUT_PREVIEW_LINES
  const shown = truncated && !expanded ? lines.slice(0, OUTPUT_PREVIEW_LINES) : lines
  return (
    <>
      <pre className="v3-step-pre out" data-testid="v3-step-output">{shown.join('\n')}</pre>
      {truncated ? (
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          data-testid="v3-step-output-toggle"
          onPress={() => setExpanded((v) => !v)}
        >
          {expanded ? tt('outputLess') : tt('outputMore', { n: lines.length })}
        </Button>
      ) : null}
    </>
  )
}

function ChangeDetail({ call, diff }: { call: UIToolCall; diff: FileDiff | null }): JSX.Element {
  const t = useT()
  if (!diff) {
    return (
      <>
        <div className="v3-step-path">{callPath(call) || call.name}</div>
        <div className="v3-step-note">{t('tool.diffUnavailable')}</div>
        {call.output ? <StepOutput text={call.output} /> : null}
      </>
    )
  }
  const status = diff.status === 'created' ? t('tool.diffCreated') : diff.status === 'deleted' ? t('tool.diffDeleted') : diff.status === 'unchanged' ? t('tool.diffUnchanged') : ''
  const tooLarge = diff.before.tooLarge || diff.after.tooLarge
  return (
    <>
      <div className="v3-step-path">
        <Icon name="file" size={13} />
        <span title={diff.path}>{diff.path}</span>
        {status ? <span className="v3-step-status">{status}</span> : null}
        <span className="v3-code-sp" />
        {diff.added >= 0 ? <span className="v3-add">+{diff.added}</span> : null}
        {diff.removed >= 0 ? <span className="v3-del">−{diff.removed}</span> : null}
      </div>
      {call.status === 'error' ? <div className="v3-step-note err">{t('tool.notApplied')}</div> : null}
      {tooLarge ? <div className="v3-step-note">{t('tool.diffTooLarge')}</div> : null}
      {diff.patch ? (
        <pre className="v3-step-patch">
          {diff.patch.split('\n').map((line, i) => (
            <span key={i} className="v3-diff-line" data-kind={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'context'}>{line}{'\n'}</span>
          ))}
        </pre>
      ) : !tooLarge && diff.status !== 'unchanged' ? <div className="v3-step-note">{t('tool.diffNoPatch')}</div> : null}
    </>
  )
}
