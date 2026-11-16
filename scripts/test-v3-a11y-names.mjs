import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../src/renderer/src/${path}`, import.meta.url), 'utf8')
let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`  ✓ ${label}`)
}

const parts = read('features/settings/capabilities/parts.tsx')
ok(/<article[^>]*aria-labelledby=\{nameId\}/.test(parts) && /className="caps-name"\s+id=\{nameId\}/.test(parts), '设置里的 Entry 行用名称标出整行，行内「检查/详情/移除」按钮能分辨对象')

for (const file of ['features/settings/capabilities/McpServices.tsx', 'features/settings/capabilities/McpSection.tsx']) {
  const text = read(file)
  const pre = /<pre className="caps-raw"[^>]*(?:mcp-check-error|caps-mcp-error)[^>]*>/.exec(text)?.[0] ?? ''
  ok(/role="region"/.test(pre) && /aria-label=\{t\('cap\.operation\.errorDetail'\)\}/.test(pre), `${file.split('/').pop()}：MCP 报错原文有区域名称`)
}

const models = read('features/settings/models/ModelsSettings.tsx')
for (const id of ['ms-remove-', 'ms-set-', 'ms-login-cancel-', 'ms-login-']) {
  const at = models.indexOf('data-testid={`' + id + '${p.id}`}')
  ok(at > 0 && /aria-label=\{`[^`]*providerName\(p\)/.test(models.slice(Math.max(0, at - 260), at)), `模型页 ${id}* 按钮的名称带提供商名`)
}

const subagent = read('features/session/SubagentLine.tsx')
for (const testid of ['v3-subagent-row', 'v3-subagent-tile']) {
  const at = subagent.indexOf(`      data-testid="${testid}"\n`)
  ok(at > 0 && /aria-label=\{\[[^\]]*label[^\]]*status[^\]]*\]\.filter\(Boolean\)\.join\(', '\)\}/.test(subagent.slice(at, at + 1000)), `${testid} 有拼好的可读名称，不靠相邻 span 硬拼`)
}

const keys = [...read('i18n/zh-CN.json').matchAll(/"cap\.operation\.errorDetail"/g)].length + [...read('i18n/en-US.json').matchAll(/"cap\.operation\.errorDetail"/g)].length
ok(keys === 2, '错误详情文案中英文各一条')
console.log(`${checks}/${checks} 通过`)
