import { useI18n } from '../../../i18n'

export type ModelsTextKey =
  | 'title'
  | 'stateLoginable'
  | 'stateUnknown'
  | 'removeTitle'
  | 'removeBody'
  | 'removeConfirm'
  | 'envActive'
  | 'envShadowed'
  | 'showAllKeys'
  | 'hideAllKeys'
  | 'noAuthInfo'
  | 'pickerRecent'
  | 'pickerPriceHint'
  | 'pickerFavoriteCurrent'
  | 'pickerUnfavoriteCurrent'
  | 'addKey'
  | 'credentialFile'
  | 'keyLabelPlaceholder'
  | 'keyList'
  | 'keyCurrent'
  | 'keyUse'
  | 'keyRename'
  | 'keyDelete'
  | 'keyDeleteConfirm'
  | 'keySwitched'
  | 'removeBodyMany'
  | 'addAccount'
  | 'accountList'
  | 'removeBodyAccounts'
  | 'pickerHidden'
  | 'pickerHide'
  | 'pickerShow'
  | 'pickerManage'
  | 'pickerHiddenTag'
  | 'pickerUnhidden'
  | 'visTitle'
  | 'visDesc'
  | 'visFilter'
  | 'visCount'
  | 'visCountFav'
  | 'visCountHidden'
  | 'visShowAll'
  | 'visHideAll'
  | 'visEmpty'
  | 'visNoModels'
  | 'visToggle'
  | 'visGroupHidden'
  | 'statusReady'

const ZH: Record<ModelsTextKey, string> = {
  title: '模型与服务',
  stateLoginable: '可登录',
  stateUnknown: '状态未知',
  removeTitle: '移除凭证？',
  removeBody:
    '将移除该服务商的本机凭证；相关模型需重新登录后才可用。',
  removeConfirm: '移除',
  envActive: '正在使用环境变量里的 key；在此添加后优先用应用内 key。',
  envShadowed: '正在使用应用内 key，环境变量被忽略。',
  showAllKeys: '显示未配置的服务商（{n}）',
  hideAllKeys: '收起未配置的服务商',
  noAuthInfo:
    '读不到凭证时，服务商按未登录显示。',
  pickerRecent: '最近使用',
  pickerPriceHint: '每百万 token 的输入 / 输出价（美元）',
  pickerFavoriteCurrent: '收藏当前模型',
  pickerUnfavoriteCurrent: '取消收藏当前模型',
  addKey: "添加 Key",
  credentialFile: "凭证位置",
  keyLabelPlaceholder: "备注（可选）",
  keyList: "已保存的 key",
  keyCurrent: "当前",
  keyUse: "使用",
  keyRename: "改备注",
  keyDelete: "移除",
  keyDeleteConfirm: "确认移除",
  keySwitched: "已切换到「{label}」，空闲后生效",
  removeBodyMany: "将移除该服务商保存的全部 {n} 个 key；相关模型需重新配置后才可用。",
  addAccount: '添加账号',
  accountList: '已保存的 {provider} 账号',
  removeBodyAccounts: '将移除本机全部 {n} 个订阅账号和 {keys} 个 key。',
  pickerHidden: '已隐藏的模型 · {n}',
  pickerHide: '在选择器中隐藏',
  pickerShow: '恢复显示',
  pickerManage: '管理显示的模型',
  pickerHiddenTag: '已隐藏',
  pickerUnhidden: '已收藏并恢复显示 {name}',
  visTitle: '选择器里的模型',
  visDesc: '隐藏不常用的模型。只影响列表，不删配置或凭证。',
  visFilter: '筛选模型',
  visCount: '{n} 个模型',
  visCountFav: '{n} 个收藏',
  visCountHidden: '{n} 个已隐藏',
  visShowAll: '全部显示',
  visHideAll: '全部隐藏',
  visEmpty: '没有匹配的模型',
  visNoModels: '还没有读到可用模型',
  visToggle: '在选择器中显示 {name}',
  visGroupHidden: '已隐藏',
  statusReady: '可用'
}

const EN: Record<ModelsTextKey, string> = {
  title: 'Models & services',
  stateLoginable: 'Can sign in',
  stateUnknown: 'Status unknown',
  removeTitle: 'Remove credential?',
  removeBody:
    'Removes this provider’s local credential; sign in again to use its models.',
  removeConfirm: 'Remove',
  envActive: 'Using the environment key; an in-app key here takes priority.',
  envShadowed: 'Using the in-app key; the environment key is ignored.',
  showAllKeys: 'Show unconfigured providers ({n})',
  hideAllKeys: 'Hide unconfigured providers',
  noAuthInfo:
    'Providers show as signed out when no credential is found.',
  pickerRecent: 'Recently used',
  pickerPriceHint: 'Input / output price per million tokens (USD)',
  pickerFavoriteCurrent: 'Favorite current model',
  pickerUnfavoriteCurrent: 'Unfavorite current model',
  addKey: "Add key",
  credentialFile: "Credential file",
  keyLabelPlaceholder: "Label (optional)",
  keyList: "Saved keys",
  keyCurrent: "Current",
  keyUse: "Use",
  keyRename: "Rename",
  keyDelete: "Remove",
  keyDeleteConfirm: "Confirm remove",
  keySwitched: "Switched to “{label}”; applies once idle",
  removeBodyMany: "Removes all {n} saved keys for this provider; set a key again to use its models.",
  addAccount: 'Add account',
  accountList: 'Saved {provider} accounts',
  removeBodyAccounts: 'Removes all {n} subscription accounts and {keys} keys saved locally.',
  pickerHidden: 'Hidden models · {n}',
  pickerHide: 'Hide from picker',
  pickerShow: 'Show in picker',
  pickerManage: 'Manage shown models',
  pickerHiddenTag: 'Hidden',
  pickerUnhidden: 'Favorited and showing {name} again',
  visTitle: 'Models in the picker',
  visDesc: 'Hide models you rarely use. Only the list changes; config and credentials stay.',
  visFilter: 'Filter models',
  visCount: '{n} models',
  visCountFav: '{n} favorites',
  visCountHidden: '{n} hidden',
  visShowAll: 'Show all',
  visHideAll: 'Hide all',
  visEmpty: 'No models match',
  visNoModels: 'No models reported yet',
  visToggle: 'Show {name} in the model picker',
  visGroupHidden: 'Hidden from picker',
  statusReady: 'ready'
}

export function modelsText(lang: string, key: ModelsTextKey): string {
  return (lang === 'en-US' ? EN : ZH)[key]
}

export function useModelsText(): (key: ModelsTextKey) => string {
  const { lang } = useI18n()
  return (key) => modelsText(lang, key)
}
