/**
 * v3 空白会话的启动内容（`SessionView` 在 `turns.length === 0` 时渲染）。
 *
 * 职责边界：
 *   · 只保留问候与一行说明（沿用既有 `.v3-empty-greet` / `.v3-empty-hint` 外观）；
 *   · 宽对话区里用**同一** `UsageOverview` 数据链展示本机用量 —— 取数、范围、
 *     主子 Token 拆分都走 U2 的 API，本组件不复制 `useUsageStats` 或统计扫描；
 *     v3 外观与控件由 `patterns/UsagePattern` 提供。
 *   · 用量常驻：取数中 / 无记录时右栏仍保留框架；对话列窄于 760px 时右栏收起，
 *     改在说明下方显示一行用量条（同一取数钩子）。
 *   · 不迁移旧首页的项目 / 「从这里开始」/ 命令入口，也不新增卡片底色。
 *
 * `usage` 槽位默认是 `UsagePattern`（正式容器 + v3 `Tabs` 控件槽）；无 Electron 的
 * SSR 组合测试可以注入已取数的 `UsageOverviewView`，生产路径仍渲染同一条正式链。
 */
import type { JSX, ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { v3Text } from '../../app/v3-text'
import { UsagePattern } from '../../patterns/UsagePattern'
import { UsageStrip } from '../../patterns/UsageStrip'
import './v3-empty-state.css'

export interface V3EmptyStateProps {
  /** 用量槽位：缺省用 v3 `UsagePattern`；显式 `null` 则不渲染右栏。 */
  usage?: ReactNode
}

export function V3EmptyState({ usage }: V3EmptyStateProps = {}): JSX.Element {
  const { lang } = useI18n()
  const text = v3Text(lang)
  return (
    <div className="v3-empty v3-empty-page" data-testid="v3-empty">
      <div className="v3-empty-cols">
        <div className="v3-empty-main">
          <div className="v3-empty-greet">
            <span className="v3-empty-prompt" aria-hidden>&gt;</span>
            <span>HELLO WORLD<span className="v3-hello-cursor" aria-hidden>_</span></span>
          </div>
          {usage === null ? null : (
            <UsageStrip
              text={{ label: text.usageStripLabel, sessions: text.usageStripSessions, days: text.usageStripDays, recent: text.usageStripRecent }}
            />
          )}
        </div>
        {usage === undefined ? <UsagePattern emptyNote={text.usageEmptyNote} /> : usage}
      </div>
    </div>
  )
}
