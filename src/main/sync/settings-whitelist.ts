/**
 * 设置的**同步白名单**与凭证外泄断言。
 *
 * 为什么用白名单而不是黑名单：`desktop.json` 会随版本不断加字段，黑名单漏掉一个
 * 新字段就可能把路径、凭证或本机专属状态带上云端。白名单只放行「跨设备有意义、
 * 且不含路径 / 凭证 / 本机标识」的偏好；新增字段默认不同步，需要显式加进来。
 *
 * 凭证的权威位置是 pi 的 `auth.json`，本来就不在 `desktop.json` 里；这里是纵深防护：
 * 即使有人往设置里写了 `apiKey` 之类的字段，白名单也不会选它，写出前还会再扫一遍。
 */

/** 允许同步到同步目录的设置键。刻意不含 cwd / recentCwds / projects / piBin / 窗口几何 / remoteAccess / voiceInput。 */
export const SYNC_SETTINGS_WHITELIST = [
  'uiVersion',
  'theme',
  'lang',
  'lastMainModel',
  'lastSubagentModel',
  'modelFavorites',
  'modelProviderOrder',
  'activityModels',
  'codemodeEnabled',
  'autoArchiveDays',
  'keepAwakeWhileWorking',
  'keepAwakeOnBattery',
  'visualAnswers',
  'contextTrim',
  'contextTrimTokens',
  'autoCompactTokens',
  'processLayout',
  'liveThinking',
  'backgroundPreset',
  'backgroundCustom',
  'backgroundCustomLight',
  'fontUi',
  'fontUiCustom',
  'fontCode',
  'fontCodeCustom',
  'fontSizeBody',
  'fontSizeUi',
  'checkpointsEnabled',
  'guardOutsideWrites',
  'showSpaces',
  'permissionMode',
  'autonomous',
  'defaultWorkMode',
  'capabilityStrategy',
  'workModeShortcutEnabled',
  'subagentNotify',
  'usageUnderInput',
  'workModeShortcut',
  'sendKey',
  'responseDetail',
  'density',
  'contextPolicy',
  'contextPolicyByModel',
  'temperatureByModel',
  'contextDeep',
  'contextFold',
  'projectKnowledge',
  'sound',
  'providerBudgets',
  'toolLayout',
  'toolDetail',
  'toolDetailExplicit'
] as const

const WHITELIST_SET = new Set<string>(SYNC_SETTINGS_WHITELIST)

/**
 * 从完整设置对象里挑出可同步的键。
 * 只对顶层键做白名单；嵌套对象由调用方 / 字段本身保证不含路径（见上面的注释）。
 */
export function pickSyncSettings(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!WHITELIST_SET.has(key) || value === undefined) continue
    out[key] = value
  }
  return out
}

/** 设备无关配置里允许出现的键；其它字段名一律视为可疑。 */
const FORBIDDEN_NORMALIZED = new Set(
  [
    'apikey',
    'xapikey',
    'token',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'secret',
    'clientsecret',
    'password',
    'passwd',
    'authorization',
    'authorizationheader',
    'bearer',
    'credential',
    'credentials',
    'privatekey',
    'cookie',
    'cookies',
    'oauth',
    'sessiontoken'
  ].map(normalizeFieldName)
)

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * 递归扫描一个值里有没有凭证类**字段名**。
 *
 * 只认字段名，不认值：密钥被写进某个普通字段的字符串值时，这里发现不了 ——
 * 白名单才是主要防线，这个断言是防止将来有人把整块原始设置塞进 payload。
 */
export function findForbiddenFields(value: unknown, path = '$'): string[] {
  const hits: string[] = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      hits.push(...findForbiddenFields(item, `${path}[${index}]`))
    })
    return hits
  }
  if (!value || typeof value !== 'object') return hits
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_NORMALIZED.has(normalizeFieldName(key))) hits.push(`${path}.${key}`)
    hits.push(...findForbiddenFields(item, `${path}.${key}`))
  }
  return hits
}
