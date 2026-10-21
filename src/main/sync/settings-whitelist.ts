export const SYNC_SETTINGS_WHITELIST = [
  'theme',
  'lang',
  'lastMainModel',
  'lastSubagentModel',
  'modelFavorites',
  'modelProviderOrder',
  'codemodeEnabled',
  'autoArchiveDays',
  'keepAwakeWhileWorking',
  'keepAwakeOnBattery',
  'visualAnswers',
  'contextTrim',
  'contextTrimTokens',
  'autoCompactTokens',
  'fontUi',
  'fontUiCustom',
  'fontCode',
  'fontCodeCustom',
  'fontSizeUi',
  'subagentNotify',
  'workspaceTiles',
  'sendKey',
  'responseDetail',
  'density',
  'reduceMotion',
  'sound',
  'providerBudgets'
] as const

const WHITELIST_SET = new Set<string>(SYNC_SETTINGS_WHITELIST)

export function pickSyncSettings(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!WHITELIST_SET.has(key) || value === undefined) continue
    out[key] = value
  }
  return out
}

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
