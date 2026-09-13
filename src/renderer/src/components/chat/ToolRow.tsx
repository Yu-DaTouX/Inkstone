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
 * 开关在设置 → 外观（`toolDetail`）：控制**已结束的**那些能不能点开看详情。
 *
 * ⚠️ 自动展开的只有**正在运行**的那条（用户要求：「只展示正在调用的详情，
 *    不要全部弹出」）。一次 agent 跑几十条命令是常态，
 *    已结束的全展开会把回答顶出屏幕。
 */
import { useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { TerminalWindow } from './Terminal'
import type { UIToolCall } from '../../../../shared/ipc'


/** 一行工具：图标 + 动词 + 目标 + 状态 */
export function ToolRow({ call }: { call: UIToolCall }) {
  const t = useT()
  /** 用户手动开关；null = 跟随设置里的默认值 */
  const detailOn = useStore((s) => s.settings?.toolDetail === true)
  const [manual, setManual] = useState<boolean | null>(null)

  const running = call.status === 'running' || call.status === 'pending'
  const failed = call.status === 'error'
  /*
   * 展开规则（用户要求：「只展示正在调用的详情，不要全部弹出」）。
   *
   * 旧实现是 `detailOn && !running` —— 正好反了：打开开关后
   * **已结束的**每一条都展开成终端窗口，正在跑的那条反而收起，
   * 一次跑十几条就把回答顶出屏幕（用户报的）。
   *
   * 现在：**只有正在跑的那条自动展开**；已结束的保持一行，
   * 要看详情自己点（设置里的 toolDetail 关掉则连点都不能点）。
   */
  const canExpand = detailOn || running
  const open = canExpand && (manual ?? running)

  const target = summarize(call)
  const secs = durationSecs(call)

  /* 动词：Codex 是「正在运行 / 已在 Ns 内运行」，我们按工具类型分 */
  const verb = running
    ? t('tool2.running', { what: verbOf(call.name, t) })
    : secs !== null
      ? t('tool2.doneIn', { n: secs, what: verbOf(call.name, t) })
      : t('tool2.done', { what: verbOf(call.name, t) })

  return (
    <div className={`trow ${open ? 'open' : ''}`} data-state={call.status} data-tool={call.name}>
      <button
        className="trow-head"
        onClick={() => {
          if (!canExpand) return
          setManual(!open)
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
        ) : null}
        {running || !canExpand ? null : (
          <Icon name="chevron-right" size={12} className={`chev ${open ? 'on' : ''}`} />
        )}
      </button>

      {open ? (
        <div className="trow-body">
          {/*
           * 终端窗口：标题栏放命令，正文等宽可滚，**可拖动调整大小**
           * （见 Terminal.tsx：下/右/右下三个把手 + 展开按钮）。
           */}
          <TerminalWindow call={call} target={target} secs={secs} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * 一组**已结束**的工具：折叠在「调用了 N 次工具/命令」下面（Codex 的「运行了命令 ⌄」）。
 *
 * ⚠️ 默认**收起**，而且**不因有工具在跑而自动展开**。
 *   历史上这里写过 `open = running && streaming` —— 结果是模型一调工具，
 *   整组（连同所有已结束的行）一起弹开，把回答顶出屏幕（用户报的）。
 *   正在运行的那条不再放进本组：它由 TurnView 单独渲染并自动展开详情，
 *   这样只有「当前在跑的工具」是打开的，其余保持一行。
 */
export function ToolGroup({ tools }: { tools: UIToolCall[] }) {
  const t = useT()
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? false

  if (tools.length === 0) return null

  return (
    <div className={`tgroup ${open ? 'open' : ''}`} data-testid="tool-group">
      <button className="tgroup-head" onClick={() => setManual(!open)} aria-expanded={open} data-testid="tool-group-toggle">
        <Icon name="chevron-right" size={12} className="chev" />
        <span>{t('tool2.ran', { n: tools.length })}</span>
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
