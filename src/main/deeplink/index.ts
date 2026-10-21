export { firstDeepLinkArg, parseDeepLink } from './protocol'
export type {
  DeepLink,
  DeepLinkNewSession,
  DeepLinkParseResult,
  DeepLinkRejectReason,
  DeepLinkSession,
  DeepLinkSettings,
  DeepLinkSettingsSection
} from './protocol'

export { registerDeepLinkProtocol } from './register'
export type { DeepLinkRegisterOptions, ProtocolRegistrar } from './register'

export { DEEPLINK_CHANNEL, createDeepLinkRouter, windowDeepLinkRouter } from './service'
export type { DeepLinkRouter, DeepLinkTarget } from './service'
