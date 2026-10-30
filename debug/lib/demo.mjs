import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createDemoRepos, demoFile } from './demo-repos.mjs'
import { seedDemoGh } from './demo-state.mjs'
import { storeHelpers } from './app.mjs'

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} } }

function seedSession(box, cwd, title, index) {
  const id = randomUUID()
  const startedAt = new Date(Date.now() - (index + 1) * 3600000).toISOString()
  const rows = [{ type: 'session', version: 3, id, timestamp: startedAt, cwd }]
  let parentId = null
  const push = row => { const next = randomBytes(4).toString('hex'); rows.push({ ...row, id: next, parentId, timestamp: startedAt }); parentId = next }
  const usage = { input: 12640, output: 2841, cacheRead: 4096, cacheWrite: 0, totalTokens: 19577, cost: { input: 0.003, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0051 } }
  push({ type: 'model_change', provider: 'fake', modelId: 'fake-model' })
  push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: index === 0 ? '复核对账事件，修正文档并准备 PR；保留暂存区，先不要提交。' : `${title}。请给出可复现的检查步骤。` }], timestamp: Date.parse(startedAt) } })
  const assistant = (content, stopReason) => push({ type: 'message', message: { role: 'assistant', api: 'openai-responses', provider: 'fake', model: 'fake-model', content, stopReason, usage, timestamp: Date.parse(startedAt) + 1000 } })
  if (index === 0) {
    assistant([{ type: 'thinking', thinking: '先检查复现记录，再把已确认的更改记录到本会话；所有远端都是 demo 目录内的本地裸仓库。' }, { type: 'toolCall', id: 'demo-edit-staged', name: 'edit', arguments: { path: 'demo/staged.txt', edits: [{ oldText: 'original entry', newText: 'validated entry' }] } }], 'toolUse')
    push({ type: 'message', message: { role: 'toolResult', toolCallId: 'demo-edit-staged', toolName: 'edit', content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in demo/staged.txt.' }], details: { diff: '  1 staged\n- 2 original entry\n+ 2 validated entry', firstChangedLine: 2 }, isError: false, timestamp: Date.parse(startedAt) + 2000 } })
    assistant([{ type: 'toolCall', id: 'demo-edit-partial', name: 'edit', arguments: { path: 'demo/partial.txt', edits: [{ oldText: 'original entry', newText: 'staged correction\nunstaged follow-up' }] } }], 'toolUse')
    push({ type: 'message', message: { role: 'toolResult', toolCallId: 'demo-edit-partial', toolName: 'edit', content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in demo/partial.txt.' }], details: { diff: '  1 partial\n- 2 original entry\n+ 2 staged correction\n+ 3 unstaged follow-up', firstChangedLine: 2 }, isError: false, timestamp: Date.parse(startedAt) + 3000 } })
  }
  assistant([{ type: 'text', text: `## ${title}\n\n${index === 0 ? '已更新两份对账记录，保留了部分暂存状态，尚未提交。' : '检查结论已整理；这是合成演示记录，没有调用模型。'}\n\n- PR #101：检查通过，可试合并\n- PR #102：检查失败，可试失败提示\n- PR #104：草稿，可标记就绪\n- PR #105：冲突，不能直接合并\n- PR #108：多轮评审与行内回复\n- PR #109：36 个文件与长描述\n\n项目可运行 \`npm test\`，\`npm run demo:preview\` 启动本机预览。\n\n[复核报告](demo/artifacts/reconciliation.md)\n\nGit origin 只指向本次 demo 目录，可在这里安全尝试暂存、提交、推送、拉取与新建分支。` }], 'stop')
  push({ type: 'session_info', name: title })
  const bucket = `--${cwd.replace(/[:\\/]/g, '-')}--`
  const file = join(box.sessionsDir, bucket, `${startedAt.replace(/[:.]/g, '-')}_${id}.jsonl`)
  mkdirSync(join(box.sessionsDir, bucket), { recursive: true })
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  return { id, file, title, cwd }
}

export function prepareDemo(box, options = {}) {
  const demo = createDemoRepos(box.runDir, options)
  seedDemoGh(demo)
  const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'"
  const script = join(import.meta.dirname, 'demo-gh.mjs')
  demoFile(demo.dir, 'bin/gh', `#!/usr/bin/env bash\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`)
  chmodSync(join(demo.dir, 'bin/gh'), 0o755)
  demoFile(demo.dir, 'bin/gh.cmd', `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  box.project = demo.project
  box.projects = demo.projects
  demoFile(demo.project, 'demo/artifacts/reconciliation.md', '# Reconciliation report\n\n| Batch | Entries | Missing | Status |\n| --- | ---: | ---: | --- |\n| morning | 128 | 0 | reconciled |\n| refunds | 24 | 1 | needs review |\n\nThe duplicate CSV header case needs a follow-up before rollout.\n')
  demoFile(demo.project, 'demo/artifacts/summary.html', '<!doctype html><meta charset="utf-8"><title>Ledger reconciliation</title><h1>Reconciliation report</h1><p>128 entries · 0 missing · local demo</p><table><tr><th>Region</th><th>Total</th></tr><tr><td>CN</td><td>2176.00</td></tr></table>\n')
  demoFile(demo.project, '.pi/skills/ledger-review/SKILL.md', '---\nname: ledger-review\ndescription: Review the local demo ledger and reconciliation fixture\n---\n\nRun npm test, compare balances and review changes before creating a PR. Use only this project\'s local origin; never add a network remote.\n')
  const sessions = [
    seedSession(box, demo.project, '对账事件复核与 PR 准备', 0),
    seedSession(box, demo.project, 'CSV 导入边界条件排查', 1),
    seedSession(box, demo.project, '批量导出评审与回归清单', 2),
    seedSession(box, demo.second, '异步队列取消与重试重构', 3)
  ]
  const desktopPath = join(box.dataDir, 'desktop.json')
  const desktop = readJson(desktopPath)
  writeFileSync(desktopPath, JSON.stringify({ ...desktop, cwd: demo.project, recentCwds: demo.projects, remoteAccess: { enabled: false }, lastMainModel: existsSync(join(box.piDir, 'settings.json')) ? 'fake/fake-model' : undefined }, null, 2))
  const titlesPath = join(box.dataDir, 'manual-titles.json')
  const titles = readJson(titlesPath)
  for (const session of sessions) titles[session.file] = session.title
  writeFileSync(titlesPath, JSON.stringify(titles, null, 2))
  const coverage = [
    { feature: '项目与会话侧栏', seeded: true, detail: '2 个 fixture 项目、4 条持久化会话；导入后默认 cwd/recentCwds 只使用演示项目' },
    { feature: 'Git 分支、暂存、提交、推送、拉取', seeded: true, detail: '29 个提交、本地 origin、ahead/behind、占用 worktree、无上游分支、七类工作区状态' },
    { feature: 'PR 列表与操作', seeded: true, detail: '9 个 PR；全部读写持久化到 gh-state.json；merge 修改本地 origin' },
    { feature: '改动卡与会话更改', seeded: true, detail: '持久化的 edit 工具调用与 diff 结果；工作区有对应实际改动' },
    { feature: '成果/产物', seeded: true, detail: 'demo/artifacts 下 Markdown 与 HTML、会话文件链接；未伪造未知格式的成果索引' },
    { feature: '项目脚本', seeded: false, detail: '提供 fixture npm 脚本和 demo:preview（仅监听 127.0.0.1:4179）；未写入应用自定义项目脚本索引，指定来源未提供其格式' },
    { feature: '终端与浏览器', seeded: false, detail: '运行时创建，不伪造活进程；可在终端运行 npm run demo:preview 后浏览 localhost:4179' },
    { feature: '技能', seeded: true, detail: '项目 .pi/skills/ledger-review/SKILL.md' },
    { feature: '归档/贪睡', seeded: true, detail: '启动后通过实例 API 将一条示例会话归档、一条贪睡到明天' },
    { feature: '用量', seeded: true, detail: '四条会话附带合成 token/cost；实际界面已显示用量汇总，不代表真实计费' },
    ...['子代理记录', '后台任务', '定时任务', 'MCP 与连接器', '服务商额度', '通知'].map(feature => ({ feature, seeded: false, detail: '指定来源内未提供可确认的持久化格式/创建 API；不写猜测字段、不伪装登录、连接或运行状态；--user-data 的白名单文件仍按原逻辑导入（若有）' }))
  ]
  writeFileSync(join(demo.dir, 'coverage.json'), JSON.stringify(coverage, null, 2))
  box.demo = { ...demo, sessions, coverage }
  return box.demo
}

export async function initializeDemo(cdp, box) {
  const { until } = storeHelpers(cdp)
  if (!await until(`s.sessions.some(x=>x.id===${JSON.stringify(box.demo.sessions[0].id)})`, 30000)) throw new Error('演示会话未被实例加载')
  const [active, snoozed, archived] = box.demo.sessions
  const result = await cdp.evaluate(`(async()=>{
    const s=window.__yanStore.getState();
    const archived=await window.yan.setSessionArchived(${JSON.stringify(archived.id)},true);
    const snoozed=await window.yan.setSessionSnoozed(${JSON.stringify(snoozed.id)},Date.now()+86400000);
    await s.refreshSessions();
    await s.switchSession(${JSON.stringify(active.file)});
    return {archived,snoozed};
  })()`)
  if (!result.archived?.ok || !result.snoozed?.ok) throw new Error('演示会话布局初始化失败')
}

export function demoEnv(box) {
  if (!box.demo) return {}
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH'
  return { GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', YAN_DEBUG_GH_SCRIPT: join(import.meta.dirname, 'demo-gh.mjs'), YAN_DEBUG_GH_STATE: box.demo.stateFile, ...(process.env.YAN_DEBUG_GH_FAILURE ? { YAN_DEBUG_GH_FAILURE: process.env.YAN_DEBUG_GH_FAILURE } : {}), [pathKey]: join(box.demo.dir, 'bin') + delimiter + (process.env[pathKey] || '') }
}
