import { readdir } from 'node:fs/promises'
import { legacyScripts } from './test-legacy-scripts.mjs'

export const excludedScripts = {
  'test-unit': 'the-harness-itself',
  'test-unit-legacy': 'legacy-harness',
  'test-live': 'live-harness',
  'test-packaged': 'needs-packaged-release',
  'test-upgrade-read': 'needs-packaged-release',
  'test-relay-mobile': 'needs-mobile-dependencies',
  'test-remote-tunnel': 'needs-mobile-dependencies',
  'test-mobile-render': 'needs-mobile-dependencies',
  'test-mobile-remote-sequence': 'needs-mobile-dependencies',
  'test-remote-identity-peer': 'needs-mobile-dependencies',
  'test-hermes-plugin-desktop': 'sessions-list-race-in-unit-run',
  'test-cc-delegation-live': 'needs-real-claude-subscription',
  'test-cc-subagent-live': 'needs-real-claude-subscription',
  'test-cc-subscription-live': 'needs-real-claude-subscription',
  'test-cross-provider-live': 'needs-real-claude-subscription',
  'test-git-runtime-real': 'needs-real-portablegit-download',
  'test-debug-demo': 'on-demand-npm-run-test-ondemand',
  'test-browser-frame-network': 'on-demand-npm-run-test-ondemand',
  'test-browser-popup-live': 'needs-direct-chromium-connection-without-pinned-guard',
  'test-comfyui-video': 'helper-module-of-test-comfyui-plugin',
  'test-comfyui-workflows': 'helper-module-of-test-comfyui-plugin',
  'test-comfyui-idle': 'helper-module-of-test-comfyui-plugin'
}

export async function discoverTests(directory = 'scripts') {
  const names = (await readdir(directory)).filter((name) => /^test-.*\.mjs$/.test(name)).map((name) => name.slice(0, -4)).sort()
  for (const name of legacyScripts) {
    if (!names.includes(name)) throw new Error(`兼容清单指向不存在的测试：${name}`)
    if (Object.hasOwn(excludedScripts, name)) throw new Error(`测试重复分类：${name}`)
  }
  return names.map((name) => ({
    name,
    kind: legacyScripts.has(name) ? 'legacy' : Object.hasOwn(excludedScripts, name) ? 'excluded' : 'standalone',
    reason: excludedScripts[name]
  }))
}

export function selectTests(catalog, prefixes) {
  if (!prefixes.length) return catalog
  const selected = new Set()
  for (const input of prefixes) {
    if (!/^(?:test-)?[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input)) throw new Error(`无效测试前缀：${input}`)
    const prefix = input.startsWith('test-') ? input : `test-${input}`
    const matches = catalog.filter(({ name }) => name === prefix || name.startsWith(`${prefix}-`))
    if (!matches.length) throw new Error(`没有匹配的测试：${input}`)
    for (const test of matches) selected.add(test)
  }
  return catalog.filter((test) => selected.has(test))
}

export function executionPlan(selected, filtered) {
  if (filtered) {
    const blocked = selected.filter((test) => test.kind !== 'standalone')
    if (blocked.length) throw new Error(blocked.map((test) => `${test.name}: ${test.reason ?? '尚未独立，仍由完整 test:unit 执行'}`).join('\n'))
  }
  const parallel = selected.filter((test) => test.kind === 'standalone').map((test) => test.name)
  if (!parallel.length) throw new Error('没有可运行的独立测试')
  return { parallel, legacy: !filtered }
}
