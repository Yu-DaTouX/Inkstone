import type { ReactElement } from 'react'
import { SettingsPage } from '../features/settings/root'
import { installSettingsDeepLink } from '../features/settings/root/deep-link'

/*
 * 安装一次正式 `openSettings(name)` 的只读订阅：外壳静态引用本模块后即生效，
 * 不依赖面板是否挂载，这样从会话页触发的旧深链接也能落到对应 v3 分区。
 */
installSettingsDeepLink()

export interface SettingsPanelV3Props {
  /** 外壳的「返回」；沿用与 R0 约定的 `{ onBack, onRuns }` 签名。 */
  onBack?: () => void
  /** 「运行总览」入口；不传时用量页走正式 v3 路由。 */
  onRuns?: () => void
  /** 「重新查看首次引导」入口；由外壳注入到关于页。 */
  onShowOnboarding?: () => void
}

/**
 * v3 设置页入口（WP-43 / S0）。
 *
 * 全页不是 modal：分区导航与内容随路由常驻，返回与键盘可达由外壳 Header 负责。
 * 实际结构与分区实现见 `features/settings/root/SettingsPage`。
 */
export function SettingsPanelV3({ onBack, onRuns, onShowOnboarding }: SettingsPanelV3Props = {}): ReactElement {
  return <SettingsPage onBack={onBack} onRuns={onRuns} onShowOnboarding={onShowOnboarding} />
}
