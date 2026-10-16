/**
 * DeepLink（WP-20c）对外入口：解析、注册与转发。
 *
 * 主进程入口从这里 import；渲染端只经 preload 的 `onDeepLink` 拿已校验意图。
 */
export {
  DEEPLINK_PREFIX,
  DEEPLINK_SCHEME,
  DEEPLINK_SETTINGS_SECTIONS,
  MAX_DEEPLINK_ID_LENGTH,
  MAX_DEEPLINK_TEXT_LENGTH,
  MAX_DEEPLINK_URL_LENGTH,
  firstDeepLinkArg,
  parseDeepLink,
  parseDeepLinkFromArgv,
  parseDeepLinkFromOpenUrl
} from './protocol'
export type {
  DeepLink,
  DeepLinkAction,
  DeepLinkNewSession,
  DeepLinkParseResult,
  DeepLinkRejectReason,
  DeepLinkRuns,
  DeepLinkSession,
  DeepLinkSettings,
  DeepLinkSettingsSection
} from './protocol'

export { registerDeepLinkProtocol } from './register'
export type { DeepLinkRegisterOptions, ProtocolRegistrar } from './register'

export { DEEPLINK_CHANNEL, createDeepLinkRouter, windowDeepLinkRouter } from './service'
export type { DeepLinkRouter, DeepLinkTarget } from './service'
