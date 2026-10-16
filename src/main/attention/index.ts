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
