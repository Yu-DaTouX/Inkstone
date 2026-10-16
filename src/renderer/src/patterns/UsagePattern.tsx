/**
 * v3 启动页用量（pattern）。
 *
 * 复用 U2 的 `UsageOverview` 容器取数与 `UsageOverviewView` 展示结构，只把
 * 切换控件换成 v3 `ui/` 的 `Tabs` 原语，并用同目录 CSS 提供领域排版。
 *
 * - 不复制统计状态机或扫描器：取数、范围、模型与主子 Token 拆分仍走
 *   `UsageOverview` → `UsageOverviewView` 这一条链。
 * - 共享展示件与 v2 容器都不 import v3 控件或样式；本文件通过 `renderToggle`
 *   槽注入，所以 v2 首页缺省仍用原来的文字按钮，不会被 v3 外观污染。
 * - 本组件与 `usage-pattern.css` 只随 v3 入口加载（`V3EmptyState` → `UsagePattern`），
 *   不进入 v2 的值依赖链。
 */
import type { JSX, ReactNode } from 'react'
import { Tab, TabList, Tabs } from '../ui'
import { UsageOverview } from '../components/chat/UsageOverview'
import type { UsageToggleProps, UsageToggleRenderer } from '../components/chat/UsageOverviewView'
import './usage-pattern.css'
import { useUiV3 } from '../state/ui-v3'

/** v3 控件槽：外观来自 `ui/ui.css` 的 Tabs 原语（primitives 层），本文件不写按钮皮肤。 */
export const renderUsageToggle: UsageToggleRenderer = ({
  kind,
  value,
  options,
  onChange,
  label,
  testId
}: UsageToggleProps): ReactNode => (
  <Tabs
    className="usage-switch"
    selectedKey={value}
    onSelectionChange={(key) => onChange(String(key))}
    data-usage-control={kind}
    data-testid={testId}
  >
    <TabList className="usage-switch-list" aria-label={label}>
      {options.map((o) => (
        <Tab key={o.value} id={o.value}>
          {o.label}
        </Tab>
      ))}
    </TabList>
  </Tabs>
)

/** 生产入口：正式取数容器 + v3 控件槽；取数中 / 无记录时保留框架，不整块消失。 */
export function UsagePattern({ emptyNote }: { emptyNote?: string } = {}): JSX.Element {
  return <UsageOverview compact renderToggle={renderUsageToggle} keepWhenEmpty emptyNote={emptyNote} onOpenDetails={() => useUiV3.getState().navigate({ name: 'usage' })} />
}
