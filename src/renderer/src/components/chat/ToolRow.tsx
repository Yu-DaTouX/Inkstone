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
import { FileChangeDetail, ToolResultDetail, detailKind } from './ToolDetails'
import type { UIToolCall } from '../../../../shared/ipc'


/** 一行工具：图标 + 动词 + 目标 + 状态 */
function ToolRowImpl({ call, autoOpen = true }: { call: UIToolCall; autoOpen?: boolean }) {
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
  const target = summarize(call)
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
        data-testid="tool-row"
      >
        <span className="trow-ico" aria-hidden>
          {running ? <Icon name="refresh" size={12} className="spin" /> : toolGlyph(call.name, failed)}
        </span>
        <span className="trow-verb">{verb}</span>
        <span className="trow-target" data-testid="tool-target">
          {target || t('tool2.noTarget')}
        </span>
        <span className="spacer" />
        {failed ? (
          <span className="trow-badge err">{t('tool.failed')}</span>
        ) : cancelled ? (
          <span className="trow-badge warn">{t('tool.cancelled')}</span>
        ) : null}
        {running ? null : (
          <Icon name="chevron-right" size={12} className={`chev ${open ? 'on' : ''}`} />
        )}
      </button>

      {open ? (
        <div className="trow-body">
          {/*
           * 按调用类型选详情组件（方案 4.1）：
           *   命令 → 紧凑终端；文件改动 → 改动卡片；其余 → 直接给结果。
           * 以前所有工具都套终端窗口，搜索/读文件看起来像跑过 shell。
           */}
          {kind === 'command' ? (
            <TerminalWindow call={call} target={target} secs={secs} />
          ) : kind === 'change' ? (
            <FileChangeDetail call={call} />
          ) : (
            <ToolResultDetail call={call} />
          )}
        </div>
      ) : null}
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
function sameCall(a: UIToolCall, b: UIToolCall): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.name === b.name &&
      a.status === b.status &&
      a.cancelled === b.cancelled &&
      a.output === b.output &&
      a.argsRaw === b.argsRaw &&
      a.args === b.args &&
      a.details === b.details &&
      a.startedAt === b.startedAt &&
      a.endedAt === b.endedAt)
  )
}

export const ToolRow = memo(ToolRowImpl, (a, b) => a.autoOpen === b.autoOpen && sameCall(a.call, b.call))

/**
 * 一组**已结束**的工具：折叠在「调用了 N 次工具/命令」下面（Codex 的「运行了命令 ⌄」）。
 *
 * ⚠️ 默认**收起**，而且**不因有工具在跑而自动展开**。
 *   历史上这里写过 `open = running && streaming` —— 结果是模型一调工具，
 *   整组（连同所有已结束的行）一起弹开，把回答顶出屏幕（用户报的）。
 *   正在运行的那条不再放进本组：它由 TurnView 单独渲染并自动展开详情，
 *   这样只有「当前在跑的工具」是打开的，其余保持一行。
 */
function ToolGroupImpl({ tools }: { tools: UIToolCall[] }) {
  const t = useT()
  const [manual, setManual] = useState<boolean | null>(null)
  /*
   * 组里有失败的 → 标题上标出来，但**默认仍然收起**（N03）。
   *
   * 历史上有过两版自动展开规则，都被用户报过：
   *   · `open = running && streaming`：模型一调工具，整组十几行一起弹开；
   *   · `open = failedCount > 0`：一条失败就把整组展开，同样抢版面。
   * 现在自动展开必须由用户显式打开 `toolDetail`，失败只靠
   * 「N 个失败」角标 + 行内红色状态提示 —— 一眼看得出有东西挂了，
   * 但不替用户决定要不要展开。
   */
  const failedCount = tools.filter((c) => c.status === 'error').length
  const open = manual ?? false

  if (tools.length === 0) return null

  return (
    <div className={`tgroup ${open ? 'open' : ''} ${failedCount > 0 ? 'has-fail' : ''}`} data-testid="tool-group">
      <button className="tgroup-head" onClick={() => setManual(!open)} aria-expanded={open} data-testid="tool-group-toggle">
        <Icon name="chevron-right" size={12} className="chev" />
        <span>{t('tool2.ran', { n: tools.length })}</span>
        {failedCount > 0 ? (
          <span className="tgroup-fail" data-testid="tool-group-fail">
            {t('tool2.failed', { n: failedCount })}
          </span>
        ) : null}
        <span className="spacer" />
      </button>
      {open ? (
        <div className="tgroup-body">
          {tools.map((c) => (
            <ToolRow key={c.id} call={c} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 组的 memo：比较的也是「渲染上等价」——长度相同且逐条 sameCall。
 *
 * 不比较数组引用：`TurnActivity` 每次都用 filter 新建数组，引用永远不相等，
 * 用默认比较等于没 memo。
 */
export const ToolGroup = memo(ToolGroupImpl, (a, b) => {
  if (a.tools === b.tools) return true
  if (a.tools.length !== b.tools.length) return false
  for (let i = 0; i < a.tools.length; i++) {
    if (!sameCall(a.tools[i], b.tools[i])) return false
  }
  return true
})



/** 动词：按工具类型给一个中文动作词 */
function verbOf(name: string, t: (k: 'tool2.vRun' | 'tool2.vRead' | 'tool2.vEdit' | 'tool2.vWrite' | 'tool2.vSearch' | 'tool2.vCall') => string): string {
  if (name === 'bash') return t('tool2.vRun')
  if (name === 'read' || name === 'list') return t('tool2.vRead')
  if (name === 'edit') return t('tool2.vEdit')
  if (name === 'write') return t('tool2.vWrite')
  if (name === 'grep' || name === 'glob' || name === 'web_search' || name === 'fetch') return t('tool2.vSearch')
  return t('tool2.vCall')
}

/** 状态图标：成功 ✓ / 失败 ✕（Codex 用的是 ✓ 勾） */
function toolGlyph(name: string, failed: boolean) {
  if (failed) return <Icon name="alert-circle" size={12} />
  void name
  return <span className="trow-check">✓</span>
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
