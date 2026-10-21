import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))

async function loadTs(rel) {
  const result = await build({
    entryPoints: [here(rel)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}

const search = await loadTs('../src/renderer/src/features/settings/search/search-model.ts')
const entries = await loadTs('../src/renderer/src/features/settings/search/entries.ts')

const sectionLabel = (section) => section
const ids = (hits) => hits.map((hit) => hit.id)
const { SETTINGS_SEARCH_ENTRIES } = entries
const fixture = [
  { id: 'theme', section: 'appearance', zh: '主题', en: 'Theme', keywords: ['暗色', 'dark'] },
  { id: 'language', section: 'appearance', zh: '语言', en: 'Language', keywords: ['English', 'lang'] },
  { id: 'compact-at', section: 'session', zh: '自动压缩上限', en: 'Auto-compaction limit', keywords: ['阈值', 'threshold'] }
]

ok(search.matchSettings(fixture, '', 'zh-CN', sectionLabel).length === 0, '空查询不返回结果')
ok(search.matchSettings(fixture, '   ', 'zh-CN', sectionLabel).length === 0, '纯空白查询不返回结果')
ok(ids(search.matchSettings(fixture, '主题', 'zh-CN', sectionLabel)).join() === 'theme', '中文界面按中文名命中')
ok(ids(search.matchSettings(fixture, 'Theme', 'zh-CN', sectionLabel)).join() === 'theme', '中文界面回退到英文名')
ok(ids(search.matchSettings(fixture, '语言', 'en-US', sectionLabel)).join() === 'language', '英文界面回退到中文名')
ok(ids(search.matchSettings(fixture, 'dark', 'en-US', sectionLabel)).join() === 'theme', '关键词命中')
ok(ids(search.matchSettings(fixture, '  auto  ', 'en-US', sectionLabel)).join() === 'compact-at', '忽略大小写与首尾空白')
ok(ids(search.matchSettings(fixture, 'appear', 'en-US', sectionLabel)).join() === 'theme,language', '分区名命中时按原顺序返回')
ok(search.matchSettings(fixture, 'nonsense', 'en-US', sectionLabel).length === 0, '无匹配返回空')

const ranked = search.matchSettings(fixture, '语言', 'zh-CN', (section) => (section === 'appearance' ? '语言与外观' : section))
ok(ids(ranked)[0] === 'language', '精确名排在分区名之前')
ok(search.matchSettings(fixture, 'o', 'en-US', sectionLabel, 1).length === 1, 'limit 截断结果数')
ok(search.matchSettings(SETTINGS_SEARCH_ENTRIES, '模型', 'zh-CN', sectionLabel, 60).length > 0, '真实条目表可被检索')

ok(search.settingSelector('session-compact-at') === '[data-setting-id="session-compact-at"]', '选择器按 id 生成属性选择器')
ok(search.settingSelector('a"b') === '[data-setting-id="ab"]', '引号被剔除，不破坏选择器')
ok(search.settingSelector('a\\b') === '[data-setting-id="ab"]', '反斜杠被剔除，不破坏选择器')
ok(
  SETTINGS_SEARCH_ENTRIES.every((entry) => /^[a-z0-9-]+$/.test(entry.id)),
  '搜索条目 id 只用小写字母 / 数字 / 连字符（选择器安全的前提）'
)
const uniqueIds = new Set()
let duplicated = null
for (const entry of SETTINGS_SEARCH_ENTRIES) {
  if (uniqueIds.has(entry.id)) duplicated = entry.id
  uniqueIds.add(entry.id)
}
ok(duplicated === null, `条目 id 唯一${duplicated ? `（重复：${duplicated}）` : ''}`)

let fired = 0
const unsubscribe = search.subscribeSettingReveal(() => {
  fired++
})
ok(search.getSettingReveal() === null, '初始没有待定位设置项')
search.requestSettingReveal({ section: 'session', id: 'session-compact-at' })
ok(fired === 1, '请求定位时通知订阅者')
ok(search.getSettingReveal().id === 'session-compact-at' && search.getSettingReveal().section === 'session', '定位目标带回分区与 id')
search.requestSettingReveal({ section: 'capabilities', tab: 'mcp', id: 'caps-mcp-login' })
ok(search.getSettingReveal().tab === 'mcp', '能力子页定位带回 tab')
ok(search.getSettingReveal().revision > 1, '同一目标重复请求也会推进 revision')
const countBeforeUnsubscribe = fired
unsubscribe()
search.requestSettingReveal({ section: 'appearance', id: 'appearance-theme' })
ok(fired === countBeforeUnsubscribe, '退订后不再收到通知')

console.log(`v3 设置搜索：命中排序 / 选择器安全 / 定位订阅 ${checks} 项检查通过`)
