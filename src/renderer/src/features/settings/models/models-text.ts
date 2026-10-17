import { useI18n } from '../../../i18n'

export type ModelsTextKey =
  | 'title'
  | 'tabServices'
  | 'tabCatalog'
  | 'stateLoginable'
  | 'stateUnknown'
  | 'current'
  | 'useAction'
  | 'switching'
  | 'thinkingTitle'
  | 'thinkingSource'
  | 'thinkingNoSession'
  | 'reasoningKnown'
  | 'reasoningUnsupported'
  | 'reasoningUnknown'
  | 'removeTitle'
  | 'removeBody'
  | 'removeConfirm'
  | 'envLocked'
  | 'viewChanged'
  | 'loginPanelNote'
  | 'showAllKeys'
  | 'hideAllKeys'
  | 'noAuthInfo'
  | 'busyNote'
  | 'pickerRecent'
  | 'pickerPriceHint'
  | 'pickerFavoriteCurrent'
  | 'pickerUnfavoriteCurrent'

const ZH: Record<ModelsTextKey, string> = {
  title: '模型与服务',
  tabServices: '服务',
  tabCatalog: '模型目录',
  stateLoginable: '可登录',
  stateUnknown: '状态未知',
  current: '使用中',
  useAction: '使用',
  switching: '切换中…',
  thinkingTitle: '思考能力',
  thinkingSource:
    '只显示会话查到的思考档位。',
  thinkingNoSession: '尚未连接会话，无法查询思考档位。',
  reasoningKnown: '支持推理',
  reasoningUnsupported: '不支持推理',
  reasoningUnknown: '推理能力未知',
  removeTitle: '移除凭证？',
  removeBody:
    '将移除该服务商的本机凭证；相关模型需重新登录后才可用。',
  removeConfirm: '移除',
  envLocked: '凭证来自环境变量，请到系统环境变量里修改。',
  viewChanged: '会话已变化，未标记到当前会话。',
  loginPanelNote: '点击后才开始登录。',
  showAllKeys: '显示未配置的服务商（{n}）',
  hideAllKeys: '收起未配置的服务商',
  noAuthInfo:
    '读不到凭证时，服务商按未登录显示。',
  busyNote: '会话生成或压缩中，结束后再切换模型。',
  pickerRecent: '最近使用',
  pickerPriceHint: '每百万 token 的输入 / 输出价（美元）',
  pickerFavoriteCurrent: '收藏当前模型',
  pickerUnfavoriteCurrent: '取消收藏当前模型'
}

const EN: Record<ModelsTextKey, string> = {
  title: 'Models & services',
  tabServices: 'Services',
  tabCatalog: 'Model catalog',
  stateLoginable: 'Can sign in',
  stateUnknown: 'Status unknown',
  current: 'In use',
  useAction: 'Use',
  switching: 'Switching…',
  thinkingTitle: 'Thinking capability',
  thinkingSource:
    'Only levels reported by the session are shown.',
  thinkingNoSession: 'No session connected, so thinking levels cannot be queried.',
  reasoningKnown: 'Reasoning',
  reasoningUnsupported: 'No reasoning',
  reasoningUnknown: 'Reasoning unknown',
  removeTitle: 'Remove credential?',
  removeBody:
    'Removes this provider’s local credential; sign in again to use its models.',
  removeConfirm: 'Remove',
  envLocked: 'The credential comes from an environment variable; change it in your system environment.',
  viewChanged: 'Session changed; result not applied.',
  loginPanelNote: 'Sign-in starts only after you click.',
  showAllKeys: 'Show unconfigured providers ({n})',
  hideAllKeys: 'Hide unconfigured providers',
  noAuthInfo:
    'Providers show as signed out when no credential is found.',
  busyNote: 'Switch models after the session finishes.',
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
