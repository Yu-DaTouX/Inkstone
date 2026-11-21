import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { shotKit } from '../lib/ui-shots.mjs'

export const meta = { description: '用本地 ACP 夹具验证 Antigravity 会话、模型切换、审批和取消' }

export default async function run({ box, cdp, fake, runDir, check, waitFor, sleep }) {
  const dir = join(box.home, 'AppData', 'Local', 'agy', 'bin')
  mkdirSync(dir, { recursive: true })
  const fixture = join(dir, 'fixture.cs')
  const executable = join(dir, 'agy.exe')
  const literal = (value) => `@"${value.replaceAll('"', '""')}"`
  const quota = { status: 'SUCCESS', num_turns: 0, conversation_id: '', command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', description: 'Models within this group: Gemini Pro · Fixture, Gemini Flash · Fixture', buckets: [
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.925, reset_time: new Date(Date.now() + 3_600_000).toISOString() },
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.78 }
    ] },
    { name: 'Claude and GPT models', description: 'Models within this group: Claude Sonnet · Fixture', buckets: [
      { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.24 }
    ] }
  ] } } }
  writeFileSync(fixture, `using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
class Fixture {
  static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("1.5.13"); return 0; }
    if (args.Length == 10 && args[0] == "--sandbox" && args[3] == "--disable-slash-commands=false" && args[4] == "--print" && args[5] == "/usage" && args[6] == "--output-format" && args[7] == "json") {
      Console.OutputEncoding = new UTF8Encoding(false);
      Console.WriteLine(${literal(JSON.stringify(quota))}); return 0;
    }
    if (args.Length != 2 || args[0] != "acp" || args[1] != "--sandbox") return 2;
    var settings = new ProcessStartInfo(${literal(process.execPath)}, ${literal(`"${resolve('debug/lib/fake-antigravity.mjs')}"`)}) {
      UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, CreateNoWindow = true
    };
    using (var child = Process.Start(settings)) {
      Task.Factory.StartNew(() => {
        try {
          using (var source = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8))
          using (var sink = new StreamWriter(child.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true }) {
            string line;
            while ((line = source.ReadLine()) != null) sink.WriteLine(line);
          }
        } catch (IOException) {}
      });
      using (var source = new StreamReader(child.StandardOutput.BaseStream, Encoding.UTF8))
      using (var sink = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true }) {
        string line;
        while ((line = source.ReadLine()) != null) sink.WriteLine(line);
      }
      child.WaitForExit();
      return child.ExitCode;
    }
  }
}`)
  const csc = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  const compile = spawnSync(csc, ['/nologo', '/target:exe', `/out:${executable}`, fixture], { encoding: 'utf8', windowsHide: true })
  assert.equal(compile.status, 0, String(compile.error ?? compile.stdout ?? compile.stderr))

  const kit = shotKit(cdp, runDir)
  const picker = '[data-chat-provider-model-picker]'
  const menu = '[data-model-picker-content]'
  const provider = '[data-model-picker-provider="antigravity"] button'
  const sheet = '[data-testid="v3-question"]'
  const conv = '.v3-conv .v3-session'
  const has = (scope, value) => `document.querySelector(${JSON.stringify(scope)})?.textContent.includes(${JSON.stringify(value)})`
  const bot = (selector, brand) => {
    const canvas = selector + ` canvas[data-brand="${brand}"][data-mood="icon"]`
    return `Array.from(document.querySelectorAll(${JSON.stringify(canvas)})).some(el => {
      const r = el.getBoundingClientRect()
      return r.width >= 14 && r.height >= 14 && r.left >= -1 && r.right <= innerWidth + 1 &&
        r.top >= -1 && r.bottom <= innerHeight + 1 && el.width > 0 && el.height > 0
    })`
  }
  const backendIcon = (selector) => {
    const icon = `${selector} [data-provider-brand="antigravity"] img[data-provider-favicon]`
    return `Array.from(document.querySelectorAll(${JSON.stringify(icon)})).some(el => {
      const r = el.getBoundingClientRect()
      return el.complete && el.naturalWidth > 0 && r.width >= 14 && r.height >= 14 &&
        r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1
    })`
  }
  const click = async (selector) => {
    assert.ok(await cdp.evaluate(`(() => { const target = document.querySelector(${JSON.stringify(selector)}); if (!target || target.disabled) return false; target.click(); return true })()`), selector)
  }
  const choose = async (providerId, text) => {
    await click(picker)
    const tab = `[data-model-picker-provider="${providerId}"] button`
    await waitFor(`!!document.querySelector(${JSON.stringify(tab)})`)
    await click(tab)
    const option = `Array.from(document.querySelectorAll('${menu} [role="option"]')).find(e => e.textContent.includes(${JSON.stringify(text)}))`
    await waitFor(`!!(${option})`)
    assert.ok(await cdp.evaluate(`(() => { const row = ${option}; row?.click(); return !!row })()`))
    await waitFor(`s.session?.model?.provider === ${JSON.stringify(providerId)} && s.session.model.name.includes(${JSON.stringify(text)})`)
  }
  const send = async (text) => {
    await waitFor('!s.session?.isAgentRunning && !s.session?.isStreaming')
    await cdp.evaluate(`document.querySelector('[data-testid="composer-input"]').focus()`)
    await cdp.call('Input.insertText', { text })
    await waitFor("!!document.querySelector('.composer-v3 .t3-send:not(:disabled)')")
    await click('.composer-v3 .t3-send')
  }
  const ev = (expression) => cdp.evaluate(expression)
  const app = 'window.__yanStore.getState()'
  const idle = '!s.session?.isAgentRunning && !s.session?.isStreaming'
  const activate = async (path, sid) => {
    await ev(`${app}.switchSession(${JSON.stringify(path)})`)
    await waitFor(`s.session?.sessionId === ${JSON.stringify(sid)} && s.conn === 'ready'`)
  }
  const settled = (value) => waitFor(`${idle} && s.messages.some(m => m.role === 'assistant' && m.entryId && m.text.includes(${JSON.stringify(value)}))`)
  const run = (sid, phase) => ev(`window.yan.runs.snapshot().then(r => r.runs.some(x => x.sessionId === ${JSON.stringify(sid)} && x.phase.kind === ${JSON.stringify(phase)}))`)
  const phase = async (sid, value) => {
    for (let i = 0; i < 80; i++) {
      if (await run(sid, value)) return true
      await sleep(100)
    }
    return false
  }
  const rail = (id) => `[data-rail-section="${id}"]`
  const unfold = async (id) => {
    if (await ev(`document.querySelector('${rail(id)}')?.getAttribute('data-folded') !== '0'`)) await click(`${rail(id)} .wb-tile-toggle`)
  }
  const project = mkdtempSync(join(tmpdir(), 'inkstone-antigravity-fixture-'))
  const init = spawnSync('git', ['init', '-q', project], { windowsHide: true })
  assert.equal(init.status, 0, String(init.error ?? init.stderr))
  const initialCommit = spawnSync('git', ['-C', project, '-c', 'user.name=Inkstone Fixture',
    '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture', '--allow-empty'], { windowsHide: true })
  assert.equal(initialCommit.status, 0, String(initialCommit.error ?? initialCommit.stderr))
  writeFileSync(join(project, 'existing-untracked.txt'), 'pre-existing\n')
  writeFileSync(join(box.piDir, 'mcp.json'), JSON.stringify({ mcpServers: {
    'sync-fixture': { command: process.execPath, args: [resolve('scripts/lib/mcp-stdio-fixture.mjs')], toolExposure: { echo: 'direct', '*': 'hidden' } },
    'disabled-fixture': { command: process.execPath, enabled: false }
  } }))
  await waitFor('!!s.settings?.cwd')
  await kit.theme('light')
  await ev(`${app}.newSession({ cwd: ${JSON.stringify(project)} })`)
  await waitFor(`s.session?.cwd === ${JSON.stringify(project)} && s.conn === 'ready'`)
  await ev(`${app}.openSettings('models')`)
  await waitFor('!!document.querySelector(\'[data-testid="ms-antigravity-connect"]\')')
  await click('[data-testid="ms-antigravity-connect"]')
  await waitFor(has('[data-testid="ms-service-antigravity"]', '3 个模型'))
  check('设置的模型订阅页能连接 CLI、读取模型', true)
  await kit.shot('antigravity-settings', { native: false })
  await ev(`${app}.closeSettings()`)
  await waitFor('!document.querySelector(\'[data-testid="ms-antigravity-connect"]\')')
  const mainModel = await cdp.evaluate('window.__yanStore.getState().models.find(m => m.provider !== "antigravity")')
  assert.ok(mainModel, '需要隔离的 Pi 假模型')
  await choose(mainModel.provider, mainModel.name)
  const baseSession = await cdp.evaluate('window.__yanStore.getState().session?.sessionId')
  await send('记住夹具暗号：砚石')
  await waitFor('!s.session?.isAgentRunning && s.messages.some(m => m.role === "assistant" && m.text)')
  await click(picker)
  await waitFor(`!!document.querySelector('${provider}')`)
  await click(provider)
  await waitFor(has(menu, 'Gemini Pro'))
  check('模型出现在原菜单，顶栏无第二入口', !(await cdp.evaluate("!!document.querySelector('[data-testid=v3-antigravity]')")))
  const geminiIcon = bot(`${menu} [role="option"]`, 'gemini')
  const claudeIcon = bot(`${menu} [role="option"]`, 'claude')
  const providerIcon = backendIcon(provider)
  const triggerIcon = backendIcon(picker)
  await waitFor(`(${geminiIcon}) && (${claudeIcon}) && (${providerIcon})`)
  check('浅色菜单：供应商栏显示 Antigravity 图标，模型行显示各自的 Bot', await ev(`!document.querySelector('${provider} canvas') && !(${triggerIcon})`))
  await kit.shot('antigravity-provider-light', { native: false })
  const modelClicked = await cdp.evaluate(`(() => { const row = Array.from(document.querySelectorAll('${menu} [role="option"]')).find(e => e.textContent.includes('Gemini Pro')); row?.click(); return !!row })()`)
  assert.ok(modelClicked)
  await waitFor('s.session?.model?.provider === "antigravity" && s.session.model.id === "pro"')
  await waitFor('s.stats?.contextUsage?.tokens === 240')
  check('切换模型后，未发送消息也显示 CLI 上报的上下文', true)
  await waitFor(triggerIcon)
  check('选中 Gemini 后原输入框模型按钮显示 Antigravity 图标', await ev(`!document.querySelector('${picker} canvas')`))
  await kit.theme('dark')
  await kit.narrow(820, 700)
  await click(picker)
  await waitFor(`(${geminiIcon}) && (${claudeIcon}) && (${providerIcon}) && (${triggerIcon})`)
  check('深色窄窗口：模型行和供应商图标在窗口内实际绘制', true)
  await kit.shot('antigravity-provider-dark-narrow', { native: false })
  await kit.key('Escape')
  await waitFor(`!document.querySelector('${menu}')`)
  await kit.wide()
  await click(picker)
  await waitFor(has('[data-testid="antigravity-permission"]', 'CLI 默认审批'))
  check('ACP 模型菜单显示 CLI 默认审批，隐藏 Pi 权限开关及 Ultracode', await ev(`!document.querySelector('[data-testid="permission-all"]') && !document.querySelector('${menu}')?.textContent.includes('Ultracode')`))
  const permission = '[data-testid="antigravity-permission"]'
  const chooseMode = async (mode) => {
    await click(`${permission} .ui-select__trigger`)
    const option = `[role="option"][data-key="${mode}"]`
    await waitFor(`!!document.querySelector(${JSON.stringify(option)})`)
    await click(option)
    await waitFor(`s.session?.antigravity?.mode === ${JSON.stringify(mode)}`)
  }
  await chooseMode('plan')
  for (let index = 0; index < 3 && await ev(`!!document.querySelector('${menu}')`); index++) await kit.key('Escape')
  await waitFor(`!document.querySelector('${menu}')`)
  await send('检查权限档')
  await settled('当前权限档 · plan')
  check('从菜单切换 Plan，下一句实际使用此权限档', true)
  await click(picker)
  await waitFor(has(permission, 'Plan'))
  await chooseMode('default')
  await waitFor('!document.querySelector(\'[role="option"][data-key="plan"]\')')
  if (!(await ev(`!!document.querySelector('${menu}')`))) await click(picker)
  const extra = '[data-composer-effort-panel] button[data-level="xhigh"]'
  await waitFor(has(extra, 'Extra'))
  await waitFor(`(() => {
    const button = document.querySelector(${JSON.stringify(extra)})
    if (!button || button.disabled || button.closest('[data-entering]')) return false
    const rect = button.getBoundingClientRect()
    return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
  })()`)
  assert.ok(await kit.click(extra, 0))
  await waitFor(`s.session?.thinkingLevel === 'high' && document.querySelector(${JSON.stringify(extra)})?.dataset.stopState === 'current'`, 1500)
  check('思考档写入等待 CLI 回执时维持刚选中的档位', true)
  await waitFor('s.session?.thinkingLevel === "xhigh"')
  await waitFor('s.stats?.contextUsage?.tokens === 360')
  await kit.key('Escape')
  await waitFor(`!document.querySelector('${menu}')`)
  check('从菜单切换思考档后，输入框显示 CLI 回执 Extra', await ev("document.querySelector('.composer-v3 [data-resting-block=traits]')?.textContent.includes('Extra')"))
  await send('检查上下文')
  await waitFor(has(conv, '上下文收到 · pro'))
  await waitFor('!s.session?.isAgentRunning && s.messages.some(m => m.text === "上下文收到 · pro" && m.entryId)')
  check('Pi 历史交接给 Antigravity，回复落入同一原生会话', baseSession === await cdp.evaluate('window.__yanStore.getState().session?.sessionId'))
  await kit.shot('antigravity-main-chat', { native: false })
  const baseFile = await ev(`${app}.session.sessionFile`)
  await ev(`${app}.send('统计数据')`)
  await settled('请问今天需要处理什么任务？')
  await waitFor('s.stats?.contextUsage?.tokens === 5000')
  await waitFor(has(conv, '请问今天需要处理什么任务？'))
  check('ACP 思考和普通问句留在消息流，未生成等你决定卡', await ev(`${app}.messages.some(m => m.thinking === '夹具思考') && ![...document.querySelectorAll('[data-testid="v3-decision"]')].some(el => el.textContent.includes('请问今天需要处理什么任务？'))`))
  await ev('window.__yanRightPanel.getState().setOpen(false)')
  await waitFor(has(rail('context'), '25%'))
  await unfold('context')
  await unfold('stats')
  await unfold('usage')
  await unfold('connectors')
  await waitFor(`${has(rail('stats'), '140')} && ${has(rail('connectors'), '砚子代理桥')}`)
  await waitFor(`${has(rail('usage'), '92.5%')} && ${has(rail('usage'), '78%')}`)
  check('右栏展示实报上下文、上下文明细、简洁带进度条订阅用量和同步 MCP', await ev(`${has(rail('stats'), 'tok/s')} && ${has(rail('context'), '25%')} && !!document.querySelector('${rail('context')} [data-testid="wb-ov-ctx-breakdown"]') && !(${has(rail('usage'), '最近已上报回合')}) && !(${has(rail('usage'), '订阅剩余额度')}) && ${has(rail('usage'), 'Claude and GPT models')} && !!document.querySelector('${rail('usage')} .wb-ov-qmini .wb-ctx-bar .wb-ov-qfill') && !!document.querySelector('[data-testid="antigravity-quota-refresh"]') && ${has(rail('changes'), '未上报')} && ${has(rail('connectors'), 'sync-fixture')} && !(${has(rail('connectors'), 'disabled-fixture')}) && !!document.querySelector('[data-testid="wb-rail-env-summary"] .wb-env-dirty')`))
  await ev(`document.querySelector('${rail('usage')}')?.scrollIntoView({ block: 'end' })`)
  await kit.shot('antigravity-reported-metrics', { native: false })
  await ev(`${app}.addAttachments([{ id: 'acp-img-1', kind: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', name: 'shot.png', size: 8 }])`)
  await send('看这张图')
  await settled('收到 1 张图 · image/png · 看这张图')
  check('Antigravity 支持从输入框发送图片并落盘保留', await ev(`${app}.messages.some(m => m.role === 'user' && m.text.includes('看这张图') && m.images?.length === 1 && m.entryId)`))
  await ev(`${app}.send('等待')`)
  await waitFor(has(conv, '正在等待'))
  await ev(`${app}.send('插话改方向', undefined, 'steer')`)
  await waitFor(`${idle} && s.messages.some(m => m.role === 'user' && m.text === '插话改方向' && m.entryId) && s.messages.at(-1)?.role === 'assistant' && s.messages.at(-1)?.text === '模拟回复 · pro' && s.messages.at(-1)?.entryId`)
  check('Antigravity 回复中支持插话，打断当前回合后继续发送', true)
  await send('多步进度')
  await settled('多步进度完成。')
  await waitFor(`[...document.querySelectorAll('[data-testid="v3-process-notes"]')].some(el => el.textContent.includes('正在检查配置文件。'))`, 3000).catch(() => {})
  const multiStepState = await ev(`(() => {
    const notes = [...document.querySelectorAll('[data-testid="v3-process-notes"]')].some(el => el.textContent.includes('正在检查配置文件。'))
    const todos = ${app}.todos
    const hasPlan = Array.isArray(todos) && todos.length === 2 && todos.every(item => item.status === 'done')
    const steps = ${app}.messages.filter(m => m.role === 'assistant' && m.entryId && (m.text.includes('正在检查配置文件。') || m.text.includes('多步进度完成。')))
    return { ok: notes && hasPlan && steps.length === 2, notes, hasPlan, steps: steps.length, todos: todos?.length ?? 0, lastMsgs: ${app}.messages.slice(-4).map(m => ({ role: m.role, text: m.text?.slice(0, 30), tools: m.toolCalls?.length ?? 0, entryId: !!m.entryId })) }
  })()`)
  check('ACP 多步回合展示进度报告、工具分类和 plan 任务进度', multiStepState.ok, multiStepState.ok ? undefined : multiStepState)
  await send('上报文件改动')
  await settled('修改已上报')
  await waitFor('!s.stats?.contextUsage')
  await unfold('changes')
  check('只归属实际 ACP 工具报告的项目内文件，缺失上下文清空', await ev(`${has(rail('context'), '未上报')} && ${has(rail('changes'), 'acp-edited.txt')} && !document.querySelector('${rail('changes')}')?.textContent.includes('existing-untracked.txt') && !document.querySelector('${rail('changes')}')?.textContent.includes('outside.txt')`))
  await kit.shot('antigravity-attributed-changes', { native: false })
  await send('检查同步 MCP')
  await waitFor('s.approvals.some(a => a.detail.includes("MCP 同步回执")) || s.messages.at(-1)?.text.includes("MCP 同步失败")')
  const approval = await ev(`${app}.approvals.find(a => a.detail.includes('MCP 同步回执'))?.id`)
  assert.ok(approval, await ev(`${app}.messages.at(-1)?.text`))
  await ev(`${app}.answerApproval(${JSON.stringify(approval)}, 'once')`)
  await settled('MCP 同步回执')
  check('CLI 能实际调用同步的 MCP，隐藏工具不暴露且调用走宿主审批', true)

  await ev(`${app}.newSession({ cwd: ${JSON.stringify(project)} })`)
  await waitFor(`s.session?.sessionId !== ${JSON.stringify(baseSession)} && s.conn === 'ready'`)
  await choose('antigravity', 'Claude Sonnet')
  check('选中 Claude 时输入框仍显示 Antigravity 图标', await ev(triggerIcon))
  check('第二会话的 Claude 未报告思考档并清除 Pi 档位', await ev(`${app}.session.thinkingLevelsStatus === 'unknown' && !${app}.session.availableThinkingLevels.length`))
  await send('第二会话')
  await settled('模拟回复 · third-party')
  const other = await ev(`(({sessionId, sessionFile}) => ({sessionId, sessionFile}))(${app}.session)`)
  await activate(baseFile, baseSession)
  check('两个会话并存时恢复第一会话的 Gemini Pro 和 Extra', await ev(`${app}.session.model.id === 'pro' && ${app}.session.thinkingLevel === 'xhigh'`))
  await send('权限')
  await waitFor(has(sheet, '仅允许这一次'))
  check('审批中回合归属原会话并显示等待你', await phase(baseSession, 'needs-you'))
  check('原审批卡显示工具详情，不提供永久授权', await cdp.evaluate(has(sheet, 'README.md')) && !(await cdp.evaluate(has(sheet, 'Always allow'))))
  await kit.shot('antigravity-inline-approval', { native: false })
  await click('[data-testid="v3-question-option-1"]')
  await settled('审批结果 · deny')
  await send('权限')
  await waitFor(has(sheet, '仅允许这一次'))
  await click('[data-testid="v3-question-option-0"]')
  await settled('审批结果 · once')
  check('通过原审批卡允许一次后，CLI 收到对应的一次性选项', true)
  await send('派 Pi 子代理')
  await waitFor(`(${has(conv, '收到 Pi 子代理结果')}) || (${has(conv, '派发失败 ·')})`)
  check('Antigravity 经鉴权派 Pi 子代理并收到结论', await cdp.evaluate(has(conv, '收到 Pi 子代理结果')), await cdp.evaluate('window.__yanStore.getState().messages.at(-1)?.text'))
  await settled('收到 Pi 子代理结果')
  await send('等待')
  await waitFor(has(conv, '正在等待'))
  check('开始 ACP 回合即记录运行起点及左栏运行', await phase(baseSession, 'running') && await ev(`Number.isFinite(${app}.session.runStartedAt)`))
  check('ACP 输出中可继续输入插话/排队，输入框仍保留停止按钮', await ev(`!!document.querySelector('[data-testid="composer-input"]')?.dataset.placeholder && !!document.querySelector('.composer-v3 .t3-stop')`))
  await activate(other.sessionFile, other.sessionId)
  check('切到第二会话后左栏仍将后台运行挂在第一会话，第二会话恢复自己的模型', await phase(baseSession, 'running') && await ev(`${app}.session.model.id === 'third-party' && !${app}.session.isAgentRunning`))
  await activate(baseFile, baseSession)
  await waitFor("!!document.querySelector('.composer-v3 .t3-stop')")
  await click('.composer-v3 .t3-stop')
  await waitFor('!s.session?.isAgentRunning && !s.session?.isStreaming && s.messages.some(m => m.turnTiming?.terminalReason === "stopped")')
  check('原输入框的停止按钮取消 ACP 回合并结算侧栏', await phase(baseSession, 'stopped'))
  const retiring = await ev(`${app}.activeRunnerId`)
  await activate(other.sessionFile, other.sessionId)
  assert.equal(await ev(`window.yan.stopRunner(${JSON.stringify(retiring)})`), true)
  await ev('window.__antigravityBeforeReload = true')
  await cdp.call('Page.reload')
  await waitFor('!window.__antigravityBeforeReload && !!s.settings?.cwd && s.conn === "ready"')
  await activate(baseFile, baseSession)
  check('冷恢复保留模型、思考档、原生用量、思考和已停止计时', await ev(`${app}.session.model.id === 'pro' && ${app}.session.thinkingLevel === 'xhigh' &&
    ${app}.messages.filter(m => m.antigravity?.usage?.totalTokens === 140 && m.thinking === '夹具思考' && m.turnTiming?.terminalReason === 'completed').length === 1 &&
    ${app}.messages.some(m => m.turnTiming?.terminalReason === 'stopped')`))
  await waitFor(`(${triggerIcon}) && (${has(picker, 'Gemini Pro')})`)
  check('重新加载后无需打开菜单，输入框直接显示已保存模型的名称和 Antigravity 图标', true)
  await send('检查档位')
  await settled('当前档位 · pro/xhigh')
  check('冷恢复后的下一句将档位重新应用给 CLI', true)
  await send('崩溃')
  await waitFor(`${idle} && s.messages.at(-1)?.error?.includes('断开连接')`)
  check('CLI 断线结算失败并保留已选后端', await phase(baseSession, 'failed') && await ev(`${app}.session.model.provider === 'antigravity'`))
  const loginFixture = join(project, '.acp-fixture-login')
  const piRequests = fake.requests.length
  writeFileSync(loginFixture, 'deny')
  const sent = await ev(`${app}.send('重连失败测试')`)
  await waitFor(`[...document.querySelectorAll('.ui-toast')].some(n => n.textContent.includes('agy acp --login'))`)
  const reconnect = await ev(`(({session, messages}) => ({provider: session.model.provider, appended: messages.some(m => m.text === '重连失败测试')}))(${app})`)
  check('CLI 重连失败提示官方登录，选中模型不回退到 Pi', sent === false && !reconnect.appended &&
    fake.requests.slice(piRequests).every((request) => !request.text?.includes('重连失败测试')) &&
    reconnect.provider === 'antigravity', { sent, ...reconnect })
  writeFileSync(loginFixture, 'allow')
  await choose(mainModel.provider, mainModel.name)
  check('切回 Pi 后输入框已清除 Antigravity 图标', await ev(`!(${triggerIcon})`))
  await send('切回 pi 后接着聊')
  await waitFor('!s.session?.isAgentRunning && s.messages.some(m => m.text === "切回 pi 后接着聊" && m.role === "user")')
  for (let i = 0; i < 30 && !fake.requests.some(r => r.text === '切回 pi 后接着聊'); i++) await sleep(100)
  check('切回 Pi 后原会话可见，Pi 模型请求也收到 Antigravity 历史', baseSession === await cdp.evaluate('window.__yanStore.getState().session?.sessionId') && await cdp.evaluate(has(conv, '上下文收到 · pro')) && fake.requests.some(r => r.text === '切回 pi 后接着聊' && r.priorAcp))
  await send('ACPDELEGATE')
  await waitFor('s.messages.some(m => m.text?.includes("Pi 已派发 Antigravity 子代理"))')
  let child
  for (let i = 0; i < 60; i++) {
    child = await cdp.evaluate(`window.yan.subagents.list().then(runs => runs.find(r => r.model === 'antigravity/pro' && r.task.includes('ACP_CHILD_FIXTURE')))`)
    if (child && !['starting', 'running'].includes(child.status)) break
    await sleep(250)
  }
  check('Pi 用原子代理命令派 Antigravity，归属和结果正确', child?.status === 'done' && child.parentSessionId === baseSession && child.transcript.some(m => m.text === '模拟回复 · pro'), child?.status === 'done' ? undefined : child)
  const switchedRunner = await ev(`${app}.activeRunnerId`)
  await activate(other.sessionFile, other.sessionId)
  assert.equal(await ev(`window.yan.stopRunner(${JSON.stringify(switchedRunner)})`), true)
  await activate(baseFile, baseSession)
  check('显式切回 Pi 后冷恢复仍使用 Pi 后端', await ev(`${app}.session.model.provider === ${JSON.stringify(mainModel.provider)} && !${app}.session.antigravity`))
  await ev(`${app}.newSession({ cwd: ${JSON.stringify(project)} })`)
  await waitFor(`s.session?.sessionId !== ${JSON.stringify(baseSession)} && s.conn === 'ready'`)
  await choose('antigravity', 'Gemini Pro')
  await ev(`${app}.setThinking('xhigh')`)
  await waitFor('s.session?.thinkingLevel === "xhigh"')
  await click(picker)
  await waitFor(has(permission, 'CLI 默认审批'))
  await chooseMode('plan')
  for (let index = 0; index < 3 && await ev(`!!document.querySelector('${menu}')`); index++) await kit.key('Escape')
  await waitFor(`!document.querySelector('${menu}')`)
  const worktree = '[data-testid="composer-worktree"]'
  await waitFor(`!!document.querySelector('${worktree} .ui-switch__track')`)
  assert.ok(await kit.click(`${worktree} .ui-switch__track`))
  await waitFor(`document.querySelector('${worktree}')?.hasAttribute('data-selected')`)
  await send('检查权限档')
  await settled('当前权限档 · plan')
  check('首条消息进入独立工作树时保留 ACP 后端、模型、思考档和权限档', await ev(`${app}.session.cwd !== ${JSON.stringify(project)} &&
    ${app}.session.model.provider === 'antigravity' && ${app}.session.thinkingLevel === 'xhigh' && ${app}.session.antigravity?.mode === 'plan'`))
  await click(picker)
  await waitFor(has(permission, 'Plan'))
  await chooseMode('default')
  for (let index = 0; index < 3 && await ev(`!!document.querySelector('${menu}')`); index++) await kit.key('Escape')
  await waitFor(`!document.querySelector('${menu}')`)

  await send('生成长历史')
  await waitFor(`${idle} && s.messages.some(m => m.text?.startsWith('历史起点') && m.text?.endsWith('历史终点') && m.text.length > 100_000 && m.entryId)`)
  const longSession = await ev(`(({sessionId, sessionFile}) => ({sessionId, sessionFile}))(${app}.session)`)
  const longRunner = await ev(`${app}.activeRunnerId`)
  await activate(baseFile, baseSession)
  assert.equal(await ev(`window.yan.stopRunner(${JSON.stringify(longRunner)})`), true)
  await activate(longSession.sessionFile, longSession.sessionId)
  await click(picker)
  await waitFor(has(permission, 'CLI 默认审批'))
  await chooseMode('plan')
  await waitFor('!document.querySelector(\'[role="option"][data-key="plan"]\')')
  if (await ev(`!!document.querySelector('${menu}')`)) {
    await ev(`document.querySelector('${menu} input').focus()`)
    await kit.key('Escape')
  }
  await waitFor(`!document.querySelector('${menu}')`)
  await send('检查长历史与权限')
  await settled('完整历史收到 · plan')
  check('冷恢复超过旧长度上限的历史，切换 Plan 后仍发送完整历史并继续对话', true)
}
