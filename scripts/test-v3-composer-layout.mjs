#!/usr/bin/env node
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

let checks = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  checks++
  console.log(`✓ ${label}`)
}

async function loadLayout() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/renderer/src/features/composer/composer-layout.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const layout = await loadLayout()

ok(layout.composerMode('!ls') === 'bash' && layout.composerMode('/model') === 'cmd' && layout.composerMode('你好') === null, '模式徽标判据与 v3 现有 bash/ slash 一致')
ok(layout.composerLocalCommand('!ls', []) === true, '! 前缀是本地命令')
ok(layout.composerLocalCommand('/ultracode', [{ source: 'yan', name: 'ultracode' }]) === true, '单独的 /ultracode 走本地提示用法')
ok(layout.composerLocalCommand('/ultracode 审一遍接口', [{ source: 'yan', name: 'ultracode' }]) === false, '/ultracode 带任务按普通消息发送')
ok(layout.composerLocalCommand('/login', []) === true, '/login 是本地命令')
ok(layout.composerLocalCommand('/login extra', []) === true, '/login 带参数也是本地命令')
ok(
  layout.composerLocalCommand('/model x', [{ source: 'yan', name: 'Model' }]) === true,
  'yan/compatibility 命令名大小写不敏感'
)
ok(layout.composerLocalCommand('/model x', [{ source: 'pi', name: 'model' }]) === false, 'pi 命令不下发到本地通道')
ok(layout.composerLocalCommand('/nope', [{ source: 'yan', name: 'model' }]) === false, '未知命令不是本地命令')
ok(layout.composerLocalCommand(' /login', []) === false, '带前导空格的 /login 按普通文本发送')
ok(layout.composerLocalCommand('  !ls', []) === false, '带前导空格的 ! 不进直执行')
ok(layout.composerLocalCommand('/modely', [{ source: 'yan', name: 'model' }]) === false, '命令名需完整匹配')

ok(layout.composerPlaceholderKey({ bash: true, session: true, firstRun: true }) === 'composer.phBash', '占位符：bash 模式优先')
ok(layout.composerPlaceholderKey({ bash: false, session: true, firstRun: false }) === 'composer.phSession', '占位符：已有会话')
ok(layout.composerPlaceholderKey({ bash: false, session: false, firstRun: true }) === 'composer.phFirst', '占位符：首次使用')
ok(layout.composerPlaceholderKey({ bash: false, session: false, firstRun: false }) === 'composer.phDraft', '占位符：普通草稿')

console.log(`\n结果：${checks} 项通过`)
