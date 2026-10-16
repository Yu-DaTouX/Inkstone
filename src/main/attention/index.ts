/** AttentionService 入口（v3 WP-12 / L12）：应用外注意投影，见 attention-service.ts。 */
export { createAttentionService } from './attention-service'
export type {
  AttentionService,
  AttentionServiceDeps,
  AttentionTrayPort,
  AttentionWindowPort
} from './attention-service'
export { summarizeAttention } from './summary'
export type { AttentionSummary } from './summary'
export { buildAttentionMenu } from './tray-menu'
export type {
  AttentionMenuCallbacks,
  AttentionMenuNode,
  TraySelectTarget,
  TraySessionStatus
} from './tray-menu'
/* 托盘柔和闪动（L12）：可注入播放器 + 预载素材装载。 */
export { createTrayAnimationPlayer } from './tray-animation'
export type {
  TrayAnimationClock,
  TrayAnimationPlayer,
  TrayAnimationPorts,
  TrayFrameSet as TrayAnimationFrameSet
} from './tray-animation'
export { createTrayAssetStore, validateManifest } from './tray-assets'
export type {
  TrayAnimationState,
  TrayAssetDeps,
  TrayAssetStore,
  TrayFrame,
  TrayFrameSet,
  TrayTheme
} from './tray-assets'
