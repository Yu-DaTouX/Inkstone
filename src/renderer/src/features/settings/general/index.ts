/**
 * v3 设置「通用分区」（G1）入口。
 *
 * 六个分区：会话 / 通知与提醒 / 权限与安全 / 设备与同步 / 数据 / 关于与更新。
 * 每个组件自读真实 store 字段与既有 IPC，不接任何 props（关于页的模型导航除外，
 * 由根页按需注入）。分区 id、旧深链接映射与纯函数见 `./general-model`。
 *
 * 挂载由后续整合者按下发的精确补丁完成（`types.ts` / `SettingsPage.tsx` / 文案）。
 */
import './general.css'

export { SessionSettings } from './SessionSettings'
export { NotificationsSettings } from './NotificationsSettings'
export { SecuritySettings, AllowRootsList } from './SecuritySettings'
export { DevicesSettings, DeviceList } from './DevicesSettings'
export { DataSettings, StorageFacts } from './DataSettings'
export { AboutSettings, type AboutSettingsProps } from './AboutSettings'
export {
  GENERAL_LEGACY_MAP,
  GENERAL_SECTION_ORDER,
  DEFAULT_SOUND_SETTINGS,
  bytesText,
  formatWhen,
  mergeSound,
  removeAllowRoot,
  permissionNeedsConfirm,
  piSourceLabel,
  type GeneralSectionId
} from './general-model'
export { generalText, type GeneralText } from './general-text'
