import { useI18n } from '../../../i18n'

export type ModelsTextKey =
  | 'title'
  | 'stateLoginable'
  | 'stateUnknown'
  | 'removeTitle'
  | 'removeBody'
  | 'removeConfirm'
  | 'envLocked'
  | 'showAllKeys'
  | 'hideAllKeys'
  | 'noAuthInfo'
  | 'openCodeProxy'
  | 'pickerRecent'
  | 'pickerPriceHint'
  | 'pickerFavoriteCurrent'
  | 'pickerUnfavoriteCurrent'

const ZH: Record<ModelsTextKey, string> = {
  title: '模型与服务',
  stateLoginable: '可登录',
  stateUnknown: '状态未知',
  removeTitle: '移除凭证？',
  removeBody:
    '将移除该服务商的本机凭证；相关模型需重新登录后才可用。',
  removeConfirm: '移除',
  envLocked: '凭证来自环境变量，请到系统环境变量里修改。',
  showAllKeys: '显示未配置的服务商（{n}）',
  hideAllKeys: '收起未配置的服务商',
  noAuthInfo:
    '读不到凭证时，服务商按未登录显示。',
  openCodeProxy: 'OpenCode 反代',
  pickerRecent: '最近使用',
  pickerPriceHint: '每百万 token 的输入 / 输出价（美元）',
  pickerFavoriteCurrent: '收藏当前模型',
  pickerUnfavoriteCurrent: '取消收藏当前模型'
}

const EN: Record<ModelsTextKey, string> = {
  title: 'Models & services',
  stateLoginable: 'Can sign in',
  stateUnknown: 'Status unknown',
  removeTitle: 'Remove credential?',
  removeBody:
    'Removes this provider’s local credential; sign in again to use its models.',
  removeConfirm: 'Remove',
  envLocked: 'The credential comes from an environment variable; change it in your system environment.',
  showAllKeys: 'Show unconfigured providers ({n})',
  hideAllKeys: 'Hide unconfigured providers',
  noAuthInfo:
    'Providers show as signed out when no credential is found.',
  openCodeProxy: 'OpenCode proxy',
  pickerRecent: 'Recently used',
  pickerPriceHint: 'Input / output price per million tokens (USD)',
  pickerFavoriteCurrent: 'Favorite current model',
  pickerUnfavoriteCurrent: 'Unfavorite current model'
}

export function modelsText(lang: string, key: ModelsTextKey): string {
  return (lang === 'en-US' ? EN : ZH)[key]
}

export function useModelsText(): (key: ModelsTextKey) => string {
  const { lang } = useI18n()
  return (key) => modelsText(lang, key)
}
