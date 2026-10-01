/**
 * 工具调用的 **Codex 风格**呈现（用户要求，附 Codex 截图）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 用户原话 + 参考图
 * ══════════════════════════════════════════════════════════════════
 *   「工具调用的方式模拟 codex 的工具调用模式 但是提供一个开关来让用户
 *     自己选择是否可以看到用类似终端窗口的工具调用详情」
 *
 * Codex 的样子（两张截图）：
 *   运行中：  ⠋ 正在运行 Test-NetConnection -ComputerName www.baidu.com ›
 *   已完成：  调用了 N 次工具/命令 ⌄
 *             ✓ 已在 11s 内运行 Test-NetConnection -ComputerName 8.8.8.8
 *             ✓ 已在 2s 内运行 Get-NetIPConfiguration | Select-Object ...
 *
 * 两个特征值得照搬：
 *   ① **一行一条**，命令原文直接铺在行里（不折成卡片、不藏进摘要）
 *   ② **分组折叠**：多条命令挂在「运行了命令 N」下面，默认收起
 *
 * ── 新增：终端窗口详情（开关控制）──
 * 展开某一条时，用**终端窗口**的样子显示详情（深色底 + 标题栏显示命令 +
 * 等宽正文），而不是散落的键值对。这就是用户说的「类似终端窗口」。
 *
 * ⚠️ 设置 `toolDetail` 的语义（2026-09 修订）：它只决定**运行中的调用
 *    是否自动展开**，不再决定历史能不能查看 —— 查看权限与自动展开偏好
 *    已经分开（历史上关掉开关后连已完成的都点不开，那是个 bug）。
 *
 * ⚠️ 自动展开的只有**正在运行**的那条（用户要求：「只展示正在调用的详情，
 *    不要全部弹出」）。一次 agent 跑几十条命令是常态，
 *    已结束的全展开会把回答顶出屏幕。
 */
import { memo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { withScrollAnchor } from '../../lib/scrollAnchor'
import { TerminalWindow } from './Terminal'
import { FileChangeDetail, ToolResultDetail, WorkspaceChangesDetail, detailKind, readWorkspaceChanges } from './ToolDetails'
import { RunDot } from '../ui'
import { goalCommand, summarizeTaskPlanCommand, summarizeYanCommand, taskPlanCommand } from '../../../../shared/tool-origin'
import type { UIToolCall } from '../../../../shared/ipc'
import { projectToolCallTree } from '../../../../shared/tool-call-tree'
import { ChatImage } from './ChatImage'


/** 一行工具：图标 + 动词 + 目标 + 状态 */
function ToolRowImpl({ call, autoOpen = true, depth = 0 }: { call: UIToolCall; autoOpen?: boolean; depth?: number }) {
  const t = useT()
  /** 用户手动开关；null = 跟随默认值 */
  const [manual, setManual] = useState<boolean | null>(null)
  /*
   * 自动展开偏好：**默认关**（N03）。
   * 缺失 / 脏值都当关闭 —— 只有设置里明确打开过（toolDetail === true）
   * 才会把「正在运行」的那条自动展开。见 AppSettings.toolDetail。
   */
  const autoDetail = useStore((s) => s.settings?.toolDetail === true)

  const running = call.status === 'running' || call.status === 'pending'
  const failed = call.status === 'error'
  /** 被取消：单独显示，不当作失败（方案 4.1） */
  const cancelled = call.cancelled === true
  /*
   * 展开规则（用户要求：「只展示正在调用的详情，不要全部弹出」）。
   *
   * 旧实现是 `detailOn && !running` —— 正好反了：打开开关后
   * **已结束的**每一条都展开成终端窗口，正在跑的那条反而收起，
   * 一次跑十几条就把回答顶出屏幕（用户报的）。
   *
   * 现在：**默认全部收起**（开始 / 增量输出 / 结束都不自动展开）；
   * 只有当用户在设置里显式打开 `toolDetail` 时，正在跑的那条才自动展开。
   * 已结束的保持一行，随时点击展开。
   *
   * ⚠️ **所有已记录的调用都可以查看详情**（展开按钮恒可点）。
   *    查看权限是「历史能不能回看」，自动展开是「运行时要不要抢占版面」，
   *    两者必须分开：以前 `canExpand = detailOn || running || failed` 会让
   *    关掉偏好的用户连已完成的调用都点不开。失败调用由行内红色徽标 +
   *    可点的箭头给出足够明显的入口，不需要另开自动展开分支。
   *
   * ⚠️ 多个调用并行时只有**当前活动的**那条自动展开（`autoOpen`，方案 4.2）：
   *    三条并行命令全部展开会把回答顶出屏幕，其余保持活动行。
   */
  const open = manual ?? (running && autoDetail && autoOpen)
  /** 滚动锚点：展开/收起时让这一行在屏幕上原地不动（方案 4.2） */
  const rowRef = useRef<HTMLDivElement | null>(null)
  /** 详情分型（方案 4.1）：命令 / 文件改动 / 普通结果 */
  const kind = detailKind(call.name)
  const wsChanges = readWorkspaceChanges(call.details)
  /*
   * 实施-02 S4：模型用 bash 敲 `yan tasks apply` 时，这条调用其实是
   * **砚内置的任务计划**（宿主服务持写入权）。卡片必须说出来，否则用户
   * 只看到一行 bash，以为模型在自己乱改文件。
   *
   * 这只是展示标记：不改变写入语义、不隐藏原始调用 ——
   * 展开后仍然是完整的命令行与输出（判定依据与边界见 shared/tool-origin.ts）。
   */
  const taskPlan = taskPlanCommand(call.name, call.args)
  /*
   * 实施-05 S3：`yan goal ready|report|status` 同样是砚内置能力（宿主持目标状态），
   * 卡片必须说出来 —— 否则用户只看到一行 bash，不知道那是「计划档的就绪提交」。
   * 与任务计划互斥：一行命令不会同时属于两个组。
   */
  const goalCmd = taskPlan ? null : goalCommand(call.name, call.args)
  const target = taskPlan
    ? summarizeTaskPlanCommand(taskPlan)
    : goalCmd
      ? summarizeYanCommand(goalCmd)
      : summarize(call)
  const secs = durationSecs(call)

  /* 动词：Codex 是「正在运行 / 已在 Ns 内运行」，我们按工具类型分 */
  const verb = running
    ? t('tool2.running', { what: verbOf(call.name, t) })
    : secs !== null
      ? t('tool2.doneIn', { n: secs, what: verbOf(call.name, t) })
      : t('tool2.done', { what: verbOf(call.name, t) })

  return (
    <div
      className={`trow ${open ? 'open' : ''}`}
      data-state={call.status}
      data-tool={call.name}
      {...(taskPlan ? { 'data-origin': 'yan-task-plan' } : goalCmd ? { 'data-origin': 'yan-goal' } : {})}
      ref={rowRef}
    >
      <button
        className="trow-head"
        onClick={() => {
          /* 用锚点包裹：正在读历史时展开不会把视口顶走 */
          withScrollAnchor(rowRef.current, () => setManual(!open))
        }}
        aria-expanded={open}
        title={target}
        aria-label={`${verb} ${target}`}
        data-tool-depth={depth}
        data-parent-tool-call={call.parentToolCallId}
        data-testid="tool-row"
      >
        {/* 命令块（设计规范 §3.5）：状态 · 工具名 · 目标 · 右侧耗时 */}
        <span className="trow-ico" aria-hidden>
          {running ? <RunDot /> : <span className={`trow-dot ${failed ? 'err' : cancelled || call.incomplete ? 'warn' : 'ok'}`} />}
        </span>
        {taskPlan || goalCmd ? (
          <span
            className="trow-src"
            data-testid="tool-src"
            data-origin={taskPlan ? 'yan-task-plan' : 'yan-goal'}
          >
            {taskPlan ? t('tool2.yanTaskPlan') : t('tool2.yanGoal')}
          </span>
        ) : null}
        <span className="trow-verb">{call.name}</span>
        <span className="trow-target" data-testid="tool-target">
          {kind === 'command' ? <span className="trow-dollar">$ </span> : null}
          {target || t('tool2.noTarget')}
        </span>
        {!running && secs !== null ? <span className="trow-time">{secs}s</span> : null}
        {failed ? (
          <span className="trow-badge err">{t('tool.failed')}</span>
        ) : cancelled ? (
          <span className="trow-badge warn">{t('tool.cancelled')}</span>
        ) : call.incomplete ? (
          <span className="trow-badge warn">{t('tool2.incomplete')}</span>
        ) : null}
        {running ? null : (
          <Icon name="chevron-right" size={12} className={`chev ${open ? 'on' : ''}`} />
        )}
      </button>

      <div className={`trow-expand ${open ? 'open' : ''}`} aria-hidden={!open} inert={!open}>
        <div className="trow-expand-inner">
          {open ? <div className="trow-body" data-kind={kind}>
          {call.historySummary ? <p className="trow-src">{t('tool2.historySummary')}</p> : null}
          {call.nestedCallsIncomplete ? <p className="trow-src">{t('tool2.nestedIncomplete')}</p> : null}
          {/*
           * 工具跑出来的图（`yan browser` 截图、渲染图表）：与用户贴的图同一套
           * 落盘 / 显示路径。放在详情之前 —— 截图就是这次调用的主要结果，
           * 不应该排在一堆文本输出下面。
           */}
          {call.images?.length ? (
            <div className="trow-images" data-testid="tool-images">
              {call.images.map((im, i) =>
                im.data ? (
                  <ChatImage key={i} src={`data:${im.mimeType};base64,${im.data}`} />
                ) : im.url ? (
                  <ChatImage key={i} src={im.url} />
                ) : null
              )}
            </div>
          ) : null}
          {/*
           * 按调用类型选详情组件（方案 4.1）：
           *   命令 → 紧凑终端；文件改动 → 改动卡片；其余 → 直接给结果。
           * 以前所有工具都套终端窗口，搜索/读文件看起来像跑过 shell。
           */}
          {kind === 'command' ? (
            <>
              <TerminalWindow call={call} target={target} secs={secs} />
              {/*
               * shell / 第三方工具改了哪些文件（L05）——挂在命令下面。
               * 目录级快照只在**真的有变化**或**归属存疑**时才有值，
               * 所以一条 `ls` 不会凭空多出一张“0 个改动”的卡片。
               */}
              {wsChanges ? <WorkspaceChangesDetail changes={wsChanges} /> : null}
            </>
          ) : kind === 'change' ? (
            <FileChangeDetail call={call} />
          ) : (
            <ToolResultDetail call={call} />
          )}
          </div> : null}
        </div>
      </div>
    </div>
  )
}

/**
 * 两个工具对象是不是「渲染上等价」。
 *
 * ⚠️ 为什么 ToolRow 需要 memo：流式期间每个工具输出 chunk 都会让 store 重建
 *    messages 数组 → 把所有回合/工具行重渲染一遍。已结束的工具其实什么都没变，
 *    但它们下面的 TerminalWindow 里装着完整 output（可能几百 KB），
 *    重渲染一次就是重新 diff 一遍全量文本。
 *
 * 用逐字段比较而不是默认引用比较：已结束的 call 在主进程 messages 里是稳定对象，
 * 但渲染端可能因 `{...base, ...call}` 重建过（见 store 的 `'tool'` 分支），
 * 引用不一定相等；逐字段比较才是真正关心的东西。
 */
/**
 * 图片的便宜指纹。
 *
 * 为什么不直接比 data：那是几 MB 的 base64 字符串。落盘后的条目只有 url，
 * 实时条目用长度就够区分（同一个工具换一张图，长度几乎不会相等）。
 */
function imageKey(c: UIToolCall): string {
  return c.images?.map((i) => i.url || String(i.data?.length ?? 0)).join('|') ?? ''
}

function sameCall(a: UIToolCall, b: UIToolCall): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.name === b.name &&
      a.parentToolCallId === b.parentToolCallId &&
      a.historySummary === b.historySummary &&
      a.incomplete === b.incomplete &&
      a.nestedCallsIncomplete === b.nestedCallsIncomplete &&
      a.status === b.status &&
      a.cancelled === b.cancelled &&
      a.output === b.output &&
      a.argsRaw === b.argsRaw &&
      a.args === b.args &&
      a.details === b.details &&
      a.startedAt === b.startedAt &&
      a.endedAt === b.endedAt &&
      /* 图上得晚（工具先出一段文字、截完图再补 images）—— 漏比就永远不重渲染 */
      imageKey(a) === imageKey(b))
  )
}

export const ToolRow = memo(ToolRowImpl, (a, b) => a.autoOpen === b.autoOpen && a.depth === b.depth && sameCall(a.call, b.call))

/**
 * 一回合的全部工具：一个细边框的命令块表（设计规范 §3.5），一行一条。
 *
 * 运行中的与已结束的放在同一张表里、按发生顺序排列；已成功结束的较早几步
 * 收在首行「前面 N 步」里分批展开。运行中和失败的始终可见，不参与折叠。
 * 只有 `activeId` 那条会按设置里的「工具详情」偏好自动展开，其余保持一行。
 */
/** 点「前面 N 步」先展开最近几步，再按批追加 */
const REVEAL_FIRST = 8
const REVEAL_MORE = 20

function ToolGroupImpl({ tools, activeId = null }: { tools: UIToolCall[]; activeId?: string | null }) {
  const t = useT()
  /*
   * 已展开的较早步数（从最近的往前数）：大任务分批展开，不一次铺出几十上百行。
   * 记着它属于哪一组（以首条调用 id 为准）：列表串到别的回合时不沿用旧的展开量。
   */
  const groupKey = tools[0]?.id ?? ''
  const [reveal, setReveal] = useState({ key: groupKey, n: 0 })
  if (tools.length === 0) return null
  const setRevealed = (next: (n: number) => number) => setReveal((r) => ({ key: groupKey, n: next(r.key === groupKey ? r.n : 0) }))

  const history = tools.filter((c) => c.status !== 'running' && c.status !== 'pending' && c.status !== 'error' && !c.incomplete)
  const revealed = reveal.key === groupKey ? Math.min(reveal.n, history.length) : 0
  const shownHistory = new Set(history.slice(history.length - revealed))
  const visible = projectToolCallTree(tools, new Set(tools.filter((c) => !history.includes(c) || shownHistory.has(c)).map(c => c.id)))
  const foldable = history.length > 0
  const hidden = tools.length - visible.length
  const expanded = revealed > 0

  return (
    <div className={`tgroup ${expanded && foldable ? 'is-expanded' : ''}`} data-testid="tool-group" data-count={tools.length}>
      {hidden > 0 ? (
        <button
          className="tgroup-fold"
          onClick={() => setRevealed((n) => n + (n === 0 ? REVEAL_FIRST : REVEAL_MORE))}
          aria-expanded={expanded}
          data-testid="tool-group-toggle"
        >
          <Icon name="chevron-right" size={12} className="chev" />
          <span>{expanded ? t('tool2.moreEarlier', { n: hidden, k: Math.min(hidden, REVEAL_MORE) }) : t('tool2.earlier', { n: hidden })}</span>
        </button>
      ) : null}
      {foldable && expanded ? (
        <button className="tgroup-fold up" onClick={() => setRevealed(() => 0)} aria-expanded data-testid="tool-group-collapse">
          <Icon name="chevron-right" size={12} className="chev" />
          <span>{t('tool2.foldEarlier')}</span>
        </button>
      ) : null}
      {visible.map(({ call, depth }) => (
        <ToolRow key={call.id} call={call} depth={depth} autoOpen={call.id === activeId} />
      ))}
    </div>
  )
}

/**
 * 组的 memo：比较的是「渲染上等价」——长度相同且逐条 sameCall。
 * 不比较数组引用：`TurnActivity` 每次都新建数组，引用永远不相等。
 */
export const ToolGroup = memo(ToolGroupImpl, (a, b) => {
  if (a.activeId !== b.activeId) return false
  if (a.tools === b.tools) return true
  if (a.tools.length !== b.tools.length) return false
  for (let i = 0; i < a.tools.length; i++) {
    if (!sameCall(a.tools[i], b.tools[i])) return false
  }
  return true
})

/** 动词：按工具类型给一个中文动作词 */
function verbOf(name: string, t: (k: 'tool2.vRun' | 'tool2.vRead' | 'tool2.vEdit' | 'tool2.vWrite' | 'tool2.vSearch' | 'tool2.vCall') => string): string {
  if (name === 'bash' || name === 'powershell') return t('tool2.vRun')
  if (name === 'read' || name === 'list') return t('tool2.vRead')
  if (name === 'edit') return t('tool2.vEdit')
  if (name === 'write') return t('tool2.vWrite')
  if (name === 'grep' || name === 'glob' || name === 'web_search' || name === 'fetch') return t('tool2.vSearch')
  return t('tool2.vCall')
}


/**
 * 耗时（秒）。取自 call 上的 startedAt/endedAt（agent 归一化时写的）；
 * 历史消息拿不到时间戳 → null，界面上就不显示「在 Ns 内」。
 */
function durationSecs(call: UIToolCall): number | null {
  const { startedAt, endedAt } = call
  if (typeof startedAt !== 'number' || typeof endedAt !== 'number') return null
  if (endedAt <= startedAt) return null
  return Math.max(1, Math.round((endedAt - startedAt) / 1000))
}

/** 目标：命令原文 / 路径 / 模式 —— 一行内铺开，超长由 CSS 截断 */
function summarize(call: UIToolCall): string {
  const a = call.args as Record<string, unknown> | undefined
  if (!a || typeof a !== 'object') return ''
  if (typeof a.command === 'string') return a.command
  if (Array.isArray(a.edits) && typeof a.path === 'string') return a.path
  if (typeof a.file_path === 'string') return shortPath(a.file_path)
  if (typeof a.path === 'string') return shortPath(a.path)
  if (typeof a.pattern === 'string') return a.pattern
  if (typeof a.query === 'string') return a.query
  if (typeof a.url === 'string') return a.url
  const keys = Object.keys(a)
  return keys.length ? keys.slice(0, 3).join(', ') : ''
}

function shortPath(p: string): string {
  return p
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~')
    .replace(/^\/home\/[^/]+/, '~')
    .replace(/^\/Users\/[^/]+/, '~')
}
