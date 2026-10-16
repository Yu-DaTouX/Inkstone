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
  | 'customNote'
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
    '档位来自当前会话对 pi 的 get_available_thinking_levels 查询；未查询成功就不显示档位，也不会因为模型名里带「推理」就假称支持。',
  thinkingNoSession: '尚未连接会话，无法查询思考档位。',
  reasoningKnown: '支持推理',
  reasoningUnsupported: '不支持推理',
  reasoningUnknown: '推理能力未知',
  removeTitle: '移除凭证？',
  removeBody:
    '会从本机 auth.json 移除该服务商的凭证；相关模型在重新登录或填入 key 前不可用。此操作只在你确认后执行。',
  removeConfirm: '移除',
  envLocked: '凭证来自环境变量，请到系统环境变量里修改。',
  viewChanged: '切换期间会话已改变，未把结果标记到当前会话。',
  loginPanelNote: '登录只在你点击后开始；应用内登录会打开浏览器或在下方显示验证码。',
  customNote: '自定义服务与本地模型服务器仍在旧界面，可切回 v2 配置。',
  showAllKeys: '显示未配置的服务商（{n}）',
  hideAllKeys: '收起未配置的服务商',
  noAuthInfo:
    '第一次打开本页会读取本机凭证状态（auth.json 与环境变量）；未读到时不把任何服务商当成已登录。',
  busyNote: '当前会话正在生成或压缩，等它结束再切换模型；收藏不受影响。',
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
    'Levels come from the active session querying pi’s get_available_thinking_levels. Without a successful query no levels are shown, and a model is never claimed to support thinking just because its name says “reasoning”.',
  thinkingNoSession: 'No session connected, so thinking levels cannot be queried.',
  reasoningKnown: 'Reasoning',
  reasoningUnsupported: 'No reasoning',
  reasoningUnknown: 'Reasoning unknown',
  removeTitle: 'Remove credential?',
  removeBody:
    'Removes this provider’s credential from local auth.json; its models stay unavailable until you sign in again or paste a key. This runs only after you confirm.',
  removeConfirm: 'Remove',
  envLocked: 'The credential comes from an environment variable; change it in your system environment.',
  viewChanged: 'The session changed while switching, so the result was not marked on the current session.',
  loginPanelNote: 'Sign-in starts only after you click; in-app login opens a browser or shows a code below.',
  customNote: 'Custom providers and local model servers still live in the old UI — switch back to v2 to configure them.',
  showAllKeys: 'Show unconfigured providers ({n})',
  hideAllKeys: 'Hide unconfigured providers',
  noAuthInfo:
    'Opening this page reads local credential status (auth.json and environment variables). If nothing is read, no provider is treated as signed in.',
  busyNote: 'The active session is generating or compacting; switch models after it finishes. Favorites are unaffected.',
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
