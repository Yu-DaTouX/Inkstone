import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

let pass = 0
function ok(condition, label, detail) {
  assert.ok(condition, `${label}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
  pass += 1
  console.log(`  ✓ ${label}`)
}

const bundle = async (entry) => {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'neutral', format: 'esm', logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

console.log('▌guard 状态分类')
{
  const { pinnedGuardNotice } = await bundle('src/main/pinned-guard-notice.ts')
  ok(pinnedGuardNotice({ status: 'attached', port: 1234 }) === null, 'attached 不提示', pinnedGuardNotice({ status: 'attached', port: 1234 }))
  const failed = pinnedGuardNotice({ status: 'failed', message: 'proxy route mismatch' })
  ok(failed?.message === 'proxy route mismatch', 'failed 带原因', failed)
  ok(pinnedGuardNotice({ status: 'failed', message: '  ' })?.message === 'pinned network guard failed', '空原因有兜底')
  const systemProxy = pinnedGuardNotice({ status: 'system-proxy', resolution: 'PROXY 10.0.0.1:3128' })
  ok(systemProxy?.message.includes('PROXY'), '系统代理回退状态带原因', systemProxy)
  ok(!/[一-鿿]/.test(failed?.message ?? ''), '诊断文本不含中文')
}

console.log('▌两份词表')
{
  const zh = JSON.parse(readFileSync('src/renderer/src/i18n/zh-CN.json', 'utf8'))
  const en = JSON.parse(readFileSync('src/renderer/src/i18n/en-US.json', 'utf8'))
  ok(typeof zh['net.guardDisabled'] === 'string' && zh['net.guardDisabled'].includes('{reason}'), '中文键含 reason 占位')
  ok(typeof en['net.guardDisabled'] === 'string' && en['net.guardDisabled'].includes('{reason}'), '英文键含 reason 占位')
  ok(/[一-鿿]/.test(zh['net.guardDisabled']) && !/[一-鿿]/.test(en['net.guardDisabled']), '中英各自对应')
  ok(!('net.guardUnpinned' in zh) && !('net.guardUnpinned' in en), '系统代理启动提示已删除')
}

console.log('▌宿主通知只发一次且不被启动期吞掉')
{
  const { consumeQuestionPush } = await bundle('src/renderer/src/state/push-consumers.ts')
  const patches = []
  const ctx = {
    get: () => ({}),
    set: (patch) => patches.push(patch),
    alertAttention: () => {},
    pushNotice: (list, type, text, id) => [...list, { id, type, text, at: 1 }],
    applyBrowserVisibility: () => {},
    revealBrowser: () => {},
    revealTerminal: () => {},
    t: (key, vars) => `${key}|${vars?.reason ?? ''}`
  }
  const store = { notices: [], logs: [], startupPhase: true, settings: null, nativeMcpStatus: undefined }
  consumeQuestionPush(
    { ch: 'notify', payload: { id: 'pinned-network-guard', method: 'notify', notifyType: 'error', message: 'proxy route mismatch' } },
    store,
    ctx
  )
  const notice = patches.at(-1)?.notices?.[0]
  ok(notice?.id === 'pinned-network-guard' && notice.type === 'error', '以固定 id、error 级别进入通知列表', notice)
  ok(notice?.text === 'net.guardDisabled|proxy route mismatch', '用 i18n 键拼提示并带上原因', notice?.text)


  const blank = { notices: [], logs: [], startupPhase: false, settings: null, nativeMcpStatus: undefined }
  consumeQuestionPush({ ch: 'notify', payload: { id: 'pinned-network-guard', method: 'notify', notifyType: 'error', message: '' } }, blank, ctx)
  ok(String(patches.at(-1)?.notices?.[0]?.text ?? '').startsWith('net.guardDisabled|state.error.unknownReason'), '原因为空时用未知原因', patches.at(-1))

  const generic = { notices: [], logs: [], startupPhase: true, settings: null, nativeMcpStatus: undefined }
  const before = patches.length
  consumeQuestionPush({ ch: 'notify', payload: { id: 'other-host-notice', method: 'notify', notifyType: 'info', message: 'hello' } }, generic, ctx)
  ok(patches.length === before + 1 && !patches.at(-1).notices, '其它通知仍按原启动期规则走日志')
}

console.log(`DNS guard 失败提示：${pass} 项通过`)
