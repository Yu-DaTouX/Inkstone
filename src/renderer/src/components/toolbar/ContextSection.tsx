import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import { Section } from './ToolSection'
import { useStore } from '../../state/store'
import {
  compactionGrowthText,
  compactionReclaimText,
  compactionRunningText,
  compactionSummary,
  compactionTokensText,
  compactionTone
} from '../../state/compaction-view'
import { CONTEXT_STAGES, contextStageLabel, contextStageTip, nextContextStageText } from '../../state/context-view'
import { nextContextStage, LARGE_PRESET_NAME_KEYS, largePresetOf, incompressibleBaselineNotice } from '../../../../shared/context-policy'
import { contextActionRows } from '../../state/context-actions-view'
import type { ContextActionSummary } from '../../../../shared/context-actions'
import { type CompactionInfo } from '../../../../shared/ipc'
import { Button, MiniMeter, RunDot } from '../ui'

export function ContextSection() {
  const t = useT()
  const stats = useStore((s) => s.stats)
  const messages = useStore((s) => s.messages)
  const contextActionRefresh = messages.length
  const session = useStore((s) => s.session)
  const compactNow = useStore((s) => s.compact)
  const setAutoCompaction = useStore((s) => s.setAutoCompaction)
  const cu = stats?.contextUsage
  const modelKey = session?.model ? `${session.model.provider}/${session.model.id}` : undefined
  const statsMatchModel = !!cu && (!cu.modelKey || cu.modelKey === modelKey)
  /* 模型切换后先用新模型的窗口；旧模型的 token 快照不能冒充当前容量。 */
  const win = session?.model?.contextWindow ?? (statsMatchModel ? cu?.contextWindow : undefined) ?? 0
  /*
   * pi 在「刚压缩完、还没有下一条带 usage 的助手消息」时会**故意**把
   * tokens / percent 报成 null（见 pi 的 getContextUsage：latestCompaction 之后
   * 找不到新的 usage 就返回 null）。
   *
   * 所以这里不能用 `?? 0` —— 那会把它显示成「0 tokens / 0.0% 已用」，
   * 看起来像是进度条坏了（用户报的「手动压缩后不显示进度」）。
   * 区分「未知」与「真的是 0」是这里的核心。
   */
  const known = statsMatchModel && typeof cu?.tokens === 'number'
  const used = known ? (cu?.tokens as number) : 0
  /*
   * 工作集视角（N21-3）：策略生效时主值就是**砚真正用来判断的那条线**，
   * 而不是物理窗口 —— 1M 模型上写「3%」会让用户以为还早得很，
   * 而砚在 240k 就会动手。预算由主进程随会话状态推送（同一个对象，不重算）。
   */
  const policy = session?.contextPolicy
  /** 运行期拼出来的 i18n key（`set.ctxSource.model` 这类）要断言一次，见 ContextTab 同款注释 */
  const tk = (key: string): string => t(key as MessageKey)
  /*
   * C-5 尾：默认行要不要说「现在用的是哪一档」。
   * 判据只看**精确模型层原文** —— `source === 'model'` 也可能是用户手填的自定义数，
   * 那种情况不该被叫成「均衡 600K」档。
   */
  const presetName = policy?.modelOverrides ? largePresetOf(policy.modelOverrides) : undefined
  const workingSet = policy && policy.budget.workingSet > 0 ? policy.budget.workingSet : 0
  const workingSetMode = workingSet > 0
  /*
   * 两个尺度各说一半真话，分开摆、各自标名：
   *   · 分区头部（常驻）= 物理窗口：「4% 40k / 1M」+ 迷你条；
   *   · 展开体 = 工作集：「工作集 17% 40k / 240k」+ 按工作集画的进度条，
   *     清理 / 折叠 / 压缩三条刻度落在 70% / 85% / 100%，名字写在刻度下。
   * 只给工作集会出现 `240k / 240k = 100%`，被读成「1M 模型满了」；只给窗口
   * 又会让人以为「还早得很」，而砚在 240k 就已经会动手。
   * 没有策略（工作集不可得）时展开体的条退回窗口尺度，画 pi 的压缩触发线。
   */
  const policyWindow = policy?.budget.contextWindow
  const effectiveWin = policyWindow && policyWindow > 0 ? policyWindow : win
  const pctWindow = known && effectiveWin > 0 ? (used / effectiveWin) * 100 : 0
  /* 压力色只看工作集 —— 它才是砚的动手线（物理窗口满之前早就过线了） */
  const pctWork = known && workingSetMode ? (used / workingSet) * 100 : pctWindow
  const tone = pctWork >= 95 ? 'err' : pctWork >= 85 ? 'warn' : 'ok'
  /** 阶段触发点（token）与它在工作集尺度上的位置（%）；刻度与刻度名共用 */
  const stageAt = (kind: (typeof CONTEXT_STAGES)[number]): number => {
    const tr = policy?.budget.triggers
    if (!tr) return 0
    return kind === 'tool-sweep' ? tr.sweep : kind === 'episode-fold' ? tr.fold : tr.compact
  }
  const stageLeft = (at: number): number => Math.max(0, Math.min(100, workingSet > 0 ? (at / workingSet) * 100 : 0))
  const cost = [...messages].reverse().find((m) => m.role === 'assistant' && m.usage)?.usage?.cost ?? 0

  /* 压缩的可观测状态（N21-2）：进行中的原因 + 已结束的最近一次，都来自主进程的 RPC 事件归一化 */
  const compaction = session?.compaction
  const lastCompaction = session?.lastCompaction

  /*
   * 三类整理的动作账本（实施-11 C-2b）。
   *
   * 为什么要单独读：`tool-sweep`（清扫）与 `episode-fold`（状态刷新）
   * **不产生** pi 的 `compaction_*` 事件 —— 只看 `lastCompaction` 的话，
   * 「清扫跑了、状态刷新没跑」和「两个都没跑」在界面上长得一模一样。
   * 账本由扩展写、宿主读；读不到（还没发生过 / 旧会话）就是空统计。
   */
  const [actions, setActions] = useState<ContextActionSummary | null>(null)
  useEffect(() => {
    let live = true
    const refresh = (): void => {
      void window.yan
        .contextActions()
        .then((value) => {
          if (live) setActions(value)
        })
        .catch(() => undefined)
    }
    refresh()
    /* The extension ledger is written outside the renderer state stream. Refresh while
       this section is mounted so a completed sweep appears without changing sessions. */
    const timer = window.setInterval(refresh, 1_500)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [session?.sessionId, lastCompaction?.endedAt, lastCompaction?.status, contextActionRefresh])
  const actionRows = useMemo(() => contextActionRows(t, actions, lastCompaction), [t, actions, lastCompaction])

  /*
   * 阶段名默认收在各自刻度左下；刻度只隔 15% 工作集，窄栏或英文（Compact）
   * 下名字可能比间距还宽。量到重叠时改成右对齐的一排文字（data-crowded），
   * 宁可不贴刻度也不叠字。先去掉标记再量，才量得到「贴刻度」时的真实位置。
   * 用回调 ref：分区从收起到展开时这一行才挂上，普通 effect 会错过它。
   */
  const stagesObserver = useRef<ResizeObserver | null>(null)
  const stageKey = workingSetMode ? `${policy!.kinds.join(',')}|${policy!.budget.triggers.sweep}|${policy!.budget.triggers.fold}|${workingSet}` : ''
  const stagesRef = useCallback((el: HTMLDivElement | null) => {
    stagesObserver.current?.disconnect()
    stagesObserver.current = null
    if (!el) return
    const check = (): void => {
      delete el.dataset.crowded
      const box = el.getBoundingClientRect()
      const rects = [...el.children].map((c) => c.getBoundingClientRect()).sort((a, b) => a.left - b.left)
      const crowded = rects.some((r, i) => (i === 0 ? r.left < box.left : r.left < rects[i - 1].right + 4))
      if (crowded) el.dataset.crowded = '1'
    }
    check()
    stagesObserver.current = new ResizeObserver(check)
    stagesObserver.current.observe(el)
    // stageKey / t 变了（刻度位置或名字变了）要重新量
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageKey, t])

  /* 工作集刻度的下一步（N21-3）：只预报**真的会执行**的阶段 */
  const nextStage = policy ? nextContextStage(known ? used : null, policy.budget, policy.kinds) : null
  /*
   * 低回收提示（C-6）：上一次压缩后仍停在软线 80% 以上、且新增还没到门槛时，
   * 直说“为什么现在不着手”。数据不齐时不显示（不编原因）。
   */
  const incompressible =
    policy && incompressibleBaselineNotice(known ? used : null, policy.budget, lastCompaction?.afterTokens)

  const nf = new Intl.NumberFormat('en-US')

  /*
   * 自动压缩的触发点（用户要求：「显示什么时候开始自动压缩上下文」）。
   *
   * 数据来自 pi 自己的设置文件（main/compaction.ts）—— **不能写死 16384**：
   * 用户可以在 pi 的 settings.json 里改 reserveTokens，
   * 而界面上的这个数字是他判断「还能聊多久」的依据（丢了上下文就没了）。
   * 窗口大小变化（换模型）时重算。
   */
  const [compact, setCompact] = useState<CompactionInfo | null>(null)
  useEffect(() => {
    if (!win) return
    let alive = true
    void window.yan
      .compactionInfo(win)
      .then((r) => {
        if (alive) setCompact(r)
      })
      .catch(() => {
        /* 读不到就不显示这一行 —— 不能因此把上下文分区弄崩 */
      })
    return () => {
      alive = false
    }
  }, [win])

  /** 触发点在进度条上的位置（%） */
  const thresholdPct =
    compact && compact.contextWindow > 0 ? (compact.threshold / compact.contextWindow) * 100 : 0
  /** 距离触发还差多少 tokens（≤ 0 = 已经过线） */
  const untilCompact = compact ? compact.threshold - used : 0
  /** 详情（阈值 / 保留量 / 预留 token / 累计花费）默认收起（方案 7.3） */
  const [detailsOpen, setDetailsOpen] = useState(false)
  /** 84k / 200k 这种紧凑写法（方案 7.3 的示例写法） */
  const fmtK = (n: number): string => n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

  return (
    <Section titleKey="rp.context" testId="rp-context" defaultOpen compactWhenFloating extra={
      /*
       * 压缩中就把摘要位让给状态（用户 2026-09-25：压缩时界面上好几处都在转，
       * 只留这一个）。
       *
       * ⚠️ 必须放**头部**而不是展开体里：上下文卡默认是收起的，写进展开体
       *    就等于压缩期间一个提示都看不到（实测收起的卡里那行根本不在 DOM）。
       */
      session?.isCompacting ? (
        <span className="rp-header-usage rp-header-compacting">
          <RunDot />
          {/*
           * 「压缩中 · 已达阈值」（N21-2）：只说“正在压缩”回答不了用户当下最想
           * 知道的 —— 为什么突然在压缩？原因来自 pi 的 `compaction_start.reason`。
           * 拿不到原因时退回短的 `status.compacting`，不编一个原因。
           */}
          <span className="rp-header-values" data-testid="ctx-compacting-reason">
            {compactionRunningText(t, compaction)}
          </span>
        </span>
      ) : (
        <span className="rp-header-usage">
          <span className="rp-header-values">
            {known ? (
              <span className={tone}>
                <b>{`${Math.round(pctWindow)}%`}</b> <span className="rp-header-k rp-header-sub">{`${fmtK(used)}/${fmtK(effectiveWin)}`}</span>
              </span>
            ) : (
              <span className="rp-header-k">{t('ctx.usageUnknown')}</span>
            )}
          </span>
          {/* 条按物理窗口画，颜色按工作集压力（与展开体同一档） */}
          <MiniMeter percent={known ? pctWindow : null} tone={known ? tone : ''} />
        </span>
      )
    }>
      {/* 保留主值节点供现有探针读取；视觉主值由上方 mini 摘要承载。 */}
      <div className="rp-ctx-main" data-testid="ctx-main" data-mode={workingSetMode ? 'working-set' : 'window'}>
        <span className={`rp-v big ${known ? tone : ''}`}>{known ? `${pctWindow.toFixed(0)}%` : '—'}</span>
        <span className="spacer" />
        <span className="rp-u" data-testid="ctx-tokens">
          {known ? `${fmtK(used)} / ${fmtK(effectiveWin)}` : '—'}
        </span>
      </div>
      {/*
       * 工作集那一行（C-5）：主值是物理尺度，这里说清砚什么时候动手。
       * 没有策略（工作集不可得）时不显示 —— 不编一条不存在的线。
       */}
      {workingSetMode ? (
        <div className="rp-working-summary" data-testid="ctx-working-set-line">
          <span className="rp-working-k">{t('ctx.workingSetLabel')}</span>
          <span className="rp-working-v">
            {known ? <><b className={tone}>{`${Math.round(pctWork)}%`}</b>{' '}</> : null}
            {`${known ? fmtK(used) : '—'} / ${fmtK(workingSet)}`}
          </span>
        </div>
      ) : null}

      {/*
        档位行（C-5 尾）：区分「试行档」与「自定义数值」——
        之前 600K/700K 的名字只在设置页，右栏只写工作集数字，
        用户没法从右栏回答「我现在到底在哪个档上」。
      */}
      {presetName ? (
        <div className="rp-dim" data-testid="ctx-preset" data-preset={presetName}>
          {t('ctx.presetLine', { name: tk(LARGE_PRESET_NAME_KEYS[presetName]) })}
        </div>
      ) : null}

      <div
        className={`rp-meter ${known ? tone : 'unknown'}`}
        title={
          known
            ? workingSetMode
              ? t('ctx.tipWorkingSet', {
                  used: nf.format(used),
                  cap: nf.format(workingSet),
                  pct: pctWork.toFixed(1),
                  win: nf.format(effectiveWin)
                })
              : t('ctx.tip', { used: nf.format(used), win: nf.format(effectiveWin), pct: pctWindow.toFixed(1) })
            : t('ctx.afterCompact')
        }
      >
        <i style={{ width: `${Math.min(100, pctWork)}%` }} />
        {workingSetMode ? (
          /*
           * 工作集刻度（N21-3）：三条线都在同一个尺度上（工作集 × 70/85/100%），
           * 但它们**不是同一回事** —— 只有压缩现在真的会触发，
           * 清理 / 折叠要等阶段 4 的上下文扩展。所以未接管的画成虚线，
           * 并把“什么时候才会真的发生”放进 title（不上色、不装成生效了）。
           */
          CONTEXT_STAGES.map((kind) => {
            const at = stageAt(kind)
            const active = policy!.kinds.includes(kind)
            /* 刻度与填充同一个分母（工作集），否则会跑到条外去 */
            const left = stageLeft(at)
            return (
              <b
                key={kind}
                className={`rp-stage ${active ? 'active' : 'planned'} ${left >= 97 ? 'end' : ''}`}
                data-testid="ctx-stage-mark"
                data-kind={kind}
                data-active={active ? '1' : '0'}
                style={{ left: `${left}%` }}
                title={contextStageTip(t, kind, { at, ratio: left / 100, active })}
              />
            )
          })
        ) : compact?.enabled && thresholdPct > 0 && thresholdPct < 100 ? (
          /*
           * 物理窗口视角：自动压缩的触发线画在进度条上，而不只写一个数字 ——
           * 用户真正想知道的是「离那条线还有多远」，那就把线画出来。
           */
          <b
            className="rp-threshold"
            data-testid="ctx-threshold-mark"
            style={{ left: `${thresholdPct}%` }}
            title={t('ctx.thresholdTip', { n: nf.format(compact.threshold) })}
          />
        ) : null}
      </div>

      {/* 阶段名收在各自刻度左下；未接管的更淡（title 里说明何时才会真的发生） */}
      {workingSetMode ? (
        <div className="rp-stages" ref={stagesRef} data-testid="ctx-stages" title={t('ctx.stagesTip')}>
          {CONTEXT_STAGES.map((kind) => {
            const active = policy!.kinds.includes(kind)
            const at = stageAt(kind)
            const left = stageLeft(at)
            return (
              <span
                key={kind}
                className={`rp-stage-label ${active ? 'active' : 'planned'}`}
                style={{ left: `${left}%` }}
                data-testid="ctx-stage-chip"
                data-kind={kind}
                data-active={active ? '1' : '0'}
                /* 说明也挂在名字上：用户是看着这三个词问“它们是干什么的” */
                title={contextStageTip(t, kind, { at, ratio: left / 100, active })}
              >
                {contextStageLabel(t, kind)}
              </span>
            )
          })}
        </div>
      ) : null}

      {/*
        工作集模式下的「下一步」（N21-3）：只预报真的会执行的那个阶段。
        已过线时改说“已达工作集上限” —— 站在线上还报“约 240k 时”是废话。

        C-6：低回收且新增不足时**抑制这一行** —— 它上面会写“本回合结束后自动压缩”，
        而防抖其实把这次压缩延后了，两行摆在一起是自相矛盾的。
      */}
      {workingSetMode && nextStage && !incompressible ? (
        <div className={nextStage.reached ? 'rp-dim warn' : 'rp-dim'} data-testid="ctx-next-stage" data-kind={nextStage.kind} data-reached={nextStage.reached ? '1' : '0'}>
          {nextContextStageText(t, nextStage)}
        </div>
      ) : null}

      {/*
        低回收提示（C-6）：上次压缩压不动、新增也还没到门槛时，说清“为什么不着手”——
        否则界面停在“已达工作集”却不动作，看起来像坏了。
      */}
      {workingSetMode && incompressible ? (
        <div className="rp-dim warn" data-testid="ctx-incompressible">
          {t('ctx.incompressible')}
        </div>
      ) : null}


      {/*
        自动压缩的触发点**只在进度条上画一条记号**（用户要求）：
        「不要显示自动压缩还差多少多少多少，在进度条上有记号即可」。
        记号右边还有一行说明 —— 但只在**已经过线**时才出现
        （那时它是警告，不是冗余信息）。

        工作集模式下这条不渲染：那条线是 pi 自己的（已经远在工作集之上），
        而「已达工作集上限」那行上面已经说过了 —— 两行同时出现只是噪声。
      */}
      {!workingSetMode && compact?.enabled && untilCompact <= 0 ? (
        <div className="rp-dim err" data-testid="ctx-compaction">
          {t('ctx.atCompact')}
        </div>
      ) : null}

      {/*
        刚压缩完：pi 还报不出新的 contextUsage（tokens=null）。
        不是“没了”，只是要等下一轮才有新数据 —— 明说一句，别让用户以为坏了。
      */}
      {cu && cu.tokens === null ? (
        <div className="rp-dim" data-testid="ctx-unknown">
          {t('ctx.afterCompact')}
        </div>
      ) : null}

      {/*
        自动压缩的开关与手动入口（阶段 1 归位）。

        它属于「上下文」本身，所以紧跟进度条与状态提示 —— 之前它排在
        「详情」折叠区下面，视觉上像第二个工具（用户报的问题）。
        标签改用 ctx.* 域，与这一块其余文案同一命名空间。

        `rp-ctx-actions`：这一行里混了**按钮**与纯文本，不能沿用 `.rp-kv` 的
        `align-items: baseline`（24px 的按钮与 17px 的文字会错位，窄栏下按钮
        还会折成两行 —— 用户截图里的「压缩上/下文」）。见 tools.css 里的说明。
      */}
      <div className="rp-kv rp-ctx-actions" data-testid="rp-context-actions">
        <span className="rp-k">{t('ctx.autoCompact')}</span>
        {/* 不用 .spacer：在这个窄行里它自己要吃掉两个 gap（16px），
            而这十几 px 正是按钮文字够不够用的临界值 —— 改用 CSS 的 margin-left:auto */}
        <button
          className={`switch-pill ${session?.autoCompactionEnabled !== false ? 'on' : ''}`}
          role="switch"
          aria-checked={session?.autoCompactionEnabled !== false}
          data-testid="rp-auto-compact"
          title={t('status.autoCompactHint')}
          onClick={() => void setAutoCompaction(!(session?.autoCompactionEnabled !== false))}
        >
          <span className="switch-knob" />
        </button>
        <Button size="sm" icon={session?.isCompacting ? 'refresh' : 'compact'} data-testid="rp-compact-now" disabled={!!session?.isStreaming || !!session?.isCompacting} title={t('status.compact')} onClick={() => void compactNow()}><span>{session?.isCompacting ? t('status.compacting') : t('status.compact')}</span>
        </Button>
      </div>

      {/*
       * 详情：容量参数与花费，分两组，默认收起（方案 7.3 + 阶段 1 分组）。
       *
       * 只读的「自动压缩 开/关」行已删除：上面就是可切换的同一个开关，
       * 两处同时出现正是「看起来像两个工具」的一部分。
       * 这里只放**真实生效**的 pi 参数（阶段 1 不提前展示尚未接管的工作集）。
       */}
      <button
        className="rp-details-toggle"
        onClick={() => setDetailsOpen((v) => !v)}
        aria-expanded={detailsOpen}
        data-testid="ctx-details-toggle"
      >
        <Icon name="chevron-right" size={12} className={`chev ${detailsOpen ? 'on' : ''}`} />
        {t('ctx.details')}
      </button>

      {detailsOpen ? (
        <div className="rp-details" data-testid="ctx-details">
          <div className="rp-group">{t('ctx.groupCapacity')}</div>
          {workingSetMode ? (
            <>
              {/*
                工作集的三个数（N21-3）：上限定下来之后，用户才能把「为什么 240k」
                算清楚。它们与砚内部用的是同一份预算（主进程随状态推送），
                不是渲染端照公式再算一遂的副本。
                ⚠️ 「工作集预留」与 pi 自己的「为回答预留」是两个数：前者进工作集
                公式，后者（reserveTokens）只决定 pi 那条原生触发线。标签必须
                分开写 —— 同一个面板里同名不同值是 D21 那类误解的温床。
              */}
              <div className="rp-kv" data-testid="ctx-working-set">
                <span className="rp-k">{t('ctx.workingSet')}</span>
                <span className="spacer" />
                <span className="rp-v" title={t('ctx.workingSetTip')}>
                  {nf.format(workingSet)}
                </span>
              </div>
              <div className="rp-kv" data-testid="ctx-reserve-computed">
                <span className="rp-k">{t('ctx.reserveWorkingSet')}</span>
                <span className="spacer" />
                <span className="rp-v">{nf.format(policy!.budget.responseReserve)}</span>
              </div>
              <div className="rp-kv" data-testid="ctx-safety-margin">
                <span className="rp-k">{t('ctx.safetyMargin')}</span>
                <span className="spacer" />
                <span className="rp-v">{nf.format(policy!.budget.safetyMargin)}</span>
              </div>
            </>
          ) : null}
          <div className="rp-kv">
            <span className="rp-k">{t('ctx.window')}</span>
            <span className="spacer" />
            <span className="rp-v">{win ? nf.format(win) : '—'}</span>
          </div>
          {workingSetMode ? (
            <div className="rp-kv" data-testid="ctx-emergency">
              <span className="rp-k">{t('ctx.emergency')}</span>
              <span className="spacer" />
              <span
                className="rp-v"
                title={t('ctx.emergencyTip', { pct: Math.round((policy!.budget.emergency / policy!.budget.contextWindow) * 100) })}
              >
                {nf.format(policy!.budget.emergency)}
              </span>
            </div>
          ) : null}
          <div className="rp-kv">
            {/* 工作集模式下这条线是 pi 自己的（作为兜底保留） */}
            <span className="rp-k">{workingSetMode ? t('ctx.thresholdPi') : t('ctx.threshold')}</span>
            <span className="spacer" />
            <span
              className="rp-v"
              title={compact ? t('ctx.scopeTip', { scope: t(compact.scope === 'project' ? 'ctx.scopeProject' : 'ctx.scopeGlobal') }) : undefined}
            >
              {compact ? nf.format(compact.threshold) : '—'}
            </span>
          </div>
          <div className="rp-kv">
            <span className="rp-k">{t('ctx.keep')}</span>
            <span className="spacer" />
            <span className="rp-v">{compact ? nf.format(compact.keepRecentTokens) : '—'}</span>
          </div>
          <div className="rp-kv">
            {/* 工作集模式下这个名字要与上面的「工作集预留」区分开 */}
            <span className="rp-k">{workingSetMode ? t('ctx.reservePi') : t('ctx.reserve')}</span>
            <span className="spacer" />
            <span className="rp-v">{compact ? nf.format(compact.reserveTokens) : '—'}</span>
          </div>
          {/*
            项目里配了压缩参数、pi 却不会读它（D21）：
            不说的话，用户改的是 `.pi/settings.json`，看到的却是一条永远对不上的
            触发线 —— 而 “界面数字与实际生效值不符” 正是这一块最不能容忍的错。
            完整解释放 `title`，面板里只留一句短的。
          */}
          {compact?.projectIgnored ? (
            <div className="rp-dim warn" data-testid="ctx-project-ignored" title={t('ctx.projectIgnoredTip')}>
              {t('ctx.projectIgnored')}
            </div>
          ) : null}
          {/*
            容量来源（C-5 尾）：这些数到底是默认、用户设的、还是模型级 / env 推的。
            设置页的 `ctx-source` 早就有这条，但用户看右栏数字时不该被逼回设置页 ——
            「界面上的数 ≠ 真正在用的数」正是这一块最不能容忍的错。
          */}
          {policy ? (
            <div className="rp-kv" data-testid="ctx-source-line" title={t('ctx.sourceLineTip')}>
              <span className="rp-k">{t('ctx.sourceLine')}</span>
              <span className="spacer" />
              <span className="rp-v">
                {`${tk(`set.ctxSource.${policy.source}`)}${policy.sourceKey ? ` · ${policy.sourceKey}` : ''}`}
              </span>
            </div>
          ) : null}
          <div className="rp-group">{t('ctx.groupSpend')}</div>
          <div className="rp-kv" data-testid="ctx-cost">
            <span className="rp-k">{t('rp.spent')}</span>
            <span className="spacer" />
            <span className="rp-v">${cost.toFixed(4)}</span>
          </div>
          {/*
            最近一次压缩（N21-2）。

            为什么放在「详情」而不是主视区：它不是用户每轮都要看的数，
            但“上下文突然变短了”时是唯一能解释原因的地方（什么时候压的、为什么）。

            为什么没有记录时**整行不渲染**：从磁盘打开的历史会话可能早就压缩过，
            而砚现在不读会话文件里的 compaction 条目 —— 写「未发生过」会是假陈述。
          */}
          {lastCompaction ? (
            <>
              <div
                className="rp-kv"
                data-testid="ctx-last-compaction"
                title={t('ctx.lastCompactionTip')}
              >
                <span className="rp-k">{t('ctx.lastCompaction')}</span>
                <span className="spacer" />
                <span className={`rp-v ${lastCompaction.status === 'completed' ? '' : compactionTone(lastCompaction)}`}>
                  {compactionSummary(t, lastCompaction)}
                </span>
              </div>
              {/* 「1.6k → 160」：上下文到底短了多少（pi 不报就不显示） */}
              {compactionTokensText(lastCompaction) ? (
                <div className="rp-dim" data-testid="ctx-last-compaction-tokens">
                  {compactionTokensText(lastCompaction)}
                </div>
              ) : null}
              {/*
               * C-2 的两个派生量：这次回收了多少、以及压完到现在又新增多少。
               *
               * `used` 只在 pi 报了当前用量时才有值（刚压缩完它会故意报 null），
               * 所以「此后新增」拿不到数就不显示 —— 不能把“还没测”写成“没新增”。
               * 「回收 XX%」在压缩完成后总是给一句（含「待测」），因为它回答的是
               * 用户看完压缩后最直接的问题：这次到底有没有用。
               */}
              {lastCompaction.status === 'completed' ? (
                <div className="rp-dim" data-testid="ctx-last-compaction-reclaim">
                  {compactionReclaimText(t, lastCompaction)}
                  {(() => {
                    const growth = compactionGrowthText(t, lastCompaction, known ? used : undefined)
                    return growth ? ` · ${growth}` : ''
                  })()}
                </div>
              ) : null}
              {/*
               * 失败/被跳过时**必须**有话说：pi 的原文（英文）原样透传，
               * 不翻译也不吞（约定：pi 内置错误一律原样透传）。
               */}
              {lastCompaction.error ? (
                <div className="rp-dim err" data-testid="ctx-last-compaction-error">
                  {lastCompaction.error}
                </div>
              ) : lastCompaction.status === 'declined' ? (
                <div className="rp-dim" data-testid="ctx-last-compaction-note">
                  {t('ctx.declinedTip')}
                </div>
              ) : null}
            </>
          ) : null}

          {/*
            C-2b：三类整理**分开**显示。
            前两类来自扩展写的动作账本，第三类来自 pi 事件 —— 行首没有合并，
            所以“清扫跑了但状态没刷新”看得出来。没发生过就写「未发生」，
            不用空白让它看起来像“没这一项”。
          */}
          <div className="rp-group" data-testid="ctx-actions-group">
            {t('ctx.actions')}
          </div>
          {actionRows.map((row) => (
            <div key={row.kind} data-testid={`ctx-action-${row.kind}`}>
              <div
                className="rp-kv"
                title={row.fromLedger ? t('ctx.actionsTip') : t('ctx.lastCompactionTip')}
              >
                <span className="rp-k">{t(row.labelKey as MessageKey)}</span>
                <span className="spacer" />
                <span className="rp-v">{row.countText ?? t('ctx.actionNone')}</span>
              </div>
              {row.detail ? <div className="rp-dim">{row.detail}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
    </Section>
  )
}
