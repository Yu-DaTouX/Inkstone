import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-attention-notice-'))

try {
  const outfile = join(root, 'attention-notice.mjs')
  await build({ entryPoints: ['src/main/attention-notice.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const notices = await import(pathToFileURL(outfile).href)

  const made = []
  const opened = []
  const make = (options) => {
    const listeners = {}
    const handle = {
      options,
      shown: false,
      closed: false,
      on(event, listener) {
        listeners[event] = listener
      },
      show() {
        handle.shown = true
      },
      close() {
        handle.closed = true
        listeners.close?.()
      },
      click() {
        listeners.click?.()
      }
    }
    made.push(handle)
    return handle
  }
  const center = notices.createAttentionNotices(make, (link) => opened.push(link ?? null))

  center.show({ key: 'session:a', title: '需要你确认 · 修复', body: '删除 dist', link: { action: 'session', sessionId: 'a' } })
  assert.equal(made.length, 1)
  assert.equal(made[0].shown, true, '通知弹出')
  assert.equal(made[0].options.silent, true, '系统通知一律静音，提示音由应用负责')

  center.show({ key: 'session:a', title: '回合完成 · 修复', body: '已完成' })
  assert.equal(made[0].closed, true, '同一会话的新通知替换旧通知')
  assert.equal(made[1].shown, true)

  center.show({ key: 'session:b', title: '回合完成 · 另一个' })
  assert.equal(made[1].closed, false, '不同会话的通知互不替换')
  assert.equal('body' in made[2].options, false, '没有正文时不传空正文')

  made[0].click()
  made[2].click()
  assert.deepEqual(opened, [{ action: 'session', sessionId: 'a' }, null], '点击带目标的通知直达会话，没有目标时只唤起窗口')

  assert.equal(notices.noticeLang('en-US'), 'en')
  assert.equal(notices.noticeLang('zh-CN'), 'zh')
  assert.equal(notices.noticeLang(undefined), 'zh')
  assert.equal(notices.approvalNoticeTitle('zh', '修复精度'), '需要你确认 · 修复精度')
  assert.equal(notices.approvalNoticeTitle('en'), 'Needs your approval', '没有会话名时只写事件')
  assert.deepEqual(notices.terminalNoticeText('en', 'permission', ''), { title: 'Terminal needs approval', body: 'Switch to the terminal to continue' }, '审批类终端通知跟随英文界面')
  assert.equal(notices.terminalNoticeText('zh', undefined, 'npm login').title, '终端在等你')
  assert.equal(notices.terminalNoticeText('zh', 'auth', 'npm login').body, 'npm login')
  const collab = notices.collabNoticeText('en', '砚 · 另一台电脑', 'Fix', 'feat/x')
  assert.equal(collab.title, 'Collaboration · Merge request')
  assert.equal(collab.body, '另一台电脑: Fix (feat/x)', '对端名去掉产品前缀')
  console.log('attention-notice: 同会话替换、静音、点击直达与中英文案通过')
} finally {
  await rm(root, { recursive: true, force: true })
}
