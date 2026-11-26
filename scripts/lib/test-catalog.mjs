import { readdir } from 'node:fs/promises'

export const excludedScripts = {
  'test-unit': 'the-harness-itself',
  'test-live': 'live-harness',
  'test-packaged': 'needs-packaged-release',
  'test-upgrade-read': 'needs-packaged-release',
  'test-relay-mobile': 'needs-mobile-dependencies',
  'test-remote-tunnel': 'needs-mobile-dependencies',
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
  'test-userbrowser-live': 'needs-real-browsers-and-hkcu-native-messaging-registry',
  'test-comfyui-video': 'helper-module-of-test-comfyui-plugin',
  'test-comfyui-workflows': 'helper-module-of-test-comfyui-plugin',
  'test-comfyui-idle': 'helper-module-of-test-comfyui-plugin',
  'test-fake-model-workflow-e2e': 'spawns-pi-runtime-against-local-fake-model'
}

export const hostEnvScripts = {
  'test-unit': 'the-harness-itself',
  'test-live': 'drives-real-electron-with-own-data-dirs',
  'test-packaged': 'needs-packaged-release',
  'test-upgrade-read': 'reads-real-user-data-backup-via-YAN_UPGRADE_SOURCE',
  'test-cc-delegation-live': 'needs-real-claude-login-in-host-home',
  'test-cc-subagent-live': 'needs-real-claude-login-in-host-home',
  'test-cc-subscription-live': 'needs-real-claude-login-in-host-home',
  'test-cross-provider-live': 'needs-real-claude-login-in-host-home',
  'test-git-runtime-real': 'downloads-real-portablegit',
  'test-debug-demo': 'launches-debug-electron-instance',
  'test-browser-frame-network': 'launches-electron-with-host-network',
  'test-browser-popup-live': 'launches-electron-with-host-network',
  'test-userbrowser-live': 'writes-hkcu-native-messaging-keys-and-launches-real-browsers'
}

export const serialScripts = {
  'test-mcp-stdio-tree': 'wall-clock-upper-bound',
  'test-search-providers': 'wall-clock-upper-bound',
  'test-hidden-page': 'wall-clock-upper-bound',
  'test-stream-loop-detector': 'wall-clock-upper-bound',
  'test-agent-stop-flush': 'wall-clock-upper-bound',
  'test-storage-atomic-retry': 'wall-clock-upper-bound',
  'test-subagent-diagnostics': 'wall-clock-upper-bound',
  'test-video-export-cancel': 'wall-clock-upper-bound',
  'test-generation-timing': 'real-timer-race',
  'test-branch-lanes': 'wall-clock-upper-bound',
  'test-subagents': 'real-timer-race',
  'test-provider-request-pipeline': 'real-timer-race',
  'test-session-concurrency-frontend': 'real-timer-race',
  'test-session-sync-race': 'real-timer-race',
  'test-pinned-network': 'real-timer-race',
  'test-workspace-changes': 'wall-clock-upper-bound',
  'test-files-watch': 'wall-clock-upper-bound',
  'test-auto-compact': 'real-timer-race',
  'test-runner-reclaim-live': 'real-process-reclaim'
}

export async function discoverTests(directory = 'scripts') {
  const names = (await readdir(directory)).filter((name) => /^test-.*\.mjs$/.test(name)).map((name) => name.slice(0, -4)).sort()
  for (const name of Object.keys(hostEnvScripts)) {
    if (!names.includes(name)) throw new Error(`宿主环境名单指向不存在的测试：${name}`)
    if (!Object.hasOwn(excludedScripts, name)) throw new Error(`需要宿主环境的测试必须在排除名单里：${name}`)
  }
  for (const name of Object.keys(serialScripts)) {
    if (!names.includes(name)) throw new Error(`串行名单指向不存在的测试：${name}`)
    if (Object.hasOwn(excludedScripts, name)) throw new Error(`测试重复分类：${name}`)
  }
  return names.map((name) => ({
    name,
    kind: Object.hasOwn(excludedScripts, name) ? 'excluded' : 'standalone',
    reason: excludedScripts[name],
    serial: Object.hasOwn(serialScripts, name)
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
    if (blocked.length) throw new Error(blocked.map((test) => `${test.name}: ${test.reason}`).join('\n'))
  }
  const standalone = selected.filter((test) => test.kind === 'standalone')
  const parallel = standalone.filter((test) => !test.serial).map((test) => test.name)
  const serial = standalone.filter((test) => test.serial).map((test) => test.name)
  if (!parallel.length && !serial.length) throw new Error('没有可运行的独立测试')
  return { parallel, serial }
}
